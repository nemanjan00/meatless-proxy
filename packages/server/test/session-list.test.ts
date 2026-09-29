import { sleep } from '@mp/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Backend, memoryBackend, realBackend } from './scenarios.ts'
import { testApp, type TestApp } from './helpers.ts'

const DATABASE_URL = process.env.DATABASE_URL
const REDIS_URL = process.env.REDIS_URL

/** The sessions list: filters, sort orders and where each session came from. */
function describeList(backend: Backend | null, skipReason: string) {
  describe.skipIf(!backend)(`GET /api/sessions filters and sorts (${backend?.name ?? skipReason})`, () => {
    let t: TestApp
    let cleanup: () => Promise<void> = async () => {}
    const ids: Record<string, string> = {}
    let empA: string
    const empB = 'emp_other_00000000000000000000'
    let ana: string
    let bob: string
    let payments: string
    let search: string

    beforeAll(async () => {
      const made = await backend!.make()
      cleanup = made.cleanup
      // No workers: runs stay queued, so nothing changes under the assertions.
      t = await testApp({ env: made.env, workers: false })
      const s = t.a.services
      empA = (await s.directory.employees.byHandle('meatless'))!.id
      ana = (await s.directory.contacts.create({ name: 'Ana Example', kind: 'person' })).id
      bob = (await s.directory.contacts.create({ name: 'Bob Example', kind: 'person' })).id
      payments = (await s.directory.projects.create({ name: 'Payments' })).id
      search = (await s.directory.projects.create({ name: 'Search' })).id
      const router = (await s.sessions.bySlug(empA, 'router'))!
      ids.router = router.id
      const make = async (key: string, title: string, o: { emp?: string; meta?: Record<string, any>; parent?: string } = {}) => {
        await sleep(3)
        const x = o.parent
          ? await s.sessions.fork(o.parent, { title })
          : await s.sessions.create({ employeeId: o.emp ?? empA, title, ...(o.meta ? { meta: o.meta } : {}) })
        if (o.parent && o.meta) await s.sessions.update(x.id, { meta: o.meta })
        ids[key] = x.id
        return x
      }
      const event = async (source: string) =>
        (
          await s.rawEvents.ingest({
            source,
            type: 'message.posted',
            text: 'hi',
            dedupeKey: `${source}:${Math.random()}`,
          })
        ).event.id

      await make('retired', 'Old router', { meta: { role: 'router-retired', context: true } })
      // A chat request, for Ana, on Payments.
      await make('chat', 'zeta chat request')
      await s.sessions.createRun({
        sessionId: ids.chat!,
        cause: { type: 'event', eventId: await event('chat') },
        requesterId: ana,
      })
      await s.records.link({ kind: 'session', id: ids.chat! }, { kind: 'project', id: payments }, 'works_on')
      // A GitLab event, for Bob (a requested_by link only), on Search.
      await make('trigger', 'Alpha pipeline failed', { emp: empB })
      await s.sessions.createRun({ sessionId: ids.trigger!, cause: { type: 'event', eventId: await event('gitlab') } })
      await s.records.link({ kind: 'session', id: ids.trigger! }, { kind: 'contact', id: bob }, 'requested_by')
      await s.records.link({ kind: 'session', id: ids.trigger! }, { kind: 'project', id: search }, 'works_on')
      // A message sent from the UI: manual. It only mentions Payments.
      await make('manual', 'Manual check')
      await s.sessions.createRun({ sessionId: ids.manual!, cause: { type: 'event', eventId: await event('ui') } })
      await s.sessions.update(ids.manual!, { document: `Compare with [[project:${payments}|Payments]].` })
      expect((await s.records.links({ from: { kind: 'session', id: ids.manual! } })).map((l) => l.role)).toEqual(['mentions'])
      // Work the router started: a fork of the router, run by the router's run.
      const routerRun = await s.sessions.createRun({ sessionId: router.id, mode: 'ephemeral', cause: { type: 'manual' } })
      await make('handoff', 'Handed off', { parent: router.id })
      await s.sessions.createRun({ sessionId: ids.handoff!, cause: { type: 'fork', parentRunId: routerRun.id } })
      // Sub-work of the chat session.
      const chatRun = (await s.sessions.runs({ sessionId: ids.chat! }))[0]!
      await make('sub', 'beta sub-task', { parent: ids.chat! })
      await s.sessions.createRun({ sessionId: ids.sub!, cause: { type: 'fork', parentRunId: chatRun.id }, requesterId: ana })
      // A procedure run, and a session with no runs yet.
      await make('procedure', 'Refund approval: PAY-1', { meta: { procedureId: 'prc_00000000000000000000000000' } })
      await make('empty', 'Empty one', { emp: empB })
    })
    afterAll(async () => {
      await t?.close()
      await cleanup()
    })

    const get = async (qs = '') => {
      const r = await t.req('GET', `/api/sessions${qs ? `?${qs}` : ''}`)
      expect(r.status).toBe(200)
      return r.body as { items: any[]; total: number }
    }
    const idsOf = (page: { items: any[] }) => page.items.map((x) => x.session.id)
    const keysOf = (page: { items: any[] }) => {
      const byId = new Map(Object.entries(ids).map(([k, v]) => [v, k]))
      return page.items.map((x) => byId.get(x.session.id) ?? x.session.id)
    }

    it('hides retired routers by default, and shows them on request', async () => {
      const def = await get()
      expect(idsOf(def)).not.toContain(ids.retired)
      expect(idsOf(def)).toContain(ids.router)
      expect(idsOf(await get('excludeRoles=none'))).toContain(ids.retired)
      const noRouters = await get('excludeRoles=router,router-retired')
      expect(idsOf(noRouters)).not.toContain(ids.router)
      expect(noRouters.total).toBe(def.total - 1)
    })

    it('derives where each session came from', async () => {
      const all = await get('excludeRoles=none&limit=100')
      const from = Object.fromEntries(all.items.map((x) => [x.session.id, x.startedFrom]))
      expect(from).toMatchObject({
        [ids.router!]: 'router',
        [ids.retired!]: 'router',
        [ids.chat!]: 'chat',
        [ids.trigger!]: 'trigger',
        [ids.manual!]: 'manual',
        [ids.handoff!]: 'handoff',
        [ids.sub!]: 'session',
        [ids.procedure!]: 'procedure',
        [ids.empty!]: 'manual',
      })
    })

    it('filters by origin, and pages the filtered result', async () => {
      expect(keysOf(await get('origin=chat'))).toEqual(['chat'])
      expect(keysOf(await get('origin=handoff'))).toEqual(['handoff'])
      expect(keysOf(await get('origin=session'))).toEqual(['sub'])
      expect(keysOf(await get('origin=router'))).toEqual(['router'])
      expect(keysOf(await get('origin=router&excludeRoles=none')).sort()).toEqual(['retired', 'router'])
      const manual = await get('origin=manual&limit=1')
      expect(manual.total).toBe(2)
      expect(manual.items).toHaveLength(1)
      const next = await get('origin=manual&limit=1&offset=1')
      expect(new Set([...keysOf(manual), ...keysOf(next)])).toEqual(new Set(['manual', 'empty']))
      expect((await t.req('GET', '/api/sessions?origin=nowhere')).status).toBe(400)
    })

    it('filters by employee, project and requester', async () => {
      expect(keysOf(await get(`employeeId=${empB}&sort=title`))).toEqual(['trigger', 'empty'])
      // Linked with any role but `mentions`.
      expect(keysOf(await get(`projectId=${payments}`))).toEqual(['chat'])
      expect(keysOf(await get(`projectId=${search}`))).toEqual(['trigger'])
      // A requested_by link, or a run they requested.
      expect(keysOf(await get(`requesterId=${ana}&sort=oldest`))).toEqual(['chat', 'sub'])
      expect(keysOf(await get(`requesterId=${bob}`))).toEqual(['trigger'])
      expect((await get('projectId=pro_00000000000000000000000000')).total).toBe(0)
    })

    it('combines filters', async () => {
      expect(keysOf(await get(`requesterId=${ana}&origin=session`))).toEqual(['sub'])
      expect(keysOf(await get(`requesterId=${ana}&projectId=${payments}`))).toEqual(['chat'])
      expect((await get(`requesterId=${bob}&projectId=${payments}`)).total).toBe(0)
      expect((await get(`employeeId=${empA}&projectId=${search}`)).total).toBe(0)
      expect(keysOf(await get(`employeeId=${empB}&origin=trigger&text=pipeline`))).toEqual(['trigger'])
    })

    it('sorts by recent activity by default, newest, oldest and title', async () => {
      const def = keysOf(await get(`employeeId=${empB}`))
      expect(def).toEqual(['empty', 'trigger'])
      // Touching a session moves it to the top of "recent activity", not of "newest".
      await sleep(3)
      await t.a.services.sessions.update(ids.trigger!, { document: 'updated' })
      expect(keysOf(await get(`employeeId=${empB}`))).toEqual(['trigger', 'empty'])
      expect(keysOf(await get(`employeeId=${empB}&sort=newest`))).toEqual(['empty', 'trigger'])
      expect(keysOf(await get(`employeeId=${empB}&sort=oldest`))).toEqual(['trigger', 'empty'])
      const titles = (await get('sort=title&limit=100')).items.map((x) => x.session.data.title)
      expect(titles).toEqual([...titles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
      expect((await t.req('GET', '/api/sessions?sort=random')).status).toBe(400)
    })

    it('returns the row details: last activity, requester and project', async () => {
      const row = (await get(`projectId=${payments}`)).items[0]
      expect(row).toMatchObject({
        requester: { id: ana, name: 'Ana Example' },
        project: { id: payments, name: 'Payments' },
        startedFrom: 'chat',
        runState: 'queued',
      })
      expect(Date.parse(row.lastActivityAt)).toBeGreaterThanOrEqual(Date.parse(row.session.updatedAt))
      const manual = (await get('origin=manual&sort=oldest')).items[0]
      expect(manual.session.id).toBe(ids.manual)
      expect(manual.project).toBeUndefined()
      expect(manual.requester).toBeUndefined()
    })

    it('keeps the visibility rules: viewers may list, anonymous callers may not', async () => {
      const viewer = (await t.a.services.directory.contacts.create({ name: 'Vic Viewer', kind: 'person', access: 'viewer' })).id
      const seen = await t.req('GET', `/api/sessions?projectId=${payments}`, undefined, await t.as(viewer))
      expect(seen.status).toBe(200)
      expect(seen.body.items).toHaveLength(1)
      expect((await t.req('GET', '/api/sessions', undefined, { authorization: '' })).status).toBe(401)
    })
  })
}

describeList(memoryBackend, '')
describeList(DATABASE_URL && REDIS_URL ? realBackend(DATABASE_URL, REDIS_URL) : null, 'set DATABASE_URL and REDIS_URL to run')
