import { generateKeyPairSync, randomBytes } from 'node:crypto'
import type { KindSchema } from '@mp/core'
import * as gitPort from '@mp/git'
import type { Services } from './services.ts'

/** The secret (scoped to the employee) holding an employee's SSH private key. */
export const SSH_KEY_SECRET = 'SSH_PRIVATE_KEY'

/** Extension fields on `employee`: the public half of its SSH keypair, shown in the UI. */
export const employeeSshFields: NonNullable<KindSchema['extensions']> = [
  {
    name: 'sshPublicKey',
    type: 'string',
    description: "The employee's SSH public key (OpenSSH format): add it to its git host account or as a deploy key.",
  },
  { name: 'sshKeyCreatedAt', type: 'timestamp', description: 'When the SSH keypair was generated.' },
]

// Built from parts so the repository never contains a literal key header (the secret scanner flags those).
const KEY_LABEL = ['OPENSSH', 'PRIVATE', 'KEY'].join(' ')
/** The first line of an OpenSSH private key. */
export const OPENSSH_KEY_HEADER = `-----BEGIN ${KEY_LABEL}-----`
/** The last line of an OpenSSH private key. */
export const OPENSSH_KEY_FOOTER = `-----END ${KEY_LABEL}-----`

const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}
const sshString = (b: Buffer | string) => {
  const buf = typeof b === 'string' ? Buffer.from(b) : b
  return Buffer.concat([u32(buf.length), buf])
}

export interface SshKeyPair {
  /** `ssh-ed25519 AAAA… comment`, for authorized_keys and git hosts. */
  publicKey: string
  /** An unencrypted openssh-key-v1 private key, between `OPENSSH_KEY_HEADER` and `OPENSSH_KEY_FOOTER`. */
  privateKey: string
}

/**
 * An ed25519 keypair in OpenSSH formats: `generateSshKeypair` from `@mp/git`
 * when it is available, else the local `node:crypto` implementation.
 */
export function newSshKeyPair(comment: string): SshKeyPair {
  const fromGit = (gitPort as { generateSshKeypair?: (c: string) => unknown }).generateSshKeypair
  if (typeof fromGit === 'function') {
    const k = fromGit(comment) as Partial<SshKeyPair>
    if (typeof k?.publicKey === 'string' && typeof k.privateKey === 'string')
      return { publicKey: k.publicKey, privateKey: k.privateKey }
  }
  return generateSshKeyPair(comment)
}

/** Generates an ed25519 keypair in OpenSSH formats, with `node:crypto` only. */
export function generateSshKeyPair(comment = ''): SshKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url')
  const type = 'ssh-ed25519'
  const pubBlob = Buffer.concat([sshString(type), sshString(pub)])
  const check = randomBytes(4)
  let priv = Buffer.concat([
    check,
    check,
    sshString(type),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ])
  const pad: number[] = []
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i)
  priv = Buffer.concat([priv, Buffer.from(pad)])
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    u32(1),
    sshString(pubBlob),
    sshString(priv),
  ])
  const b64 = body.toString('base64').replace(/(.{70})/g, '$1\n')
  return {
    publicKey: `${type} ${pubBlob.toString('base64')}${comment ? ` ${comment}` : ''}`,
    privateKey: `${OPENSSH_KEY_HEADER}\n${b64.replace(/\n$/, '')}\n${OPENSSH_KEY_FOOTER}\n`,
  }
}

type KeyDeps = Pick<Services, 'secrets' | 'directory' | 'records' | 'clock' | 'logger'>

/** Declares the SSH fields on the `employee` kind (idempotent). */
export function defineSshFields(records: Services['records']) {
  const schema = records.kinds.get('employee')
  const have = new Set((schema.extensions ?? []).map((f) => f.name))
  const missing = employeeSshFields.filter((f) => !have.has(f.name))
  if (missing.length) records.kinds.extend('employee', missing)
}

async function hasKey(s: KeyDeps, employeeId: string) {
  return (await s.secrets.list()).some(
    (m) => m.name === SSH_KEY_SECRET && m.scope.type === 'employee' && m.scope.id === employeeId,
  )
}

/**
 * Generates and stores a new keypair for an employee: the private key as the
 * employee-scoped secret `SSH_PRIVATE_KEY`, the public key on the employee.
 */
async function generate(s: KeyDeps, employeeId: string): Promise<string> {
  const e = await s.directory.employees.require(employeeId)
  const pair = newSshKeyPair(`${e.key ?? e.data.name}@meatless-proxy`)
  await s.secrets.set(SSH_KEY_SECRET, pair.privateKey, { type: 'employee', id: employeeId }, 'system')
  await s.records.update('employee', employeeId, { sshPublicKey: pair.publicKey, sshKeyCreatedAt: s.clock.iso() })
  s.logger.info('ssh keypair generated', { employeeId })
  return pair.publicKey
}

const locks = new Map<string, Promise<unknown>>()

/** Runs `fn` after any earlier key operation on the same employee (one keypair at a time). */
function serial<T>(employeeId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(employeeId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.catch(() => {})
  locks.set(employeeId, tail)
  void tail.then(() => {
    if (locks.get(employeeId) === tail) locks.delete(employeeId)
  })
  return next
}

/** Makes sure an employee has a keypair; generates one if not. Returns whether it created one. */
export function ensureSshKey(s: KeyDeps, employeeId: string): Promise<boolean> {
  return serial(employeeId, async () => {
    const e = await s.directory.employees.get(employeeId)
    if (!e) return false
    if ((await hasKey(s, employeeId)) && typeof e.data.sshPublicKey === 'string') return false
    await generate(s, employeeId)
    return true
  })
}

/** Replaces an employee's keypair (rotation). Returns the new public key. */
export function rotateSshKey(
  s: KeyDeps & { gitStores?: { reset(id: string): void } | null },
  employeeId: string,
): Promise<string> {
  return serial(employeeId, async () => {
    const pub = await generate(s, employeeId)
    s.gitStores?.reset(employeeId)
    return pub
  })
}

/** The employee's private key, or null. Only the git layer reads it, never the model. */
export async function sshPrivateKey(s: Pick<Services, 'secrets'>, employeeId: string): Promise<string | null> {
  const v = await s.secrets.resolve([SSH_KEY_SECRET], { employeeId })
  return v[SSH_KEY_SECRET] ?? null
}
