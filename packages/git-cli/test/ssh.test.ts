import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSshKeypair } from '@mp/git'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitError, gitCliCache } from '../src/index.ts'

/**
 * A fake `ssh` first on the PATH: it records its arguments, the mode and content of the `-i` key
 * and the known hosts file, then runs the remote command locally (as sshd would), so `ssh://`
 * remotes work against a local bare repository.
 */
const FAKE_SSH = `#!/bin/sh
log="$FAKE_SSH_LOG"
n=$(ls "$log" 2>/dev/null | wc -l)
d="$log/$n"
mkdir -p "$d"
printf '%s\\n' "$@" > "$d/args"
prev=''
for a in "$@"; do
  if [ "$prev" = "-i" ]; then printf '%s' "$a" > "$d/keypath"; stat -c %a "$a" > "$d/keymode"; cp "$a" "$d/key"; stat -c %a "$(dirname "$a")" > "$d/dirmode"; fi
  case "$a" in UserKnownHostsFile=*) f="\${a#UserKnownHostsFile=}"; printf '%s' "$f" > "$d/khpath"; [ -f "$f" ] && cp "$f" "$d/kh";; esac
  prev="$a"
  last="$a"
done
exec sh -c "$last"
`

let base: string
let env: Record<string, string>
let logDir: string
const run = (args: string[], cwd?: string) =>
  execFileSync('git', ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', ...args], {
    cwd,
    env,
    encoding: 'utf8',
  }).trim()

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'mp-git-ssh-test-'))
  const bin = join(base, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'ssh'), FAKE_SSH)
  chmodSync(join(bin, 'ssh'), 0o755)
  logDir = join(base, 'ssh-log')
  mkdirSync(logDir)
  env = {
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: base,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    FAKE_SSH_LOG: logDir,
  }
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

let n = 0
function setup() {
  const dir = join(base, `case-${++n}`)
  const origin = join(dir, 'origin.git')
  const seed = join(dir, 'seed')
  run(['init', '--quiet', '--bare', '-b', 'main', origin])
  run(['init', '--quiet', '-b', 'main', seed])
  writeFileSync(join(seed, 'README.md'), '# x\n')
  run(['add', '-A'], seed)
  run(['commit', '--quiet', '-m', 'initial'], seed)
  run(['push', '--quiet', origin, 'main'], seed)
  rmSync(logDir, { recursive: true, force: true })
  mkdirSync(logDir)
  return { dir, origin, url: `ssh://git.example.invalid${origin}`, cache: gitCliCache({ root: join(dir, 'cache'), env }) }
}

/** What the fake ssh saw, one entry per invocation. */
function sshCalls() {
  return readdirSorted(logDir).map((d) => {
    const p = join(logDir, d)
    const read = (f: string) => (existsSync(join(p, f)) ? readFileSync(join(p, f), 'utf8') : undefined)
    return {
      args: read('args')!.trim().split('\n'),
      keyPath: read('keypath'),
      keyMode: read('keymode')?.trim(),
      dirMode: read('dirmode')?.trim(),
      key: read('key'),
      khPath: read('khpath'),
      kh: read('kh'),
    }
  })
}
const readdirSorted = (d: string) =>
  (execFileSync('ls', [d], { encoding: 'utf8' }).trim().split('\n').filter(Boolean) as string[]).sort((a, b) => +a - +b)

const author = { name: 'Bot', email: 'bot@example.com' }
const policy = { allow: ['mp/**'], protected: ['main'] }

describe('per-call SSH auth', () => {
  it('uses the key for ensureMirror, fetch and push, in a private temp file removed afterwards', async () => {
    const t = setup()
    const kp = generateSshKeypair('bot@example.com')
    const auth = { sshPrivateKey: kp.privateKeyOpenssh }
    await t.cache.ensureMirror(t.url, auth)
    await t.cache.fetch(t.url, auth)
    await t.cache.createWorktree(t.url, { path: join(t.dir, 'wt'), newBranch: 'mp/a' })
    writeFileSync(join(t.dir, 'wt', 'a.txt'), 'a\n')
    await t.cache.commitAll(join(t.dir, 'wt'), { message: 'a', author })
    await t.cache.push(join(t.dir, 'wt'), 'mp/a', policy, auth)
    expect(run(['--git-dir', t.origin, 'rev-parse', '--verify', 'refs/heads/mp/a'])).toMatch(/^[0-9a-f]{40}$/)

    const calls = sshCalls()
    expect(calls.length).toBeGreaterThanOrEqual(3)
    const commands = calls.map((c) => c.args.at(-1))
    expect(commands.some((c) => c?.startsWith('git-upload-pack'))).toBe(true)
    expect(commands.some((c) => c?.startsWith('git-receive-pack'))).toBe(true)
    for (const c of calls) {
      expect(c.args).toContain('git.example.invalid')
      expect(c.args).toEqual(expect.arrayContaining(['-o', 'IdentitiesOnly=yes', 'StrictHostKeyChecking=accept-new']))
      expect(c.args).toContain('UserKnownHostsFile=/dev/null')
      expect(c.keyMode).toBe('600')
      expect(c.dirMode).toBe('700')
      expect(c.key).toBe(kp.privateKeyOpenssh)
      expect(existsSync(c.keyPath!)).toBe(false)
    }
    // A fresh temp file per operation (ensureMirror, fetch, push).
    expect(new Set(calls.map((c) => c.keyPath)).size).toBe(3)
  })

  it('writes known hosts and checks them strictly when asked', async () => {
    const t = setup()
    const knownHosts = 'git.example.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFake'
    await t.cache.fetch(t.url, {
      sshPrivateKey: generateSshKeypair('x').privateKeyOpenssh,
      knownHosts,
      strictHostKeyChecking: true,
    })
    const calls = sshCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c.args).toContain('StrictHostKeyChecking=yes')
      expect(c.kh).toBe(`${knownHosts}\n`)
      expect(c.khPath).not.toBe('/dev/null')
      expect(existsSync(c.khPath!)).toBe(false)
    }
  })

  it('without auth, GIT_SSH_COMMAND is left alone', async () => {
    const t = setup()
    await t.cache.fetch(t.url)
    const calls = sshCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c.keyPath).toBeUndefined()
      expect(c.args.some((a) => a.startsWith('IdentitiesOnly'))).toBe(false)
    }
  })

  it('removes the key when the command fails, and never puts it in the error', async () => {
    const t = setup()
    const kp = generateSshKeypair('fail')
    const bad = `ssh://git.example.invalid${join(t.dir, 'missing.git')}`
    const err = await t.cache.fetch(bad, { sshPrivateKey: kp.privateKeyOpenssh }).catch((e) => e)
    expect(err).toBeInstanceOf(GitError)
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(kp.privateKeyOpenssh.split('\n')[1])
    const calls = sshCalls()
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(existsSync(c.keyPath!)).toBe(false)
    expect(existsSync(join(t.dir, 'cache', 'git.example.invalid'))).toBe(true) // parent dir only; no half-made mirror
  })
})
