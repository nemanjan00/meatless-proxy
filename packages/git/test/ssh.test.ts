import { execFileSync } from 'node:child_process'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ValidationError } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { fakeGitCache, generateSshKeypair, parseSshPrivateKey, parseSshPublicKey } from '../src/index.ts'

const ARMOR = ['OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')

const hasSshKeygen = (() => {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' })
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT'
  }
})()

describe('generateSshKeypair', () => {
  it('produces an ssh-ed25519 public key line that parses back', () => {
    const kp = generateSshKeypair('billing-bot@example.com')
    expect(kp.publicKeyOpenssh).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* billing-bot@example\.com$/)
    const pub = parseSshPublicKey(kp.publicKeyOpenssh)
    expect(pub).toMatchObject({ type: 'ssh-ed25519', comment: 'billing-bot@example.com' })
    expect(pub.key).toHaveLength(32)
  })

  it('writes the private key in openssh-key-v1 format with a fixed structure', () => {
    const a = generateSshKeypair('a')
    const b = generateSshKeypair('a')
    for (const kp of [a, b]) {
      const lines = kp.privateKeyOpenssh.split('\n')
      expect(lines[0]).toBe(`-----BEGIN ${ARMOR}`)
      expect(lines.at(-2)).toBe(`-----END ${ARMOR}`)
      expect(lines.at(-1)).toBe('')
      expect(lines.slice(1, -2).every((l) => l.length <= 70)).toBe(true)
      const body = Buffer.from(lines.slice(1, -2).join(''), 'base64')
      expect(body.subarray(0, 15).toString('latin1')).toBe('openssh-key-v1\0')
      const parsed = parseSshPrivateKey(kp.privateKeyOpenssh)
      expect(parsed.publicKeyOpenssh).toBe(kp.publicKeyOpenssh)
      expect(parsed.comment).toBe('a')
    }
    // Same structure and length, different keys.
    expect(a.privateKeyOpenssh.length).toBe(b.privateKeyOpenssh.length)
    expect(a.publicKeyOpenssh).not.toBe(b.publicKeyOpenssh)
    expect(a.privateKeyOpenssh).not.toBe(b.privateKeyOpenssh)
  })

  it('holds a working keypair: the private seed signs what the public key verifies', () => {
    const kp = generateSshKeypair('sig')
    const { seed, publicKey } = parseSshPrivateKey(kp.privateKeyOpenssh)
    // PKCS8 and SPKI wrappers for raw ed25519 keys.
    const priv = createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
      format: 'der',
      type: 'pkcs8',
    })
    const pub = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]),
      format: 'der',
      type: 'spki',
    })
    const sig = sign(null, Buffer.from('hello'), priv)
    expect(verify(null, Buffer.from('hello'), pub, sig)).toBe(true)
  })

  it('handles an empty comment and refuses multi-line ones', () => {
    const kp = generateSshKeypair('')
    expect(kp.publicKeyOpenssh.split(' ')).toHaveLength(2)
    expect(parseSshPrivateKey(kp.privateKeyOpenssh).comment).toBe('')
    expect(() => generateSshKeypair('a\nb')).toThrow(ValidationError)
  })

  it('rejects malformed keys', () => {
    expect(() => parseSshPublicKey('ssh-ed25519')).toThrow(ValidationError)
    expect(() => parseSshPublicKey('ssh-rsa AAAAC3NzaC1lZDI1NTE5AAAAIA==')).toThrow(ValidationError)
    expect(() => parseSshPrivateKey('nope')).toThrow(ValidationError)
    const kp = generateSshKeypair('x')
    const lines = kp.privateKeyOpenssh.split('\n')
    const truncated = [lines[0], lines[1]!.slice(0, 40), lines.at(-2)].join('\n')
    expect(() => parseSshPrivateKey(truncated)).toThrow(ValidationError)
  })

  it.skipIf(!hasSshKeygen)('ssh-keygen -y reproduces the public key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-ssh-'))
    try {
      const kp = generateSshKeypair('keygen-check')
      const file = join(dir, 'id_ed25519')
      writeFileSync(file, kp.privateKeyOpenssh, { mode: 0o600 })
      const out = execFileSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8' }).trim()
      expect(out.split(' ').slice(0, 2)).toEqual(kp.publicKeyOpenssh.split(' ').slice(0, 2))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('fakeGitCache auth', () => {
  it('records the auth each remote-facing call got', async () => {
    const git = fakeGitCache()
    const url = 'git@github.com:acme/billing.git'
    const auth = { sshPrivateKey: generateSshKeypair('t').privateKeyOpenssh, strictHostKeyChecking: true }
    await git.fetch(url, auth)
    await git.createWorktree(url, { path: '/wt/a', newBranch: 'mp/a', auth })
    await git.ensureMirror(url)
    git.writeFile('/wt/a', 'f', '1')
    await git.commitAll('/wt/a', { message: 'x', author: { name: 'A', email: 'a@example.com' } })
    await git.push('/wt/a', 'mp/a', { allow: ['mp/**'], protected: [] }, auth)
    expect(git.auths).toEqual([
      { method: 'fetch', target: url, auth },
      { method: 'createWorktree', target: url, auth },
      { method: 'ensureMirror', target: url, auth: undefined },
      { method: 'push', target: '/wt/a', auth },
    ])
    // Keys stay out of the general call log.
    expect(JSON.stringify(git.calls)).not.toContain('PRIVATE')
  })
})
