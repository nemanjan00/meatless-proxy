import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'
import {
  ConflictError,
  DeniedError,
  NotFoundError,
  ValidationError,
  silentLogger,
  systemClock,
  type Clock,
  type Logger,
} from '@mp/core'
import {
  LOCAL_DEFAULT_BRANCH,
  assertRepoSlug,
  isLocalRepoUrl,
  isValidBranchName,
  localRepoUrl,
  type Author,
  type LocalBranch,
  type LocalCommit,
  type LocalRepos,
  type LocalTreeEntry,
} from '@mp/git'
import { GitError, gitRunner, withAuth } from './exec.ts'

export interface GitCliLocalReposOptions {
  /** Where the repositories are: `<root>/<slug>.git` (`LOCAL_REPOS_DIR`). */
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

/** The largest diff `compare` returns by default. */
const MAX_DIFF_BYTES = 400_000
/** The most commits `compare` lists. */
const MAX_COMMITS = 200
/** The largest file `readFile` returns by default. */
const MAX_FILE_BYTES = 1_000_000

/** Git's words for "these credentials may not push there". */
const ACCESS_DENIED =
  /permission denied|could not read from remote repository|access denied|repository not found|not found or you don't have permission|authentication failed|could not read username|403|401/i

const FIELD = '\x1f'
const RECORD = '\x1e'

/** A path inside a repository: relative, no `..`, no leading `-`. `''` is the root. */
function repoPath(p: string | undefined): string {
  const raw = (p ?? '').replace(/\\/g, '/').trim()
  if (!raw || raw === '/' || raw === '.') return ''
  const norm = posix.normalize(raw.replace(/^\/+/, '')).replace(/\/+$/, '')
  if (norm === '.' || norm === '') return ''
  if (norm === '..' || norm.startsWith('../') || norm.split('/').some((s) => s === '..' || s.startsWith('-')))
    throw new ValidationError(`not a path in the repository: ${p}`)
  return norm
}

/**
 * `LocalRepos` on the git CLI: bare repositories at `<root>/<slug>.git`. Merges run in the bare
 * repository (`git merge-tree --write-tree`, git 2.38 or newer) and move the default branch with a
 * compare-and-swap `update-ref`, so a concurrent push can't be lost. Every write to one repository
 * runs one at a time.
 */
export function gitCliLocalRepos(opts: GitCliLocalReposOptions): LocalRepos {
  const root = resolve(opts.root)
  const log = opts.logger ?? silentLogger
  const clock = opts.clock ?? systemClock
  const git = gitRunner({
    git: opts.git ?? 'git',
    env: { ...(opts.env ?? process.env), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
  })

  const locks = new Map<string, Promise<unknown>>()
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

  const pathOf = (slug: string) => join(root, `${assertRepoSlug(slug)}.git`)

  /** Runs `fn` alone on one repository. A bad slug rejects (never throws synchronously). */
  function onRepo<T>(slug: string, fn: (path: string) => Promise<T>): Promise<T> {
    let path: string
    try {
      path = pathOf(slug)
    } catch (e) {
      return Promise.reject(e)
    }
    return locked(path, () => fn(path))
  }

  async function exists(slug: string) {
    try {
      await stat(join(pathOf(slug), 'HEAD'))
      return true
    } catch (e) {
      if (e instanceof ValidationError) throw e
      return false
    }
  }

  /** The repository's git dir, or `NotFoundError`. */
  async function repo(slug: string): Promise<string> {
    if (!(await exists(slug))) throw new NotFoundError('local repository', slug)
    return pathOf(slug)
  }

  const g = (dir: string, args: string[], o: { env?: Record<string, string>; allowFail?: boolean } = {}) =>
    git(['--git-dir', dir, ...args], o)

  async function revParse(dir: string, ref: string): Promise<string | null> {
    const r = await g(dir, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { allowFail: true })
    return r.code === 0 ? r.stdout.trim() : null
  }

  async function defaultBranchOf(dir: string): Promise<string> {
    const r = await g(dir, ['symbolic-ref', '--short', 'HEAD'], { allowFail: true })
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : LOCAL_DEFAULT_BRANCH
  }

  function checkBranch(branch: string): string {
    const name = String(branch ?? '').replace(/^refs\/heads\//, '')
    if (!isValidBranchName(name)) throw new ValidationError(`not a valid branch name: ${JSON.stringify(branch)}`)
    return name
  }

  async function requireBranch(dir: string, branch: string): Promise<string> {
    const sha = await revParse(dir, `refs/heads/${branch}`)
    if (!sha) throw new NotFoundError('branch', branch)
    return sha
  }

  async function counts(dir: string, base: string, head: string): Promise<{ ahead: number; behind: number }> {
    const { stdout } = await g(dir, ['rev-list', '--left-right', '--count', `${base}...${head}`])
    const [behind, ahead] = stdout.trim().split(/\s+/).map(Number) as [number, number]
    return { ahead: ahead || 0, behind: behind || 0 }
  }

  async function isAncestor(dir: string, a: string, b: string): Promise<boolean> {
    return (await g(dir, ['merge-base', '--is-ancestor', a, b], { allowFail: true })).code === 0
  }

  const commitEnv = (author: Author) => {
    const bad = [author.name, author.email].some((s) => !s?.trim() || /[<>\n\r\0]/.test(s))
    if (bad) throw new ValidationError('author name and email must be non-empty, without <, > or newlines')
    const date = `${Math.floor(clock.now() / 1000)} +0000`
    return {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_COMMITTER_DATE: date,
    }
  }

  const parseCommits = (stdout: string): LocalCommit[] =>
    stdout
      .split(RECORD)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [sha, subject, author, date] = l.split(FIELD) as [string, string, string, string]
        return { sha, subject, author, date }
      })

  /** Resolves a ref for reading: a branch, else any commit-ish. */
  async function readRef(dir: string, ref: string | undefined): Promise<{ ref: string; sha: string }> {
    const name = ref ?? (await defaultBranchOf(dir))
    if (!name.trim() || name.startsWith('-')) throw new ValidationError(`bad ref: ${name}`)
    const sha = (await revParse(dir, `refs/heads/${name}`)) ?? (isValidBranchName(name) ? await revParse(dir, name) : null)
    if (!sha) throw new NotFoundError('ref', name)
    return { ref: name, sha }
  }

  const repos: LocalRepos = {
    root,
    pathOf,
    exists,

    create(slug, o) {
      return onRepo(slug, async (path) => {
        if (await exists(slug)) throw new ConflictError(`a local repository named ${slug} already exists`)
        const env = commitEnv(o.author)
        await mkdir(root, { recursive: true })
        const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`
        try {
          await git(['init', '--bare', '--quiet', `--initial-branch=${LOCAL_DEFAULT_BRANCH}`, tmp])
          // Repository content is untrusted: never run its hooks, never let history be rewritten by a push.
          await g(tmp, ['config', 'core.hooksPath', '/dev/null'])
          await g(tmp, ['config', 'receive.denyNonFastForwards', 'true'])
          await g(tmp, ['config', 'receive.denyDeletes', 'true'])
          const tree = (await g(tmp, ['hash-object', '-t', 'tree', '-w', '/dev/null'])).stdout.trim()
          const head = (await g(tmp, ['commit-tree', tree, '-m', o.message?.trim() || 'Initial commit'], { env })).stdout.trim()
          await g(tmp, ['update-ref', `refs/heads/${LOCAL_DEFAULT_BRANCH}`, head, ''])
          await rename(tmp, path)
          log.info('local repository created', { slug })
          return { slug, url: localRepoUrl(slug), defaultBranch: LOCAL_DEFAULT_BRANCH, head }
        } catch (e) {
          await rm(tmp, { recursive: true, force: true })
          throw e
        }
      })
    },

    remove(slug) {
      return onRepo(slug, async (path) => {
        await rm(path, { recursive: true, force: true })
      })
    },

    async defaultBranch(slug) {
      return defaultBranchOf(await repo(slug))
    },

    async branches(slug) {
      const dir = await repo(slug)
      const base = await defaultBranchOf(dir)
      const baseSha = await revParse(dir, `refs/heads/${base}`)
      const { stdout } = await g(dir, [
        'for-each-ref',
        '--sort=-committerdate',
        `--format=%(refname:short)${FIELD}%(objectname)${FIELD}%(subject)${FIELD}%(authorname) <%(authoremail:trim)>${FIELD}%(committerdate:iso-strict)${RECORD}`,
        'refs/heads/',
      ])
      const out: LocalBranch[] = []
      for (const line of stdout.split(RECORD).map((l) => l.trim())) {
        if (!line) continue
        const [name, sha, subject, author, date] = line.split(FIELD) as [string, string, string, string, string]
        if (name === base) continue
        const c = baseSha ? await counts(dir, baseSha, sha) : { ahead: 0, behind: 0 }
        out.push({ name, sha, subject, author, date, ...c })
      }
      return out
    },

    async compare(slug, branch, o = {}) {
      const dir = await repo(slug)
      const name = checkBranch(branch)
      const base = await defaultBranchOf(dir)
      const baseSha = await requireBranch(dir, base)
      const sha = await requireBranch(dir, name)
      const { ahead, behind } = await counts(dir, baseSha, sha)
      const log = await g(dir, [
        'log',
        '-n',
        String(MAX_COMMITS),
        `--format=%H${FIELD}%s${FIELD}%an <%ae>${FIELD}%cI${RECORD}`,
        `${baseSha}..${sha}`,
      ])
      const nameStatus = await g(dir, ['diff', '--name-status', '-z', '--no-renames', `${baseSha}...${sha}`])
      const parts = nameStatus.stdout.split('\0').filter((p) => p !== '')
      const files: { status: string; path: string }[] = []
      for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i]!, path: parts[i + 1]! })
      const max = o.maxDiffBytes ?? MAX_DIFF_BYTES
      const full = (await g(dir, ['diff', '--no-color', '--no-ext-diff', '--no-renames', `${baseSha}...${sha}`])).stdout
      const truncated = Buffer.byteLength(full) > max
      return {
        branch: name,
        base,
        ahead,
        behind,
        commits: parseCommits(log.stdout),
        files,
        diff: truncated ? Buffer.from(full).subarray(0, max).toString('utf8') : full,
        truncated,
        fastForward: await isAncestor(dir, baseSha, sha),
      }
    },

    merge(slug, branch, o) {
      return onRepo(slug, async () => {
        const name = checkBranch(branch)
        const dir = await repo(slug)
        const env = commitEnv(o.author)
        const base = await defaultBranchOf(dir)
        if (name === base) throw new ValidationError(`${name} is the default branch`)
        const baseSha = await requireBranch(dir, base)
        const sha = await requireBranch(dir, name)
        if (await isAncestor(dir, sha, baseSha)) throw new ValidationError(`${name} has nothing to merge: ${base} already has it`)
        if (await isAncestor(dir, baseSha, sha)) {
          // Compare-and-swap: fails if the default branch moved since it was read.
          await g(dir, ['update-ref', '-m', `merge ${name}: fast-forward`, `refs/heads/${base}`, sha, baseSha])
          log.info('local branch merged', { slug, branch: name, mode: 'fast-forward', sha })
          return { branch: name, into: base, sha, mode: 'fast-forward' as const }
        }
        const mt = await g(dir, ['merge-tree', '--write-tree', '--name-only', '--no-messages', baseSha, sha], { allowFail: true })
        if (mt.code === 1) {
          const [, ...conflicted] = mt.stdout.split('\n').map((l) => l.trim())
          const files = [...new Set(conflicted.filter(Boolean))]
          throw new ConflictError(
            `${name} can't be merged into ${base} automatically: ${files.length} file${files.length === 1 ? '' : 's'} conflict (${files.slice(0, 10).join(', ')}${files.length > 10 ? ', …' : ''}). Nothing was changed. Resolve the conflicts on the branch (merge or rebase ${base} into it), push it, and merge again.`,
            { files, branch: name, base },
          )
        }
        if (mt.code !== 0)
          throw new GitError(`git merge-tree failed: ${mt.stderr.trim()}`, {
            args: ['merge-tree'],
            exitCode: mt.code,
            stderr: mt.stderr,
          })
        const tree = mt.stdout.split('\n')[0]!.trim()
        const message = o.message?.trim() || `Merge branch '${name}' into ${base}`
        const merged = (await g(dir, ['commit-tree', tree, '-p', baseSha, '-p', sha, '-m', message], { env })).stdout.trim()
        await g(dir, ['update-ref', '-m', `merge ${name}`, `refs/heads/${base}`, merged, baseSha])
        log.info('local branch merged', { slug, branch: name, mode: 'merge-commit', sha: merged })
        return { branch: name, into: base, sha: merged, mode: 'merge-commit' as const }
      })
    },

    deleteBranch(slug, branch) {
      return onRepo(slug, async () => {
        const name = checkBranch(branch)
        const dir = await repo(slug)
        const base = await defaultBranchOf(dir)
        if (name === base) throw new ValidationError(`${name} is the default branch: it can't be deleted`)
        const sha = await requireBranch(dir, name)
        await g(dir, ['update-ref', '-d', `refs/heads/${name}`, sha])
        log.info('local branch deleted', { slug, branch: name, sha })
      })
    },

    async tree(slug, o = {}) {
      const dir = await repo(slug)
      const { ref, sha } = await readRef(dir, o.ref)
      const path = repoPath(o.path)
      const target = path ? `${sha}:${path}` : `${sha}^{tree}`
      const type = await g(dir, ['cat-file', '-t', target], { allowFail: true })
      if (type.code !== 0) throw new NotFoundError('path', path || '/')
      if (type.stdout.trim() !== 'tree') throw new ValidationError(`${path} is a file`)
      const { stdout } = await g(dir, ['ls-tree', '-z', '-l', target])
      const entries: LocalTreeEntry[] = stdout
        .split('\0')
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf('\t')
          const [, kind, , size] = line.slice(0, tab).split(/\s+/)
          const name = line.slice(tab + 1)
          return kind === 'tree'
            ? { name, type: 'dir' as const }
            : { name, type: 'file' as const, ...(size && size !== '-' ? { size: Number(size) } : {}) }
        })
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      return { path, ref, entries }
    },

    async readFile(slug, o) {
      const dir = await repo(slug)
      const { ref, sha } = await readRef(dir, o.ref)
      const path = repoPath(o.path)
      if (!path) throw new ValidationError('path is the repository root')
      const target = `${sha}:${path}`
      const type = await g(dir, ['cat-file', '-t', target], { allowFail: true })
      if (type.code !== 0) throw new NotFoundError('file', path)
      if (type.stdout.trim() !== 'blob') throw new ValidationError(`${path} is a directory`)
      const size = Number((await g(dir, ['cat-file', '-s', target])).stdout.trim())
      const max = o.maxBytes ?? MAX_FILE_BYTES
      if (size > max) return { path, ref, size, binary: false, tooLarge: true, content: null }
      const content = (await g(dir, ['cat-file', 'blob', target])).stdout
      const binary = content.slice(0, 8000).includes('\0')
      return { path, ref, size, binary, tooLarge: false, content: binary ? null : content }
    },

    pushAll(slug, remoteUrl, auth) {
      const url = String(remoteUrl ?? '').trim()
      if (!url || url.startsWith('-') || /\s/.test(url) || isLocalRepoUrl(url))
        return Promise.reject(new ValidationError(`not a remote repository url: ${remoteUrl}`))
      return onRepo(slug, async () => {
        const dir = await repo(slug)
        try {
          await withAuth(auth, (env) =>
            g(dir, ['push', '--porcelain', '--no-verify', '--', url, 'refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*'], {
              env,
            }),
          )
        } catch (e) {
          if (!(e instanceof GitError)) throw e
          const text = `${e.message}\n${String((e.details as { stderr?: string } | undefined)?.stderr ?? '')}`
          if (/rejected|non-fast-forward|fetch first|already exists/i.test(text))
            throw new ConflictError(
              `the remote already has other history, so the branches were not pushed: attach a new, empty repository (${e.message})`,
            )
          if (ACCESS_DENIED.test(text))
            throw new DeniedError(
              `the remote refused these credentials: give the account (or its SSH key) write access to the repository, then try again (${e.message})`,
            )
          throw e
        }
        const { stdout } = await g(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
        const branches = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
        log.info('local repository pushed to a remote', { slug, branches: branches.length })
        return { branches }
      })
    },
  }
  return repos
}
