import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MpError, UnavailableError } from '@mp/core'
import type { GitAuth } from '@mp/git'

/** A git command failed. `details` has the exit code and stderr (credentials in URLs are masked). */
export class GitError extends MpError {
  constructor(message: string, details: { args: string[]; exitCode: number | null; stderr: string }) {
    super('git', message, details)
  }
}

/** Always on: no hooks (repo content is untrusted), no signing prompts, no command-running transports. */
export const BASE_CONFIG = ['core.hooksPath=/dev/null', 'commit.gpgSign=false', 'tag.gpgSign=false', 'protocol.ext.allow=never']

export const maskUrl = (s: string) => s.replace(/(\w+:\/\/)[^/@\s]+@/g, '$1***@')

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * Runs `fn` with the environment that makes git use `auth` for SSH: the key (and known hosts)
 * in a private temp dir, `GIT_SSH_COMMAND` pointing at them. The files are removed afterwards,
 * whatever happens. Without `auth`, `fn` gets no extra environment.
 */
export async function withAuth<T>(auth: GitAuth | undefined, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
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

export interface GitRunnerOptions {
  git: string
  env: Record<string, string | undefined>
  timeoutMs: number
}

export type GitRun = (
  args: string[],
  o?: { cwd?: string; env?: Record<string, string>; allowFail?: boolean },
) => Promise<{ stdout: string; stderr: string; code: number }>

/**
 * Runs git with `BASE_CONFIG`. A failure is a `GitError` (credentials in URLs masked), unless
 * `allowFail`, which returns the exit code instead. A missing binary is an `UnavailableError`.
 */
export function gitRunner(opts: GitRunnerOptions): GitRun {
  return (args, o = {}) => {
    const full = [...BASE_CONFIG.flatMap((c) => ['-c', c]), ...args]
    return new Promise((res, rej) => {
      execFile(
        opts.git,
        full,
        { cwd: o.cwd, env: { ...opts.env, ...o.env }, maxBuffer: 256 * 1024 * 1024, timeout: opts.timeoutMs, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (!err) return res({ stdout, stderr, code: 0 })
          const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean }
          if (e.code === 'ENOENT') return rej(new UnavailableError(`git binary not found: ${opts.git}`))
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
}
