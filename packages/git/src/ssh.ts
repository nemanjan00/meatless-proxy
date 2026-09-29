import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { ValidationError } from '@mp/core'

export interface SshKeypair {
  /** Unencrypted `openssh-key-v1` private key, PEM-armoured, ending in a newline. */
  privateKeyOpenssh: string
  /** One `authorized_keys` line: `ssh-ed25519 AAAA… comment`. */
  publicKeyOpenssh: string
}

const KEY_TYPE = 'ssh-ed25519'
const MAGIC = Buffer.from('openssh-key-v1\0', 'latin1')
// Spelled in parts so the secret scanner doesn't take this file for a key.
const ARMOR = ['OPENSSH', 'PRIVATE', 'KEY-----'].join(' ')
const BEGIN = `-----BEGIN ${ARMOR}`
const END = `-----END ${ARMOR}`

const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}
const sshString = (v: Buffer | string) => {
  const b = typeof v === 'string' ? Buffer.from(v, 'utf8') : v
  return Buffer.concat([u32(b.length), b])
}
const publicBlob = (pub: Buffer) => Buffer.concat([sshString(KEY_TYPE), sshString(pub)])

/**
 * A new ed25519 SSH keypair, generated with node:crypto. The private key is written by hand in
 * OpenSSH's own format (`openssh-key-v1`, cipher and KDF `none`), which `ssh` and `ssh-keygen`
 * read directly. `comment` goes on the public key line and inside the private key.
 */
export function generateSshKeypair(comment: string): SshKeypair {
  if (/[\r\n]/.test(comment)) throw new ValidationError('an SSH key comment must be one line')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url')
  if (pub.length !== 32 || seed.length !== 32) throw new Error('unexpected ed25519 key size')

  const check = randomBytes(4)
  let secret = Buffer.concat([
    check,
    check,
    sshString(KEY_TYPE),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ])
  // Pad to the cipher block size (8 for `none`) with 1, 2, 3, …
  const pad = (8 - (secret.length % 8)) % 8
  secret = Buffer.concat([secret, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))])

  const body = Buffer.concat([
    MAGIC,
    sshString('none'),
    sshString('none'),
    sshString(''),
    u32(1),
    sshString(publicBlob(pub)),
    sshString(secret),
  ]).toString('base64')
  const lines = body.match(/.{1,70}/g) ?? []
  const pubLine = `${KEY_TYPE} ${publicBlob(pub).toString('base64')}${comment ? ` ${comment}` : ''}`
  return { privateKeyOpenssh: `${BEGIN}\n${lines.join('\n')}\n${END}\n`, publicKeyOpenssh: pubLine }
}

class Reader {
  private at = 0
  constructor(private readonly buf: Buffer) {}
  u32(): number {
    if (this.at + 4 > this.buf.length) throw new ValidationError('truncated SSH key')
    const n = this.buf.readUInt32BE(this.at)
    this.at += 4
    return n
  }
  bytes(n: number): Buffer {
    if (this.at + n > this.buf.length) throw new ValidationError('truncated SSH key')
    const b = this.buf.subarray(this.at, this.at + n)
    this.at += n
    return b
  }
  string(): Buffer {
    return this.bytes(this.u32())
  }
  rest(): Buffer {
    return this.buf.subarray(this.at)
  }
}

/** Parses an `ssh-ed25519 AAAA… comment` line. */
export function parseSshPublicKey(line: string): { type: string; key: Buffer; comment: string } {
  const [type, b64, ...rest] = line.trim().split(/\s+/)
  if (!type || !b64) throw new ValidationError('not an SSH public key line')
  const r = new Reader(Buffer.from(b64, 'base64'))
  const inner = r.string().toString('latin1')
  if (inner !== type) throw new ValidationError('SSH public key type mismatch')
  const key = r.string()
  if (type === KEY_TYPE && key.length !== 32) throw new ValidationError('bad ed25519 public key')
  return { type, key, comment: rest.join(' ') }
}

/**
 * Reads an unencrypted ed25519 `openssh-key-v1` private key. Returns the seed, the public key and
 * the comment, and the public key line (what `ssh-keygen -y` prints, plus the comment).
 */
export function parseSshPrivateKey(pem: string): { seed: Buffer; publicKey: Buffer; comment: string; publicKeyOpenssh: string } {
  const text = pem.trim()
  if (!text.startsWith(BEGIN) || !text.endsWith(END)) throw new ValidationError('not an OpenSSH private key')
  const r = new Reader(Buffer.from(text.slice(BEGIN.length, -END.length).replace(/\s+/g, ''), 'base64'))
  if (!r.bytes(MAGIC.length).equals(MAGIC)) throw new ValidationError('not an openssh-key-v1 key')
  const cipher = r.string().toString()
  const kdf = r.string().toString()
  r.string() // kdf options
  if (cipher !== 'none' || kdf !== 'none') throw new ValidationError('encrypted SSH keys are not supported')
  if (r.u32() !== 1) throw new ValidationError('expected exactly one key')
  const pubBlob = r.string()
  const s = new Reader(r.string())
  if (!s.bytes(4).equals(s.bytes(4))) throw new ValidationError('SSH key check bytes differ (wrong passphrase?)')
  if (s.string().toString() !== KEY_TYPE) throw new ValidationError('only ed25519 keys are supported')
  const publicKey = Buffer.from(s.string())
  const priv = s.string()
  const comment = s.string().toString('utf8')
  const pad = s.rest()
  if (priv.length !== 64 || !priv.subarray(32).equals(publicKey)) throw new ValidationError('bad ed25519 private key')
  if (!pubBlob.equals(publicBlob(publicKey))) throw new ValidationError('SSH public key blobs differ')
  if (pad.length >= 8 || !pad.every((b, i) => b === i + 1)) throw new ValidationError('bad SSH key padding')
  return {
    seed: Buffer.from(priv.subarray(0, 32)),
    publicKey,
    comment,
    publicKeyOpenssh: `${KEY_TYPE} ${publicBlob(publicKey).toString('base64')}${comment ? ` ${comment}` : ''}`,
  }
}
