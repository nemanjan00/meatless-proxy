import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeGitCache, type GitCache } from '@mp/git'
import { reply } from '@mp/model'
import { describe, expect, it } from 'vitest'
import { bootstrap } from '../src/bootstrap.ts'
import { ConfigError, describeConfig, loadConfig, loadDotEnv } from '../src/config.ts'
import { asEmployee, employeeGit } from '../src/git-store.ts'
import { notificationToEvent, pathValue, stableHash } from '../src/mcp-in.ts'
import { OPENSSH_KEY_FOOTER, OPENSSH_KEY_HEADER, generateSshKeyPair } from '../src/ssh.ts'
import { silentLogger, systemClock } from '@mp/core'
import { testApp, until } from './helpers.ts'
import { quiet } from './scenarios.ts'

describe('config', () => {
  it('has defaults', () => {
    const c = loadConfig({})
    expect(c).toMatchObject({
      PORT: 3000,
      HOST: '0.0.0.0',
      DOCKER_ENABLED: false,
      MP_BOOTSTRAP: true,
      LOG_LEVEL: 'info',
      MCP_SERVERS: [],
    })
    expect(c.DATA_DIR).toMatch(/\.data\/app$/)
    expect(c.GIT_CACHE_DIR).toBe(`${c.DATA_DIR}/git`)
  })

  it('parses values and fails with every problem named', () => {
    const c = loadConfig({
      PORT: '8080',
      DOCKER_ENABLED: 'yes',
      MP_BOOTSTRAP: '0',
      LOG_LEVEL: 'DEBUG',
      PRICING: '{"m":{"inputPerM":1,"outputPerM":2}}',
    })
    expect(c).toMatchObject({
      PORT: 8080,
      DOCKER_ENABLED: true,
      MP_BOOTSTRAP: false,
      LOG_LEVEL: 'debug',
      PRICING: { m: { inputPerM: 1, outputPerM: 2 } },
    })
    let err: ConfigError | undefined
    try {
      loadConfig({ PORT: 'x', DOCKER_ENABLED: 'maybe', DATABASE_URL: 'mysql://nope', SECRETS_KEY: 'short', LOG_LEVEL: 'loud' })
    } catch (e) {
      err = e as ConfigError
    }
    expect(err).toBeInstanceOf(ConfigError)
    const names = err!.issues.map((i) => i.split(':')[0])
    expect(names).toEqual(expect.arrayContaining(['PORT', 'DOCKER_ENABLED', 'DATABASE_URL', 'SECRETS_KEY', 'LOG_LEVEL']))
    // Values never appear in messages.
    expect(err!.message).not.toContain('short')
  })

  it('checks cross-field rules and MCP servers', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x@localhost/db' })).toThrow(/SECRETS_KEY/)
    expect(() => loadConfig({ OPENAI_BASE_URL: 'https://api.example.com/v1' })).toThrow(/MODEL/)
    expect(() => loadConfig({ MCP_SERVERS: '[{"name":"a","transport":"stdio"}]' })).toThrow(/needs a command/)
    expect(() => loadConfig({ MCP_SERVERS: '[not json' })).toThrow(/invalid JSON/)
    const dir = mkdtempSync(join(tmpdir(), 'mp-cfg-'))
    try {
      const file = join(dir, 'mcp.json')
      writeFileSync(
        file,
        JSON.stringify([{ name: 'linear', transport: 'http', url: 'https://mcp.example.com', events: [{ method: 'x' }] }]),
      )
      expect(loadConfig({ MCP_SERVERS: file }).MCP_SERVERS[0]).toMatchObject({ name: 'linear', events: [{ method: 'x' }] })
      expect(() => loadConfig({ MCP_SERVERS: join(dir, 'missing.json') })).toThrow(/no file/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('describes itself without secret values', () => {
    const c = loadConfig({
      OPENAI_BASE_URL: 'https://api.example.com/v1',
      OPENAI_API_KEY: 'sk-test-secret',
      MODEL: 'm',
      SECRETS_KEY: 'x'.repeat(20),
    })
    const d = JSON.stringify(describeConfig(c))
    expect(d).not.toContain('sk-test-secret')
    expect(d).not.toContain('x'.repeat(20))
    expect(d).toContain('"apiKey":"set"')
  })

  it('loads .env without overriding the environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mp-env-'))
    try {
      const file = join(dir, '.env')
      writeFileSync(file, '# comment\nA=1\nexport B="two words"\nC=keep # note\nD=\'q\'\nbad line\nE=from-file\n')
      const env: Record<string, string | undefined> = { E: 'from-env' }
      expect(loadDotEnv(file, env).sort()).toEqual(['A', 'B', 'C', 'D'])
      expect(env).toEqual({ A: '1', B: 'two words', C: 'keep', D: 'q', E: 'from-env' })
      expect(loadDotEnv(join(dir, 'none'), env)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MCP notifications to events', () => {
  it('maps with and without a mapping', () => {
    const plain = notificationToEvent({
      server: 'docs',
      method: 'notifications/resources/updated',
      params: { uri: 'file:///a.md' },
    })
    expect(plain).toMatchObject({
      source: 'mcp:docs',
      type: 'notifications/resources/updated',
      subject: { system: 'docs', id: 'file:///a.md' },
    })
    expect(plain.dedupeKey).toBe(`mcp:docs:notifications/resources/updated:${stableHash({ uri: 'file:///a.md' })}`)
    const mapped = notificationToEvent(
      { server: 'linear', method: 'notifications/issue', params: { id: 'e9', issue: { key: 'PAY-9' }, title: 'Hi' } },
      {
        events: [
          {
            method: 'notifications/*',
            type: 'task.updated',
            subjectFrom: 'issue.key',
            subjectSystem: 'linear',
            idFrom: 'id',
            textFrom: 'title',
          },
        ],
      },
    )
    expect(mapped).toMatchObject({
      type: 'task.updated',
      subject: { system: 'linear', id: 'PAY-9' },
      dedupeKey: 'mcp:linear:notifications/issue:e9',
      text: 'Hi',
    })
    expect(stableHash({ b: 1, a: 2 })).toBe(stableHash({ a: 2, b: 1 }))
    expect(pathValue({ a: { b: [1] } }, 'a.b')).toEqual([1])
    expect(pathValue({ a: 1 }, 'a.b')).toBeUndefined()
  })
})

describe('ssh keys', () => {
  it('generates an OpenSSH ed25519 keypair whose halves belong together', () => {
    const k = generateSshKeyPair('bot@example')
    expect(k.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\S+ bot@example$/)
    expect(k.privateKey.startsWith(`${OPENSSH_KEY_HEADER}\n`)).toBe(true)
    expect(k.privateKey.endsWith(`\n${OPENSSH_KEY_FOOTER}\n`)).toBe(true)
    const blob = Buffer.from(k.privateKey.split('\n').slice(1, -2).join(''), 'base64')
    expect(blob.subarray(0, 15).toString()).toBe('openssh-key-v1\0')
    // Walk the format: cipher, kdf, kdf options, key count, public blob, private block.
    let off = 15
    const str = () => {
      const n = blob.readUInt32BE(off)
      const v = blob.subarray(off + 4, off + 4 + n)
      off += 4 + n
      return v
    }
    expect(str().toString()).toBe('none')
    expect(str().toString()).toBe('none')
    expect(str().length).toBe(0)
    expect(blob.readUInt32BE(off)).toBe(1)
    off += 4
    const pubBlob = str()
    expect(Buffer.from(k.publicKey.split(' ')[1]!, 'base64').equals(pubBlob)).toBe(true)
    const priv = str()
    expect(priv.length % 8).toBe(0)
    expect(priv.readUInt32BE(0)).toBe(priv.readUInt32BE(4))
    let p = 8
    const pstr = () => {
      const n = priv.readUInt32BE(p)
      const v = priv.subarray(p + 4, p + 4 + n)
      p += 4 + n
      return v
    }
    expect(pstr().toString()).toBe('ssh-ed25519')
    const pub = pstr()
    const secret = pstr()
    expect(secret.subarray(32).equals(pub)).toBe(true)
    expect(pstr().toString()).toBe('bot@example')
    const key = createPrivateKey({
      key: { kty: 'OKP', crv: 'Ed25519', d: secret.subarray(0, 32).toString('base64url'), x: pub.toString('base64url') },
      format: 'jwk',
    })
    const sig = sign(null, Buffer.from('hi'), key)
    const pubKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub.toString('base64url') }, format: 'jwk' })
    expect(verify(null, Buffer.from('hi'), pubKey, sig)).toBe(true)
    expect(generateSshKeyPair().publicKey).not.toBe(k.publicKey)
  })
})

describe('per-employee git stores', () => {
  it('dispatches to the store of the employee the run is for', async () => {
    const made: { root: string; cache: GitCache }[] = []
    const git = employeeGit({
      root: '/cache',
      logger: silentLogger,
      clock: systemClock,
      make: ({ root }) => {
        const cache = fakeGitCache({ root })
        made.push({ root, cache })
        return cache
      },
    })
    await expect(git.ensureMirror('https://github.com/acme/billing.git')).rejects.toThrow(/employee/)
    const a = await asEmployee('emp_A', async () => {
      expect(git.mirrorPath('https://github.com/acme/billing.git')).toBe('/cache/emp_A/github.com/acme/billing')
      const first = await git.forEmployee('emp_A')
      const second = await git.forEmployee('emp_A')
      return first === second
    })
    expect(a).toBe(true)
    await asEmployee('emp_B', () => git.forEmployee('emp_B'))
    expect(made.map((m) => m.root)).toEqual(['/cache/emp_A', '/cache/emp_B'])
    await expect(asEmployee('../x', async () => git.mirrorPath('https://github.com/a/b'))).rejects.toThrow(/not a valid/)
  })
})

describe('bootstrap and recovery', () => {
  it('bootstrap is idempotent', async () => {
    const t = await testApp({ workers: false })
    try {
      const s = t.a.services
      const first = await bootstrap(s)
      expect(first.created).toBe(false) // createApp already bootstrapped
      const again = await bootstrap(s)
      expect(again).toEqual({ ...first })
      expect((await s.directory.employees.list()).total).toBe(1)
      expect((await s.chat.listChannels()).map((c) => c.data.name).sort()).toEqual(['general', 'requests'])
      expect(await s.events.triggers.list()).toHaveLength(1)
      const emp = (await s.directory.employees.get(first.employeeId))!
      expect(emp.data.toolDeny).toEqual(['env.*', 'env.**'])
      expect(emp.data.routerSessionId).toBe(first.routerSessionId)
      const router = (await s.sessions.get(first.routerSessionId))!
      expect(router.data.toolset.length).toBeGreaterThan(10)
      expect(router.data.toolset.some((n) => n.startsWith('env.'))).toBe(false)
    } finally {
      await t.close()
    }
  })

  it('skips bootstrap when MP_BOOTSTRAP is off', async () => {
    const t = await testApp({ workers: false, env: { MP_BOOTSTRAP: '0' } })
    try {
      expect((await t.a.services.directory.employees.list()).total).toBe(0)
    } finally {
      await t.close()
    }
  })

  it('rebuilds the queues from the database at start', async () => {
    const t = await testApp({ workers: false, script: async () => reply('late but routed') })
    try {
      const s = t.a.services
      const requests = (await s.chat.channelByName('requests'))!
      // Stored while no worker runs, as if the queue had lost its jobs.
      const { event } = await s.rawEvents.ingest({
        source: 'chat',
        type: 'message.posted',
        payload: { channelId: requests.id, text: 'x', author: { kind: 'contact', id: 'con_someone' } },
      })
      expect(event.data.routed).toBe(false)
      await t.a.start({ http: false })
      await until(async () => (await s.rawEvents.get(event.id))?.data.routed, 'the event to be routed')
      await quiet(t)
      const runs = await s.sessions.runs({})
      expect(runs.map((r) => [r.data.state, r.data.result?.output])).toEqual([['completed', 'late but routed']])
    } finally {
      await t.close()
    }
  })
})
