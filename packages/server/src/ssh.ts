import type { KindSchema } from '@mp/core'
import { generateSshKeypair } from '@mp/git'
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

export interface SshKeyPair {
  /** `ssh-ed25519 AAAA… comment`, for authorized_keys and git hosts. */
  publicKey: string
  /** An unencrypted openssh-key-v1 private key, between `OPENSSH_KEY_HEADER` and `OPENSSH_KEY_FOOTER`. */
  privateKey: string
}

/** An ed25519 keypair in OpenSSH formats, from `@mp/git`. */
export function newSshKeyPair(comment: string): SshKeyPair {
  const k = generateSshKeypair(comment)
  return { publicKey: k.publicKeyOpenssh, privateKey: k.privateKeyOpenssh }
}

/** Kept for callers and tests: the same as `newSshKeyPair`. */
export const generateSshKeyPair = (comment = ''): SshKeyPair => newSshKeyPair(comment)

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
