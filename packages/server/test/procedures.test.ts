import type * as Api from '@mp/api'
import { reply } from '@mp/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CATCH_ALL_START, matchFor, parseStart, startOf } from '../src/procedures/index.ts'
import { testApp, until, type TestApp } from './helpers.ts'
import { type Backend, memoryBackend, realBackend } from './scenarios.ts'

/** The procedures API (src/procedures): create with triggers and context, run now, rebuild, triggers, access. */
function proceduresSuite(backend: Backend) {
  let t: TestApp
  let cleanup: () => Promise<void>
  let employeeId: string
  let member: Record<string, string>
  let viewer: Record<string, string>
  let ana: string
  let n = 0
  const uniq = () => `${++n}-${Math.random().toString(36).slice(2, 7)}`

  beforeAll(async () => {
    const b = await backend.make()
    cleanup = b.cleanup
    t = await testApp({ env: b.env, script: () => reply('Done: the procedure ran.') })
    const s = t.a.services
    employeeId = (await s.directory.employees.byHandle('meatless'))!.id
    ana = (await s.directory.contacts.create({ name: 'Ana Example', kind: 'person', email: 'ana@example.com' })).id
    const mia = (await s.directory.contacts.create({ name: 'Mia Member', kind: 'person' })).id
    const vic = (await s.directory.contacts.create({ name: 'Vic Viewer', kind: 'person' })).id
    member = await t.as(mia, { access: 'member' })
    viewer = await t.as(vic, { access: 'viewer' })
  })
  afterAll(async () => {
    await t.close()
    await cleanup()
  })

  const create = (body: Partial<Api.CreateProcedureBody>, headers?: Record<string, string>) =>
    t.req<Api.CreatedProcedure & { error?: { message: string } }>(
      'POST',
      '/api/procedures',
      { name: `Access request ${uniq()}`, applies: 'Someone asks for access to a system.', employeeId, ...body },
      headers,
    )
  const channel = async (name: string) => (await t.req('POST', '/api/chat/channels', { name })).body.id as string

  it('creates a procedure with its triggers and its context in one call', async () => {
    const ch = await channel(`access-${uniq()}`)
    const r = await create({
      body: '## Steps\n\n1. Check the requester.\n2. Ask the owner.',
      ownerId: ana,
      approvals: [{ contactId: ana, step: 'before granting' }],
      starts: [
        { kind: 'channel', channelId: ch },
        { kind: 'schedule', cron: '0 9 * * 1', timezone: 'Europe/Belgrade' },
        {
          kind: 'integration',
          source: 'integration:gitlab',
          type: 'merge_request.opened',
          where: { 'payload.project': 'acme/pay' },
        },
        { kind: 'tag', tag: '@Access-Request' },
      ],
    })
    expect(r.status).toBe(201)
    const d = r.body.procedure
    expect(r.body.created).toBe(true)
    expect(d.owner).toMatchObject({ contactId: ana, name: 'Ana Example', kind: 'person' })
    expect(d.approvers).toEqual([{ contactId: ana, step: 'before granting', name: 'Ana Example' }])
    expect(d.context.state).toBe('ready')
    expect(d.context.employee?.id).toBe(employeeId)
    expect(d.triggers.map((x) => x.description)).toEqual([
      expect.stringMatching(/^When someone posts in #access-/),
      'Every Monday at 09:00 (Europe/Belgrade)',
      'When GitLab: a merge request is opened in acme/pay',
      'When someone writes @access-request in chat',
    ])
    expect(d.starts.map((x) => x.kind)).toEqual(['channel', 'schedule', 'integration', 'tag'])
    // The triggers are real triggers that fork the procedure's context.
    for (const tr of d.triggers) {
      const rec = await t.a.services.events.triggers.get(tr.id)
      expect(rec?.data).toMatchObject({ target: { type: 'procedure', procedureId: d.procedure.id }, fork: true, employeeId })
    }
    // The context has read the procedure, with names for its people.
    const history = await t.a.services.sessions.history(d.context.sessionId!)
    const text = history.map((e) => JSON.stringify(e.content)).join('\n')
    expect(text).toContain('Check the requester')
    expect(text).toContain('Ana Example')
    expect(text).toContain('before granting')
    // It is listed, and found by owner.
    const list = await t.req<Api.ProcedureListItem[]>('GET', `/api/procedures?ownerId=${ana}`)
    expect(list.body.map((x) => x.procedure.id)).toContain(d.procedure.id)
  })

  it('refuses a catch-all start with a friendly message, and creates nothing', async () => {
    const name = `Catch all ${uniq()}`
    const before = (await t.a.services.directory.procedures.list({ limit: 500 })).total
    const r = await create({ name, starts: [{ kind: 'custom' }] })
    expect(r.status).toBe(422)
    expect(r.body.error?.message).toBe(CATCH_ALL_START)
    const wild = await create({ name, starts: [{ kind: 'custom', source: '*', type: '**' }] })
    expect(wild.status).toBe(422)
    expect((await t.a.services.directory.procedures.list({ limit: 500 })).total).toBe(before)
    // Malformed starts are 400s.
    expect((await create({ starts: [{ kind: 'schedule', cron: 'every monday' }] })).status).toBe(400)
    expect((await create({ starts: [{ kind: 'channel' } as never] })).status).toBe(400)
    expect((await create({ starts: [{ kind: 'nope' } as never] })).status).toBe(400)
  })

  it('is idempotent against a double submit', async () => {
    const key = `idem-${uniq()}`
    const name = `Deploy ${uniq()}`
    const [a, b] = await Promise.all([create({ name, idempotencyKey: key }), create({ name, idempotencyKey: key })])
    expect([a.status, b.status].sort()).toEqual([200, 201])
    expect(a.body.procedure.procedure.id).toBe(b.body.procedure.procedure.id)
    const again = await create({ name, idempotencyKey: key })
    expect(again.status).toBe(200)
    expect(again.body.created).toBe(false)
    const all = (await t.a.services.directory.procedures.list({ limit: 500 })).items.filter((p) => p.data.name === name)
    expect(all).toHaveLength(1)
  })

  it('follows the access rules: viewers read, members write, admins own the triggers', async () => {
    expect((await t.req('GET', '/api/procedures', undefined, viewer)).status).toBe(200)
    expect((await create({}, viewer)).status).toBe(403)
    const mine = await create({}, member)
    expect(mine.status).toBe(201)
    const id = mine.body.procedure.procedure.id
    expect((await t.req('GET', `/api/procedures/${id}`, undefined, viewer)).status).toBe(200)
    // Members can't add triggers, directly or while creating.
    const withStart = await create({ starts: [{ kind: 'tag', tag: 'deploy' }] }, member)
    expect(withStart.status).toBe(403)
    expect(withStart.body.error?.message).toMatch(/only admins decide when a procedure runs/)
    const add = await t.req('POST', `/api/procedures/${id}/triggers`, { start: { kind: 'tag', tag: 'deploy' } }, member)
    expect(add.status).toBe(403)
    expect((await t.req('POST', `/api/procedures/${id}/run`, {}, viewer)).status).toBe(403)
    expect((await t.req('POST', `/api/procedures/${id}/context/rebuild`, {}, viewer)).status).toBe(403)
    expect((await t.req('POST', `/api/procedures/${id}/archive`, { archived: true }, viewer)).status).toBe(403)
    expect((await t.req('GET', '/api/procedures/prc_00000000000000000000000000')).status).toBe(404)
  })

  it('runs now: a fork of the context with the work as its instruction, and lists it', async () => {
    const p = (await create({ body: '1. Do the thing.' })).body.procedure
    const r = await t.req<Api.ProcedureRunStarted>('POST', `/api/procedures/${p.procedure.id}/run`, {
      work: 'Grant Ana read access to Grafana.',
      idempotencyKey: 'run-1',
    })
    expect(r.status).toBe(201)
    expect(r.body.contextSessionId).toBe(p.context.sessionId)
    const fork = await t.a.services.sessions.require(r.body.sessionId)
    expect(fork.data.parent?.sessionId).toBe(p.context.sessionId)
    const run = await t.a.services.sessions.requireRun(r.body.runId)
    expect(run.data.cause.type).toBe('manual')
    expect(run.data.requesterId).toBe((await t.admin()).contactId)
    const repeat = await t.req<Api.ProcedureRunStarted>('POST', `/api/procedures/${p.procedure.id}/run`, {
      idempotencyKey: 'run-1',
    })
    expect(repeat.body.runId).toBe(r.body.runId)
    await t.settle()
    const d = await until(async () => {
      const x = (await t.req<Api.ProcedureDetail>('GET', `/api/procedures/${p.procedure.id}`)).body
      return x.runs.length === 1 && x.runs[0]!.state && x.runs[0]!.state !== 'queued' ? x : null
    }, 'the run')
    expect(d.runs[0]).toMatchObject({ sessionId: r.body.sessionId, startedBy: { type: 'person', label: 'Admin' } })
    expect(d.runs30d).toBe(1)
    expect(d.lastRun?.sessionId).toBe(r.body.sessionId)
  })

  it('runs from its channel trigger, in a fork, and says which trigger started it', async () => {
    const name = `grants-${uniq()}`
    const ch = await channel(name)
    const p = (await create({ starts: [{ kind: 'channel', channelId: ch }] })).body.procedure
    await t.req('POST', `/api/chat/channels/${ch}/messages`, { text: 'Can I get access to the billing dashboard?' })
    await t.settle()
    const d = await until(async () => {
      const x = (await t.req<Api.ProcedureDetail>('GET', `/api/procedures/${p.procedure.id}`)).body
      return x.runs.length ? x : null
    }, 'a triggered run')
    expect(d.runs[0]!.startedBy).toMatchObject({ type: 'trigger', id: p.triggers[0]!.id })
    const fork = await t.a.services.sessions.require(d.runs[0]!.sessionId)
    expect(fork.data.parent?.sessionId).toBe(p.context.sessionId)
  })

  it('marks the context out of date after an edit, and rebuilds it', async () => {
    const p = (await create({ body: 'Old steps.' })).body.procedure
    const id = p.procedure.id
    const edited = await t.req('PATCH', `/api/records/procedure/${id}`, { data: { body: 'New steps: ask Ana first.' } })
    expect(edited.status).toBe(200)
    const stale = (await t.req<Api.ProcedureDetail>('GET', `/api/procedures/${id}`)).body
    expect(stale.context.state).toBe('stale')
    expect(stale.context.reason).toMatch(/changed/)
    const r = await t.req<Api.ProcedureDetail>('POST', `/api/procedures/${id}/context/rebuild`, {}, member)
    expect(r.status).toBe(200)
    expect(r.body.context.state).toBe('ready')
    expect(r.body.context.sessionId).not.toBe(p.context.sessionId)
    const history = await t.a.services.sessions.history(r.body.context.sessionId!)
    expect(JSON.stringify(history)).toContain('ask Ana first')
    expect((await t.a.services.sessions.require(p.context.sessionId!)).data.status).toBe('done')
  })

  it('builds a missing context on the first run, and reads legacy contexts by their revisions', async () => {
    const s = t.a.services
    const p = await s.directory.procedures.create({ name: `Legacy ${uniq()}`, applies: 'Old ones.' })
    const missing = (await t.req<Api.ProcedureDetail>('GET', `/api/procedures/${p.id}`)).body
    expect(missing.context.state).toBe('missing')
    expect(missing.starts).toEqual([{ kind: 'manual', description: 'Only when someone starts it' }])
    expect((await t.req('POST', `/api/procedures/${p.id}/run`, {})).status).toBe(422)
    // A context made the old way (no digest) is current until a context field changes.
    const ctx = await s.sessions.create({
      employeeId,
      title: 'Old context',
      links: [{ ref: { kind: 'procedure', id: p.id }, role: 'context_of' }],
    })
    await s.directory.procedures.update(p.id, { contextSessionId: ctx.id })
    expect((await t.req<Api.ProcedureDetail>('GET', `/api/procedures/${p.id}`)).body.context.state).toBe('ready')
    await s.directory.procedures.update(p.id, { applies: 'Old ones, and new ones.' })
    expect((await t.req<Api.ProcedureDetail>('GET', `/api/procedures/${p.id}`)).body.context.state).toBe('stale')
    const run = await t.req('POST', `/api/procedures/${p.id}/run`, {})
    expect(run.status).toBe(201)
  })

  it('adds, changes and removes triggers', async () => {
    const p = (await create({})).body.procedure
    const id = p.procedure.id
    const added = await t.req<Api.ProcedureDetail>('POST', `/api/procedures/${id}/triggers`, {
      start: { kind: 'integration', source: 'integration:linear', type: 'issue.labeled', where: { 'payload.team': 'PAY' } },
    })
    expect(added.status).toBe(201)
    const tr = added.body.triggers[0]!
    expect(tr.description).toBe('When Linear: an issue gets a label in team PAY')
    expect(tr.name).toBe('Linear: an issue gets a label in team PAY')
    const bad = await t.req('PATCH', `/api/procedures/${id}/triggers/${tr.id}`, { start: { kind: 'custom', type: '*' } })
    expect(bad.status).toBe(422)
    const toSchedule = await t.req<Api.ProcedureDetail>('PATCH', `/api/procedures/${id}/triggers/${tr.id}`, {
      start: { kind: 'schedule', cron: '0 2 * * *' },
    })
    expect(toSchedule.status).toBe(200)
    expect(toSchedule.body.triggers[0]).toMatchObject({ description: 'Every day at 02:00 (UTC)', start: { kind: 'schedule' } })
    expect((await t.a.services.events.triggers.get(tr.id))?.data.schedule).toMatchObject({ cron: '0 2 * * *', timezone: 'UTC' })
    const off = await t.req<Api.ProcedureDetail>('PATCH', `/api/procedures/${id}/triggers/${tr.id}`, { enabled: false })
    expect(off.body.triggers[0]!.enabled).toBe(false)
    expect(off.body.starts).toEqual([{ kind: 'manual', description: 'Only when someone starts it' }])
    // Another procedure's trigger is not this one's.
    const other = (await create({ starts: [{ kind: 'tag', tag: `x${uniq()}` }] })).body.procedure
    expect((await t.req('DELETE', `/api/procedures/${id}/triggers/${other.triggers[0]!.id}`)).status).toBe(404)
    const removed = await t.req<Api.ProcedureDetail>('DELETE', `/api/procedures/${id}/triggers/${tr.id}`)
    expect(removed.body.triggers).toEqual([])
    expect(await t.a.services.events.triggers.get(tr.id)).toBeNull()
  })

  it('archives: its triggers go off, it no longer runs, and the list hides it', async () => {
    const p = (await create({ starts: [{ kind: 'tag', tag: `arch${uniq()}` }] })).body.procedure
    const id = p.procedure.id
    const r = await t.req<Api.ProcedureDetail>('POST', `/api/procedures/${id}/archive`, { archived: true }, member)
    expect(r.status).toBe(200)
    expect(r.body.procedure.data.archived).toBe(true)
    expect(r.body.triggers.every((x) => !x.enabled)).toBe(true)
    expect((await t.req('POST', `/api/procedures/${id}/run`, {})).status).toBe(409)
    const list = (await t.req<Api.ProcedureListItem[]>('GET', '/api/procedures')).body
    expect(list.some((x) => x.procedure.id === id)).toBe(false)
    const all = (await t.req<Api.ProcedureListItem[]>('GET', '/api/procedures?archived=true')).body
    expect(all.some((x) => x.procedure.id === id)).toBe(true)
    expect((await t.a.services.directory.procedures.find(p.procedure.data.name)).some((h) => h.record.id === id)).toBe(false)
  })
}

describe('procedure starts', () => {
  it('maps each start to a trigger match and back', () => {
    const channel = parseStart({ kind: 'channel', channelId: 'chn_1', filter: { 'payload.text': { $regex: 'grafana' } } })
    const m = matchFor(channel).match
    expect(m).toEqual({
      source: 'chat',
      type: 'message.posted',
      where: { 'payload.channelId': 'chn_1', 'payload.author.kind': 'contact' },
      filter: { 'payload.text': { $regex: 'grafana' } },
    })
    const trigger = (data: Record<string, unknown>) => ({ data: { name: 'x', employeeId: 'emp_1', match: {}, ...data } }) as never
    expect(startOf(trigger({ match: m }))).toEqual(channel)
    expect(startOf(trigger({ schedule: { cron: '0 9 * * 1-5' } }))).toEqual({ kind: 'schedule', cron: '0 9 * * 1-5' })
    expect(startOf(trigger({ match: { source: 'integration:gitlab', type: 'pipeline.failed' } }))).toEqual({
      kind: 'integration',
      source: 'integration:gitlab',
      type: 'pipeline.failed',
    })
    expect(startOf(trigger({ match: { source: 'mcp:linear', type: 'task.*' } }))).toEqual({
      kind: 'custom',
      source: 'mcp:linear',
      type: 'task.*',
    })
    // A stored start wins over the match.
    expect(startOf(trigger({ match: { source: 'chat' }, start: { kind: 'tag', tag: 'deploy' } }))).toEqual({
      kind: 'tag',
      tag: 'deploy',
    })
    expect(() => matchFor({ kind: 'custom', where: {} })).toThrow(CATCH_ALL_START)
    expect(() => parseStart({ kind: 'tag', tag: 'no spaces please' })).toThrow(/a tag is/)
    expect(() => parseStart({ kind: 'channel', channelId: 'c', filter: [] })).toThrow(/filter must be a query object/)
  })
})

describe('procedures (memory)', () => proceduresSuite(memoryBackend))

const { DATABASE_URL, REDIS_URL } = process.env
describe.skipIf(!DATABASE_URL || !REDIS_URL)('procedures (postgres + bullmq)', () =>
  proceduresSuite(realBackend(DATABASE_URL!, REDIS_URL!)),
)
