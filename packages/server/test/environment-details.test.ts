import { fakeRuntime, type FakeRuntime } from '@mp/containers'
import { ManualClock, newId } from '@mp/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildLabel, profileOf, shortId } from '../src/environments/index.ts'
import { testApp, type TestApp } from './helpers.ts'

/**
 * What the Environments page tells about each environment beyond its session (docs/spec.md
 * "Environments"): the real image from the runtime (also for built and left-behind ones), the image's
 * details, the profile it maps back to, limits, idle time, and Stop idle.
 */

const HOUR = 3600_000
let t: TestApp
let rt: FakeRuntime
let employeeId: string
/** A session's environment from the scraper profile (env.up). */
let scraperEnv: string
let scraperSession: string
/** Built from a checkout's Dockerfile; the session recorded `image: 'build'`. */
let builtEnv: string
let builtSession: string
/** Left behind, no meta: runs a profile's image, with limits. */
let leftEnv: string
/** A session with a run in progress. */
let busyEnv: string

async function tool(sessionId: string, name: string, args: unknown) {
  const s = t.a.services
  const callId = newId('call')
  const r = await s.tools.execute(name, args, {
    employeeId,
    sessionId,
    runId: 'run_test',
    callId,
    idempotencyKey: `run_test:0:${callId}`,
    secrets: {},
    signal: new AbortController().signal,
    logger: s.logger,
    clock: s.clock,
    emit: () => {},
  })
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.output)}`)
  return r.output as any
}

const list = async () => (await t.req('GET', '/api/environments')).body.items as any[]
const byId = async (id: string) => (await list()).find((e) => e.envId === id)

beforeAll(async () => {
  // The environments started three hours ago (the runtime's clock); the server's is real time.
  rt = fakeRuntime({ clock: new ManualClock(Date.now() - 3 * HOUR) })
  t = await testApp({ workers: false, overrides: { containers: rt } })
  const s = t.a.services
  employeeId = (await s.directory.employees.byHandle('meatless'))!.id

  rt.setImage('nemanjan00/dev:scraper', {
    sizeBytes: 2_100_000_000,
    labels: {
      'org.opencontainers.image.source': 'https://github.com/nemanjan00/dev-environment',
      'org.opencontainers.image.description': 'Arch Linux dev environment',
      'org.opencontainers.image.base.name': 'archlinux:latest',
    },
  })
  const scr = await s.sessions.create({ employeeId, title: 'Scrape the price list' })
  scraperSession = scr.id
  scraperEnv = (await tool(scr.id, 'env.up', { profile: 'scraper' })).envId

  const b = await s.sessions.create({ employeeId, title: 'Build the app' })
  builtSession = b.id
  const built = await rt.createEnv({
    name: 'build-the-app',
    build: { context: '/data/wt/build-the-app' },
    labels: { 'mp.session': b.id, 'mp.employee': employeeId },
  })
  builtEnv = built.id
  await s.records.update('session', b.id, {
    meta: {
      env: { id: built.id, name: built.name, image: 'build', checkouts: [{ key: 'payments-api', path: '/workspace' }] },
    },
  })

  leftEnv = (
    await rt.createEnv({
      name: 'left-behind',
      image: 'docker.io/nemanjan00/dev:analyst',
      limits: { cpus: 2, memoryMb: 1024, pids: 500 },
    })
  ).id

  const busy = await s.sessions.create({ employeeId, title: 'Long job' })
  busyEnv = (await tool(busy.id, 'env.up', { image: 'node:22' })).envId
  await s.sessions.createRun({ sessionId: busy.id, cause: { type: 'manual' } })
})

afterAll(async () => {
  await t?.close()
})

describe('GET /api/environments: images', () => {
  it("lists only the runtime's environments, each with its real image", async () => {
    const items = await list()
    expect(items.map((e) => e.envId).sort()).toEqual([scraperEnv, builtEnv, leftEnv, busyEnv].sort())
    expect(items.every((e) => typeof e.image === 'string' && e.image.length > 0)).toBe(true)
  })

  it("tells a profile's image with its details, and the profile's description", async () => {
    const e = await byId(scraperEnv)
    expect(e).toMatchObject({
      image: 'nemanjan00/dev:scraper',
      profile: 'scraper',
      profileDescription: expect.stringContaining('cloakbrowser'),
      imageInfo: {
        ref: 'nemanjan00/dev:scraper',
        id: expect.stringMatching(/^sha256:[0-9a-f]{12}$/),
        digest: expect.stringMatching(/^nemanjan00\/dev@sha256:/),
        sizeBytes: 2_100_000_000,
        createdAt: '2026-09-01T00:00:00.000Z',
        platform: 'linux/amd64',
        source: 'https://github.com/nemanjan00/dev-environment',
        description: 'Arch Linux dev environment',
        base: 'archlinux:latest',
      },
    })
    expect(e.build).toBeUndefined()
  })

  it("labels an environment built from a Dockerfile, with its image's name", async () => {
    const e = await byId(builtEnv)
    expect(e).toMatchObject({
      image: 'build/build-the-app:latest',
      build: "built from payments-api's Dockerfile",
      session: { id: builtSession },
      imageInfo: { ref: 'build/build-the-app:latest', digest: null },
    })
    expect(e.profile).toBeUndefined()
  })

  it('maps a left-behind environment back to its profile by image, with its limits', async () => {
    const e = await byId(leftEnv)
    expect(e).toMatchObject({
      session: null,
      image: 'docker.io/nemanjan00/dev:analyst',
      profile: 'analyst',
      profileDescription: expect.stringContaining('psql'),
      limits: { cpus: 2, memoryBytes: 1024 * 1024 * 1024, pids: 500 },
    })
    expect(e.startedAt).toBe(e.createdAt)
    expect((await byId(scraperEnv)).limits).toBeNull()
  })

  it('inspects each image once and reuses it for a while', async () => {
    const before = rt.imageInspections
    await list()
    await list()
    expect(rt.imageInspections).toBe(before)
  })

  it('keeps an inspection for a while, even when the image has gone since', async () => {
    rt.setImage('node:22', null)
    const e = await byId(busyEnv)
    // Cached from the first look: still there until the cache expires.
    expect(e.image).toBe('node:22')
    expect(e.imageInfo.ref).toBe('node:22')
  })
})

describe('idle time and Stop idle', () => {
  it('counts idle time from the last env.exec, else the last run, else the start', async () => {
    const left = await byId(leftEnv)
    expect(left.busy).toBe(false)
    expect(left.lastActiveAt).toBe(left.createdAt)
    expect((await byId(busyEnv)).busy).toBe(true)
    const bus = t.a.services.bus
    bus.publish('env.exec.started', { envId: scraperEnv, callId: 'c1', cmd: ['ls'], startedAt: new Date().toISOString() })
    expect((await byId(scraperEnv)).busy).toBe(true)
    bus.publish('env.exec.finished', { envId: scraperEnv, callId: 'c1' })
    const scr = await byId(scraperEnv)
    expect(scr.busy).toBe(false)
    expect(Date.now() - Date.parse(scr.lastActiveAt)).toBeLessThan(60_000)
  })

  it('is for admins, and refuses silly thresholds', async () => {
    const ana = await t.a.services.directory.contacts.create({
      name: 'Ana',
      kind: 'person',
      access: 'member',
      email: 'ana@example.com',
    })
    const headers = await t.as(ana.id, { access: 'member' })
    expect((await t.req('POST', '/api/environments/stop-idle', {}, headers)).status).toBe(403)
    expect((await t.req('POST', '/api/environments/stop-idle', { idleMinutes: 1 })).status).toBe(422)
    expect((await t.req('POST', '/api/environments/stop-idle', { idleMinutes: 'x' })).status).toBe(422)
  })

  it('stops only what is idle long enough and not busy, noting it in each session', async () => {
    const dry = await t.req('POST', '/api/environments/stop-idle', { idleMinutes: 60, dryRun: true })
    expect(dry.status).toBe(200)
    expect(dry.body.dryRun).toBe(true)
    // Not the busy one, and not the one that just ran a command.
    expect(dry.body.stopped.sort()).toEqual([builtEnv, leftEnv].sort())
    expect(await rt.getEnv(builtEnv)).not.toBeNull()
    // Longer than anything has been idle: nothing.
    expect((await t.req('POST', '/api/environments/stop-idle', { idleMinutes: 600 })).body.stopped).toEqual([])

    const r = await t.req('POST', '/api/environments/stop-idle', { idleMinutes: 60 })
    expect(r.body).toEqual({ stopped: expect.arrayContaining([builtEnv, leftEnv]), failed: [], dryRun: false })
    expect(await rt.getEnv(builtEnv)).toBeNull()
    expect(await rt.getEnv(leftEnv)).toBeNull()
    expect(await rt.getEnv(scraperEnv)).not.toBeNull()
    expect(await rt.getEnv(busyEnv)).not.toBeNull()
    const history = await t.a.services.sessions.history(builtSession)
    expect(history.some((e) => e.kind === 'event' && (e.content as any).type === 'env.stopped')).toBe(true)
    expect((await t.a.services.sessions.require(builtSession)).data.meta?.env).toBeUndefined()
    expect((await t.a.services.sessions.require(scraperSession)).data.meta?.env).toBeTruthy()
  })
})

describe('helpers', () => {
  it('maps images to profiles, however the reference is written', () => {
    const profiles = [{ name: 'default', image: 'nemanjan00/dev:default', description: 'general work' }]
    expect(profileOf(profiles, undefined, 'docker.io/nemanjan00/dev:default')).toEqual({
      name: 'default',
      description: 'general work',
    })
    expect(profileOf(profiles, undefined, 'nemanjan00/dev:other')).toBeNull()
    expect(profileOf(profiles, 'gone', 'x')).toEqual({ name: 'gone' })
    expect(profileOf([{ name: 'n', image: 'node', description: 'd' }], undefined, 'docker.io/library/node:latest')?.name).toBe(
      'n',
    )
  })

  it('shortens image IDs and names the repository a build came from', () => {
    expect(shortId(`sha256:${'0123456789ab'.repeat(5)}abcd`)).toBe('sha256:0123456789ab')
    expect(shortId(null)).toBeNull()
    expect(
      buildLabel([
        { key: 'web', path: '/repos/web' },
        { key: 'api', path: '/workspace' },
      ]),
    ).toBe("built from api's Dockerfile")
    expect(buildLabel(undefined)).toBe("built from a checkout's Dockerfile")
  })
})
