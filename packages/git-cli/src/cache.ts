import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  ConflictError,
  MpError,
  NotFoundError,
  UnavailableError,
  ValidationError,
  silentLogger,
  systemClock,
  type Clock,
  type Logger,
} from '@mp/core'
import { assertPushAllowed, isValidBranchName, mirrorKey, type GitAuth, type GitCache, type WorktreeInfo } from '@mp/git'

export interface GitCliOptions {
  /** Cache root. Mirrors live at `<root>/<host>/<path>`. */
  root: string
  /** The git binary. Default `git`. */
  git?: string
  /** Environment for git processes. Default: the harness's own environment. */
  env?: Record<string, string | undefined>
  logger?: Logger
  /** Used for commit dates. */
  clock?: Clock
  /** Kills a git command that runs longer than this. Default 10 minutes. */
  timeoutMs?: number
}

/** A git command failed. `details` has the exit code and stderr (credentials in URLs are masked). */
export class GitError extends MpError {
  constructor(message: string, details: { args: string[]; exitCode: number | null; stderr: string }) {
    super('git', message, details)
  }
}

/** Remote-tracking layout: remote branches under `refs/remotes/origin/*`, session branches are local `refs/heads/*`. */
const FETCH_REFSPECS = ['+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*']

/** Always on: no hooks (repo content is untrusted), no signing prompts, no command-running transports. */
const BASE_CONFIG = ['core.hooksPath=/dev/null', 'commit.gpgSign=false', 'tag.gpgSign=false', 'protocol.ext.allow=never']

const TRAILER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/

const maskUrl = (s: string) => s.replace(/(\w+:\/\/)[^/@\s]+@/g, '$1***@')

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * Runs `fn` with the environment that makes git use `auth` for SSH: the key (and known hosts)
 * in a private temp dir, `GIT_SSH_COMMAND` pointing at them. The files are removed afterwards,
 * whatever happens. Without `auth`, `fn` gets no extra environment.
 */
async function withAuth<T>(auth: GitAuth | undefined, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  if (!auth) return fn({})
  const dir = await mkdtemp(join(tmpdir(), 'mp-git-ssh-')) // mode 0700
  try {
    const args = ['ssh']
    if (auth.sshPrivateKey) {
      const key = join(dir, 'id')
      const text = auth.sshPrivateKey.endsWith('\n') ? auth.sshPrivateKey : `${auth.sshPrivateKey}\n`
      await writeFile(key, text, { mode: 0o600 })
      args.push('-i', shellQuote(key), '-o', 'IdentitiesOnly=yes')
    }
    let knownHosts = '/dev/null'
    if (auth.knownHosts) {
      knownHosts = join(dir, 'known_hosts')
      await writeFile(knownHosts, auth.knownHosts.endsWith('\n') ? auth.knownHosts : `${auth.knownHosts}\n`, { mode: 0o600 })
    }
    args.push(
      '-o',
      `UserKnownHostsFile=${shellQuote(knownHosts)}`,
      '-o',
      `StrictHostKeyChecking=${auth.strictHostKeyChecking ? 'yes' : 'accept-new'}`,
      '-o',
      'BatchMode=yes',
    )
    return await fn({ GIT_SSH_COMMAND: args.join(' ') })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * `GitCache` on the git CLI. Each remote gets one bare cache repository (the "mirror"),
 * and sessions get worktrees of it. Every operation on one mirror, including those on its
 * worktrees, runs one at a time.
 */
export function gitCliCache(opts: GitCliOptions): GitCache {
  const root = resolve(opts.root)
  const gitBin = opts.git ?? 'git'
  const log = opts.logger ?? silentLogger
  const clock = opts.clock ?? systemClock
  const timeout = opts.timeoutMs ?? 10 * 60_000
  const baseEnv = { ...(opts.env ?? process.env), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }

  const locks = new Map<string, Promise<unknown>>()
  const commonDirs = new Map<string, string>()

  /** Runs `fn` after every earlier operation on the same key finished. */
  function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => {})
    locks.set(key, tail)
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key)
    })
    return run
  }

  function git(
    args: string[],
    o: { cwd?: string; env?: Record<string, string>; allowFail?: boolean } = {},
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const full = [...BASE_CONFIG.flatMap((c) => ['-c', c]), ...args]
    return new Promise((res, rej) => {
      execFile(
        gitBin,
        full,
        { cwd: o.cwd, env: { ...baseEnv, ...o.env }, maxBuffer: 256 * 1024 * 1024, timeout, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (!err) return res({ stdout, stderr, code: 0 })
          const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean }
          if (e.code === 'ENOENT') return rej(new UnavailableError(`git binary not found: ${gitBin}`))
          const code = typeof e.code === 'number' ? e.code : null
          if (o.allowFail && code !== null) return res({ stdout, stderr, code })
          const safeArgs = args.map(maskUrl)
          const msg = e.killed
            ? `git ${args[0]} timed out`
            : `git ${safeArgs.join(' ')} failed: ${maskUrl(stderr.trim()) || e.message}`
          rej(new GitError(msg, { args: safeArgs, exitCode: code, stderr: maskUrl(stderr) }))
        },
      )
    })
  }

  const mirrorPath = (url: string) => join(root, mirrorKey(url))

  async function exists(p: string) {
    try {
      await stat(p)
      return true
    } catch {
      return false
    }
  }

  async function ensureMirrorUnlocked(url: string, auth?: GitAuth): Promise<string> {
    const path = mirrorPath(url)
    if (await exists(join(path, 'HEAD'))) return path
    if (url.startsWith('-')) throw new ValidationError(`not a repository url: ${url}`)
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`
    try {
      await git(['init', '--bare', '--quiet', tmp])
      await git(['--git-dir', tmp, 'config', 'remote.origin.url', url])
      for (const spec of FETCH_REFSPECS) await git(['--git-dir', tmp, 'config', '--add', 'remote.origin.fetch', spec])
      await git(['--git-dir', tmp, 'config', 'gc.worktreePruneExpire', 'now'])
      await withAuth(auth, async (env) => {
        await git(['--git-dir', tmp, 'fetch', '--prune', '--quiet', 'origin'], { env })
        await git(['--git-dir', tmp, 'remote', 'set-head', 'origin', '--auto'], { env, allowFail: true })
      })
      await rename(tmp, path)
    } catch (e) {
      await rm(tmp, { recursive: true, force: true })
      throw e
    }
    log.info('git mirror created', { mirror: path })
    return path
  }

  /** The mirror a worktree belongs to. */
  async function commonDir(path: string): Promise<string> {
    const cached = commonDirs.get(path)
    if (cached) return cached
    if (!isAbsolute(path) || !(await exists(path))) throw new NotFoundError('worktree', path)
    const { stdout } = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: path }).catch(() => {
      throw new NotFoundError('worktree', path)
    })
    const dir = stdout.trim()
    commonDirs.set(path, dir)
    return dir
  }

  async function onWorktree<T>(path: string, fn: (mirror: string) => Promise<T>): Promise<T> {
    const mirror = await commonDir(path)
    return locked(mirror, () => fn(mirror))
  }

  async function revParse(gitDir: string, ref: string): Promise<string | null> {
    const r = await git(['--git-dir', gitDir, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], {
      allowFail: true,
    })
    return r.code === 0 ? r.stdout.trim() : null
  }

  /** Local branch first (a session's own work), then the remote's branch, then any rev (sha, tag). */
  async function resolveRef(gitDir: string, ref: string | undefined): Promise<string> {
    const candidates =
      ref === undefined
        ? ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master']
        : [`refs/heads/${ref}`, `refs/remotes/origin/${ref}`, ref]
    if (ref !== undefined && (ref.startsWith('-') || !ref.trim())) throw new ValidationError(`bad ref: ${ref}`)
    for (const c of candidates) {
      const sha = await revParse(gitDir, c)
      if (sha) return sha
    }
    throw new NotFoundError('ref', ref ?? 'default branch')
  }

  const cache: GitCache = {
    mirrorPath,

    ensureMirror(url, auth) {
      return locked(mirrorPath(url), () => ensureMirrorUnlocked(url, auth))
    },

    fetch(url, auth) {
      return locked(mirrorPath(url), async () => {
        const m = await ensureMirrorUnlocked(url, auth)
        await withAuth(auth, async (env) => {
          await git(['--git-dir', m, 'remote', 'update', '--prune'], { env })
          await git(['--git-dir', m, 'remote', 'set-head', 'origin', '--auto'], { env, allowFail: true })
        })
      })
    },

    createWorktree(url, o) {
      if (!isAbsolute(o.path)) return Promise.reject(new ValidationError(`worktree path must be absolute: ${o.path}`))
      if (o.newBranch !== undefined && !isValidBranchName(o.newBranch)) {
        return Promise.reject(new ValidationError(`not a valid branch name: ${o.newBranch}`))
      }
      return locked(mirrorPath(url), async () => {
        const m = await ensureMirrorUnlocked(url, o.auth)
        const sha = await resolveRef(m, o.ref)
        if (o.newBranch !== undefined && (await revParse(m, `refs/heads/${o.newBranch}`))) {
          throw new ConflictError(`branch ${o.newBranch} already exists`)
        }
        await mkdir(dirname(o.path), { recursive: true })
        const args = o.newBranch !== undefined ? ['-b', o.newBranch, '--no-track'] : ['--detach']
        try {
          await git(['--git-dir', m, 'worktree', 'add', '--quiet', ...args, '--', o.path, sha])
        } catch (e) {
          if (e instanceof GitError && /already exists|already checked out|is a missing but/.test(e.message)) {
            throw new ConflictError(`worktree ${o.path}: ${e.message}`)
          }
          throw e
        }
        const head = (await git(['rev-parse', 'HEAD'], { cwd: o.path })).stdout.trim()
        commonDirs.set(o.path, m)
        log.info('worktree created', { mirror: m, path: o.path, branch: o.newBranch ?? null })
        const info: WorktreeInfo = { path: o.path, branch: o.newBranch ?? null, head }
        return info
      })
    },

    removeWorktree(url, path) {
      return locked(mirrorPath(url), async () => {
        const m = mirrorPath(url)
        commonDirs.delete(path)
        if (!(await exists(join(m, 'HEAD')))) return
        const r = await git(['--git-dir', m, 'worktree', 'remove', '--force', '--', path], { allowFail: true })
        if (r.code !== 0 && !/is not a working tree|does not exist|No such file/i.test(r.stderr)) {
          throw new GitError(`git worktree remove failed: ${r.stderr.trim()}`, {
            args: ['worktree', 'remove'],
            exitCode: r.code,
            stderr: r.stderr,
          })
        }
        await git(['--git-dir', m, 'worktree', 'prune'])
      })
    },

    async commitAll(path, o) {
      if (!o.message.trim()) throw new ValidationError('commit message is empty')
      const bad = [o.author.name, o.author.email].some((s) => !s.trim() || /[<>\n\r\0]/.test(s))
      if (bad) throw new ValidationError('author name and email must be non-empty, without <, > or newlines')
      const trailers = Object.entries(o.trailers ?? {})
      for (const [k, v] of trailers) {
        if (!TRAILER_KEY_RE.test(k) || /[\n\r\0]/.test(v)) throw new ValidationError(`bad trailer: ${k}`)
      }
      return onWorktree(path, async () => {
        await git(['add', '-A'], { cwd: path })
        const staged = await git(['diff', '--cached', '--quiet'], { cwd: path, allowFail: true })
        if (staged.code === 0) return null
        const message = trailers.length
          ? `${o.message.trimEnd()}\n\n${trailers.map(([k, v]) => `${k}: ${v}`).join('\n')}\n`
          : o.message
        const date = `${Math.floor(clock.now() / 1000)} +0000`
        const env = {
          GIT_AUTHOR_NAME: o.author.name,
          GIT_AUTHOR_EMAIL: o.author.email,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_NAME: o.author.name,
          GIT_COMMITTER_EMAIL: o.author.email,
          GIT_COMMITTER_DATE: date,
        }
        await git(
          [
            '-c',
            `user.name=${o.author.name}`,
            '-c',
            `user.email=${o.author.email}`,
            'commit',
            '--quiet',
            '--no-verify',
            '--cleanup=whitespace',
            '-m',
            message,
          ],
          { cwd: path, env },
        )
        return (await git(['rev-parse', 'HEAD'], { cwd: path })).stdout.trim()
      })
    },

    async push(path, branch, policy, auth) {
      // The hard rule comes first, before git is even asked anything.
      assertPushAllowed(branch, policy)
      const name = branch.replace(/^refs\/heads\//, '')
      await onWorktree(path, async (m) => {
        const sha = await revParse(m, `refs/heads/${name}`)
        if (!sha) throw new NotFoundError('branch', name)
        const url = (await git(['--git-dir', m, 'config', '--get', 'remote.origin.url'])).stdout.trim()
        if (!url || url.startsWith('-')) throw new ValidationError('mirror has no usable origin url')
        try {
          await withAuth(auth, (env) =>
            git(['push', '--porcelain', '--no-verify', '--', url, `refs/heads/${name}:refs/heads/${name}`], { cwd: path, env }),
          )
        } catch (e) {
          if (e instanceof GitError && /rejected|non-fast-forward|fetch first/.test(e.message + String(e.details?.stderr))) {
            throw new ConflictError(`push to ${name} rejected: ${e.message}`)
          }
          throw e
        }
        await git(['--git-dir', m, 'update-ref', `refs/remotes/origin/${name}`, sha])
        log.info('pushed', { mirror: m, branch: name, sha })
      })
    },

    diff(path, base) {
      return onWorktree(path, async (m) => {
        // Stage everything into a throwaway index, so new and deleted files show without touching the real one.
        const tmp = await mkdtemp(join(tmpdir(), 'mp-git-index-'))
        try {
          const index = join(tmp, 'index')
          const real = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd: path })).stdout.trim()
          if (await exists(real)) await copyFile(real, index)
          const env = { GIT_INDEX_FILE: index }
          await git(['add', '-A'], { cwd: path, env })
          const args = base === undefined ? ['HEAD'] : ['--merge-base', await resolveRef(m, base)]
          return (await git(['diff', '--cached', '--no-color', '--no-ext-diff', ...args], { cwd: path, env })).stdout
        } finally {
          await rm(tmp, { recursive: true, force: true })
        }
      })
    },

    log(path, limit = 20) {
      return onWorktree(path, async () => {
        const n = Math.max(1, Math.floor(limit))
        const { stdout } = await git(['log', '-n', String(n), '--format=%H%x1f%s%x1f%an <%ae>%x1e'], { cwd: path })
        return stdout
          .split('\x1e')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [sha, subject, author] = l.split('\x1f') as [string, string, string]
            return { sha, subject, author }
          })
      })
    },

    status(path) {
      return onWorktree(path, async () => {
        const { stdout } = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: path })
        const parts = stdout.split('\0')
        const files: string[] = []
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i]!
          if (p.length < 4) continue
          files.push(p.slice(3))
          if (p[0] === 'R' || p[0] === 'C') i++ // the next part is the rename's source
        }
        return { clean: files.length === 0, files: files.sort() }
      })
    },
  }
  return cache
}
