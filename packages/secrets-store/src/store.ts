import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { ConflictError, MpError, ValidationError, isId, systemClock, type Clock } from '@mp/core'
import {
  SECRET_NAME_RE,
  checkSecret,
  compareMeta,
  scopeKey,
  scopesFor,
  type SecretMeta,
  type SecretScope,
  type SecretStore,
} from '@mp/secrets'
import { SYSTEM, type Actor, type Store } from '@mp/store'

export interface StoreSecretStoreOptions {
  store: Store
  /** The master key, e.g. from the `SECRETS_KEY` setting. The encryption key is derived from it with scrypt. */
  key: string
  clock?: Clock
}

/** The record kind secrets are stored under. */
export const SECRET_KIND = 'secret'

/** What a `secret` record holds. The value only ever appears encrypted. */
export interface SecretRecord {
  [field: string]: unknown
  name: string
  scope: SecretScope
  updatedAt: string
  updatedBy: string
  alg: 'aes-256-gcm'
  /** Identifies the master key without revealing it, so a wrong key gives a clear error. */
  keyId: string
  iv: string
  tag: string
  ciphertext: string
}

/** A secret couldn't be decrypted: wrong master key, or the record was tampered with. */
export class SecretDecryptError extends MpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('secret_decrypt', message, details)
  }
}

// A fixed, public salt: the master key is expected to be long and random; scrypt makes weak keys slower to guess.
const SALT = 'meatless-proxy/secrets/v1'

/** Derives the 32-byte AES key and a short public key id from the master key. */
export function deriveKey(master: string): { key: Buffer; keyId: string } {
  if (master.length < 16) throw new ValidationError('the secrets master key must be at least 16 characters')
  const key = scryptSync(master, SALT, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  const keyId = createHmac('sha256', key).update('key-id').digest('hex').slice(0, 16)
  return { key, keyId }
}

const recordKey = (name: string, scope: SecretScope) => `${scopeKey(scope)}:${name}`
const aad = (name: string, scope: SecretScope) => Buffer.from(`mp-secret\0${scopeKey(scope)}\0${name}`)

const toActor = (actor: string): Actor =>
  actor === 'system' ? SYSTEM : isId(actor, 'ses') ? { type: 'session', id: actor } : { type: 'contact', id: actor }

/**
 * `SecretStore` on `@mp/store`: one record of kind `secret` per name and scope, keyed
 * `<scope key>:<name>`, with the value encrypted by AES-256-GCM (a random IV per write, the
 * name and scope bound in as associated data, so a ciphertext can't be moved to another secret).
 */
export function storeSecretStore(opts: StoreSecretStoreOptions): SecretStore {
  const { store } = opts
  const clock = opts.clock ?? systemClock
  const { key, keyId } = deriveKey(opts.key)

  const encrypt = (name: string, scope: SecretScope, value: string) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(aad(name, scope))
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
  }

  const decrypt = (r: SecretRecord): string => {
    const where = { name: r.name, scope: scopeKey(r.scope) }
    if (r.alg !== 'aes-256-gcm') throw new SecretDecryptError(`secret ${r.name}: unknown algorithm ${r.alg}`, where)
    const stored = Buffer.from(String(r.keyId))
    if (stored.length !== keyId.length || !timingSafeEqual(stored, Buffer.from(keyId))) {
      throw new SecretDecryptError(`secret ${r.name} was encrypted with a different master key`, where)
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(r.iv, 'base64'))
      decipher.setAAD(aad(r.name, r.scope))
      decipher.setAuthTag(Buffer.from(r.tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(r.ciphertext, 'base64')), decipher.final()]).toString('utf8')
    } catch {
      throw new SecretDecryptError(`secret ${r.name} could not be decrypted: wrong key or tampered record`, where)
    }
  }

  const get = (name: string, scope: SecretScope) => store.records.getByKey<SecretRecord>(SECRET_KIND, recordKey(name, scope))

  return {
    async set(name, value, scope, actor = 'system') {
      checkSecret(name, scope)
      if (typeof value !== 'string') throw new ValidationError('secret value must be a string')
      const data: SecretRecord = {
        name,
        scope: { ...scope },
        updatedAt: clock.iso(),
        updatedBy: actor,
        alg: 'aes-256-gcm',
        keyId,
        ...encrypt(name, scope, value),
      }
      const writeOpts = { actor: toActor(actor) }
      for (let attempt = 0; ; attempt++) {
        const existing = await get(name, scope)
        try {
          if (existing) {
            await store.records.update(SECRET_KIND, existing.id, data, {
              ...writeOpts,
              replace: true,
              expectedVersion: existing.version,
            })
          } else {
            await store.records.create(SECRET_KIND, data, { ...writeOpts, key: recordKey(name, scope), prefix: 'sec' })
          }
          return
        } catch (e) {
          // Someone else wrote the same secret at the same time: last write wins.
          if (!(e instanceof ConflictError) || attempt >= 5) throw e
        }
      }
    },

    async delete(name, scope) {
      const existing = await get(name, scope)
      if (existing)
        await store.records.delete(SECRET_KIND, existing.id).catch((e) => {
          if (!(e instanceof MpError && e.code === 'not_found')) throw e
        })
    },

    async list() {
      const page = await store.records.query<SecretRecord>(SECRET_KIND, { orderBy: { field: 'key', dir: 'asc' } })
      const metas: SecretMeta[] = page.items.map(({ data }) => ({
        name: data.name,
        scope: { ...data.scope },
        updatedAt: data.updatedAt,
        updatedBy: data.updatedBy,
      }))
      return metas.sort(compareMeta)
    },

    async resolve(names, ctx) {
      const scopes = scopesFor(ctx)
      const out: Record<string, string> = {}
      for (const name of new Set(names)) {
        if (!SECRET_NAME_RE.test(name)) continue
        for (const scope of scopes) {
          const r = await get(name, scope)
          if (r) {
            out[name] = decrypt(r.data)
            break
          }
        }
      }
      return out
    },
  }
}
