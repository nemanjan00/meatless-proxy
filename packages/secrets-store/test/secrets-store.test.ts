import { ManualClock, ValidationError } from '@mp/core'
import { secretStoreContract } from '@mp/secrets/contract'
import { memoryStore } from '@mp/store'
import { describe, expect, it } from 'vitest'
import { SECRET_KIND, SecretDecryptError, type SecretRecord, deriveKey, storeSecretStore } from '../src/index.ts'

const KEY = 'test-master-key-0123456789abcdef'
const OTHER_KEY = 'another-test-key-0123456789abcdef'

secretStoreContract('store', ({ clock }) => storeSecretStore({ store: memoryStore({ clock }), key: KEY, clock }))

describe('storeSecretStore', () => {
  const plaintext = 'plain-VERY-SECRET-VALUE-42'

  it('stores one encrypted record per name and scope, never the plaintext', async () => {
    const store = memoryStore()
    const secrets = storeSecretStore({ store, key: KEY })
    await secrets.set('OPENAI_KEY', plaintext, { type: 'project', id: 'prj_1' }, 'ana')
    await secrets.set('OPENAI_KEY', plaintext, { type: 'project', id: 'prj_1' }, 'ana')
    const page = await store.records.query<SecretRecord>(SECRET_KIND)
    expect(page.total).toBe(1)
    const rec = page.items[0]!
    expect(rec.key).toBe('project:prj_1:OPENAI_KEY')
    expect(rec.data).toMatchObject({
      name: 'OPENAI_KEY',
      scope: { type: 'project', id: 'prj_1' },
      alg: 'aes-256-gcm',
      updatedBy: 'ana',
    })
    const everything = JSON.stringify([rec, await store.records.revisions(SECRET_KIND, rec.id)])
    expect(everything).not.toContain(plaintext)
    expect(everything).not.toContain(Buffer.from(plaintext).toString('base64'))
    expect(everything).not.toContain(Buffer.from(plaintext).toString('hex'))
    expect(await secrets.resolve(['OPENAI_KEY'], { projectId: 'prj_1' })).toEqual({ OPENAI_KEY: plaintext })
  })

  it('uses a fresh IV for every write', async () => {
    const store = memoryStore()
    const secrets = storeSecretStore({ store, key: KEY })
    await secrets.set('A', plaintext, { type: 'global' })
    await secrets.set('B', plaintext, { type: 'global' })
    const [a, b] = (await store.records.query<SecretRecord>(SECRET_KIND, { orderBy: { field: 'key' } })).items
    expect(a!.data.iv).not.toBe(b!.data.iv)
    expect(a!.data.ciphertext).not.toBe(b!.data.ciphertext)
  })

  it('fails clearly with the wrong key, and reads fine with the right one', async () => {
    const store = memoryStore()
    await storeSecretStore({ store, key: KEY }).set('TOKEN', plaintext, { type: 'global' })
    const wrong = storeSecretStore({ store, key: OTHER_KEY })
    await expect(wrong.resolve(['TOKEN'], {})).rejects.toBeInstanceOf(SecretDecryptError)
    await expect(wrong.resolve(['TOKEN'], {})).rejects.toThrow(/different master key/)
    // Listing needs no key.
    expect((await wrong.list()).map((m) => m.name)).toEqual(['TOKEN'])
    expect(await storeSecretStore({ store, key: KEY }).resolve(['TOKEN'], {})).toEqual({ TOKEN: plaintext })
  })

  it('detects a tampered ciphertext', async () => {
    const store = memoryStore()
    const secrets = storeSecretStore({ store, key: KEY })
    await secrets.set('TOKEN', plaintext, { type: 'global' })
    const rec = (await store.records.getByKey<SecretRecord>(SECRET_KIND, 'global:TOKEN'))!
    const bytes = Buffer.from(rec.data.ciphertext, 'base64')
    bytes[0] = bytes[0]! ^ 1
    await store.records.update(SECRET_KIND, rec.id, { ciphertext: bytes.toString('base64') })
    await expect(secrets.resolve(['TOKEN'], {})).rejects.toThrow(/wrong key or tampered/)
  })

  it('binds the ciphertext to its name and scope', async () => {
    const store = memoryStore()
    const secrets = storeSecretStore({ store, key: KEY })
    await secrets.set('ADMIN_TOKEN', 'admin-only-value', { type: 'project', id: 'prj_admin' })
    await secrets.set('ADMIN_TOKEN', 'harmless-value', { type: 'project', id: 'prj_public' })
    // Copy the admin project's encrypted value onto the public project's record.
    const admin = (await store.records.getByKey<SecretRecord>(SECRET_KIND, 'project:prj_admin:ADMIN_TOKEN'))!
    const pub = (await store.records.getByKey<SecretRecord>(SECRET_KIND, 'project:prj_public:ADMIN_TOKEN'))!
    await store.records.update(SECRET_KIND, pub.id, { iv: admin.data.iv, tag: admin.data.tag, ciphertext: admin.data.ciphertext })
    await expect(secrets.resolve(['ADMIN_TOKEN'], { projectId: 'prj_public' })).rejects.toBeInstanceOf(SecretDecryptError)
  })

  it('records the actor on revisions', async () => {
    const store = memoryStore()
    const secrets = storeSecretStore({ store, key: KEY })
    await secrets.set('A', 'value-1', { type: 'global' }, 'ana')
    await secrets.set('B', 'value-2', { type: 'global' })
    const a = (await store.records.getByKey(SECRET_KIND, 'global:A'))!
    const b = (await store.records.getByKey(SECRET_KIND, 'global:B'))!
    expect((await store.records.revisions(SECRET_KIND, a.id))[0]!.actor).toEqual({ type: 'contact', id: 'ana' })
    expect((await store.records.revisions(SECRET_KIND, b.id))[0]!.actor).toEqual({ type: 'system', id: 'system' })
  })

  it('ignores names that could not have been stored', async () => {
    const store = memoryStore()
    const secrets = storeSecretStore({ store, key: KEY })
    await secrets.set('C', 'tool-a-b-secret', { type: 'tool', name: 'a:b' })
    expect(await secrets.resolve(['b:C'], { tool: 'a' })).toEqual({})
  })

  it('derives keys deterministically and refuses short master keys', () => {
    const clock = new ManualClock()
    expect(deriveKey(KEY).keyId).toBe(deriveKey(KEY).keyId)
    expect(deriveKey(KEY).keyId).not.toBe(deriveKey(OTHER_KEY).keyId)
    expect(deriveKey(KEY).key).toHaveLength(32)
    expect(() => storeSecretStore({ store: memoryStore(), key: 'short', clock })).toThrow(ValidationError)
  })
})
