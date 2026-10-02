import { ROUTES, buildPath } from '@mp/api'
import { callTools, reply, type ModelRequest } from '@mp/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GLOBAL_PAUSE_REASON } from '../src/control.ts'
import { OPENSSH_KEY_HEADER } from '../src/ssh.ts'
import { testApp, until, type TestApp } from './helpers.ts'
import { quiet } from './scenarios.ts'

let t: TestApp
let employeeId: string
let routerId: string
let requestsId: string

beforeAll(async () => {
  t = await testApp({
    script: (req: ModelRequest) => {
      const last = req.messages.at(-1)!
      if (last.role === 'tool') return reply('done with tools')
      if ((last.content ?? '').includes('USE A TOOL')) return callTools([{ name: 'checklist.show', args: {} }])
      return reply(`echo: ${(last.content ?? '').slice(-40)}`)
    },
  })
  const s = t.a.services
  employeeId = (await s.directory.employees.byHandle('meatless'))!.id
  routerId = (await s.routerSessionFor())!
  requestsId = (await s.chat.channelByName('requests'))!.id
})
afterAll(async () => {
  await t.close()
})

describe('routes', () => {
  it('implements every route of @mp/api', async () => {
    const missing: string[] = []
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const url = buildPath(path, {
        kind: 'contact',
        id: 'con_00000000000000000000000000',
        employeeId: 'emp_00000000000000000000000000',
        name: 'slack',
        action: 'add-trigger',
        contactId: 'con_00000000000000000000000000',
        triggerId: 'trg_00000000000000000000000000',
        projectId: '1',
        suggestionId: 'csg_00000000000000000000000000',
      })
      const res = await t.a.app.request(url, {
        method,
        headers: { 'content-type': 'application/json', ...(await t.admin()).headers },
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
      })
      const body = (await res.text()) || '{}'
      let msg = ''
      try {
        msg = JSON.parse(body)?.error?.message ?? ''
      } catch {}
      if (msg === 'route not found' || msg.startsWith('no route')) missing.push(`${name} ${method} ${path}`)
      expect(res.status, `${name} must not crash`).not.toBe(500)
    }
    expect(missing).toEqual([])
  })

  it('health and readiness', async () => {
    expect((await t.req('GET', '/healthz')).body).toMatchObject({ ok: true })
    const ready = await t.req('GET', '/readyz')
    expect(ready.status).toBe(200)
    expect(ready.body).toMatchObject({ ok: true, checks: { database: true, queue: true, migrations: true } })
  })

  it('unknown API paths are 404 with the error shape', async () => {
    const r = await t.req('GET', '/api/nope')
    expect(r.status).toBe(404)
    expect(r.body.error).toMatchObject({ code: 'not_found' })
  })
})

describe('records', () => {
  it('lists kinds with schemas, hiding secrets and tokens', async () => {
    const r = await t.req('GET', '/api/kinds')
    const kinds = r.body.map((k: any) => k.kind)
    expect(kinds).toEqual(
      expect.arrayContaining(['contact', 'employee', 'project', 'session', 'run', 'event', 'trigger', 'channel', 'message']),
    )
    expect(kinds).not.toContain('secret')
    expect(kinds).not.toContain('mcp_token')
    const employee = r.body.find((k: any) => k.kind === 'employee')
    expect(employee.extensions.map((f: any) => f.name)).toEqual(expect.arrayContaining(['sshPublicKey']))
    expect((await t.req('GET', '/api/records/secret')).status).toBe(404)
  })

  it('creates, reads, updates with CAS, lists, revises and deletes', async () => {
    const created = await t.req('POST', '/api/records/contact', {
      data: { name: 'Ana Example', kind: 'person', email: 'ana@example.com' },
    })
    expect(created.status).toBe(201)
    const c = created.body
    expect(c).toMatchObject({ kind: 'contact', version: 1, key: null, data: { name: 'Ana Example' } })
    expect((await t.req('GET', `/api/records/contact/${c.id}`)).body.id).toBe(c.id)

    const updated = await t.req('PATCH', `/api/records/contact/${c.id}`, { data: { role: 'Engineer', email: null }, version: 1 })
    expect(updated.status).toBe(200)
    expect(updated.body.version).toBe(2)
    expect(updated.body.data.role).toBe('Engineer')
    expect(updated.body.data).not.toHaveProperty('email')

    const stale = await t.req('PATCH', `/api/records/contact/${c.id}`, { data: { role: 'CTO' }, version: 1 })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('conflict')
    expect(stale.body.error.details.current.version).toBe(2)

    const list = await t.req('GET', `/api/records/contact?text=Ana&limit=5`)
    expect(list.body.total).toBeGreaterThanOrEqual(1)
    expect(list.body.items.some((x: any) => x.id === c.id)).toBe(true)
    const where = encodeURIComponent(JSON.stringify({ role: 'Engineer' }))
    expect((await t.req('GET', `/api/records/contact?where=${where}`)).body.items.map((x: any) => x.id)).toEqual([c.id])
    expect((await t.req('GET', '/api/records/contact?where=notjson')).status).toBe(400)
    expect((await t.req('GET', '/api/records/contact?limit=-1')).status).toBe(400)

    const revs = await t.req('GET', `/api/records/contact/${c.id}/revisions`)
    expect(revs.body.map((r: any) => r.op)).toEqual(['create', 'update'])
    expect(revs.body[0].actor).toMatchObject({ type: 'contact' })

    expect((await t.req('DELETE', `/api/records/contact/${c.id}?version=1`)).status).toBe(409)
    expect((await t.req('DELETE', `/api/records/contact/${c.id}`)).status).toBe(204)
    expect((await t.req('GET', `/api/records/contact/${c.id}`)).status).toBe(404)
  })

  it('validates against the schema (422) and rejects bad bodies (400) and duplicate keys (409)', async () => {
    const bad = await t.req('POST', '/api/records/project', { data: { name: 42 } })
    expect(bad.status).toBe(422)
    expect(bad.body.error.code).toBe('validation')
    expect(bad.body.error.details.issues.length).toBeGreaterThan(0)
    expect((await t.req('POST', '/api/records/project', 'not json')).status).toBe(400)
    expect((await t.req('POST', '/api/records/project', { nodata: true })).status).toBe(400)
    expect((await t.req('POST', '/api/records/nokind', { data: {} })).status).toBe(404)
    const a = await t.req('POST', '/api/records/project', { data: { name: 'Keyed' }, key: 'keyed-1' })
    expect(a.status).toBe(201)
    const b = await t.req('POST', '/api/records/project', { data: { name: 'Keyed again' }, key: 'keyed-1' })
    expect(b.status).toBe(409)
  })

  it('links, backlinks and link deletion', async () => {
    const p = (await t.req('POST', '/api/records/project', { data: { name: 'Billing' } })).body
    const c = (await t.req('POST', '/api/records/contact', { data: { name: 'Bo Example', kind: 'person' } })).body
    const link = await t.req('POST', `/api/records/contact/${c.id}/links`, { to: { kind: 'project', id: p.id }, role: 'owner' })
    expect(link.status).toBe(201)
    expect(link.body).toMatchObject({ from: { kind: 'contact', id: c.id }, to: { kind: 'project', id: p.id }, role: 'owner' })
    const fromProject = await t.req('GET', `/api/records/project/${p.id}/links?direction=in`)
    expect(fromProject.body).toEqual([
      expect.objectContaining({
        link: expect.objectContaining({ id: link.body.id }),
        record: expect.objectContaining({ id: c.id }),
      }),
    ])
    expect((await t.req('GET', `/api/records/project/${p.id}/links?direction=sideways`)).status).toBe(400)

    await t.req('POST', '/api/records/doc', { data: { title: 'Notes', body: `Ask [[contact:${c.id}]] about it.` } })
    const back = await t.req('GET', `/api/records/contact/${c.id}/backlinks`)
    expect(back.body.map((r: any) => r.data.title)).toEqual(['Notes'])

    expect((await t.req('DELETE', `/api/links/${link.body.id}`)).status).toBe(204)
    expect((await t.req('DELETE', `/api/links/${link.body.id}`)).status).toBe(404)
  })
})

describe('sessions and runs', () => {
  it('lists sessions and shows detail, history, tree, entry tree, runs and entries', async () => {
    const post = await t.req('POST', `/api/chat/channels/${requestsId}/messages`, { text: 'hello router' })
    expect(post.status).toBe(201)
    await quiet(t)
    // The request runs on the router context itself, as an ephemeral run.
    const reqId = routerId
    const list = await t.req('GET', `/api/sessions?employeeId=${employeeId}&status=active,waiting`)
    const row = list.body.items.find((x: any) => x.session.id === reqId)
    expect(row).toMatchObject({ employee: { id: employeeId, name: 'Meatless' }, runState: 'completed' })
    expect(row.tokens.calls).toBeGreaterThan(0)

    const detail = await t.req('GET', `/api/sessions/${reqId}`)
    expect(detail.body).toMatchObject({ session: { id: reqId }, employee: { name: 'Meatless' }, activeRun: null })
    expect(detail.body.checklist?.data.items ?? []).toEqual([])
    expect(detail.body.tokens.total).toBeGreaterThan(0)

    const history = await t.req('GET', `/api/sessions/${reqId}/history`)
    expect(history.body[0]).toMatchObject({ kind: 'system', parent: null })
    // An ephemeral run that keeps only its one-line decision: prompt, router instructions, decision.
    expect(history.body.map((e: any) => e.kind)).toEqual(['system', 'system', 'summary'])
    const tree = await t.req('GET', `/api/sessions/${routerId}/tree`)
    expect(tree.body).toMatchObject({ id: routerId, origin: 'root', employee: { name: 'Meatless' } })

    const runs = await t.req('GET', `/api/sessions/${reqId}/runs`)
    expect(runs.body[0].data).toMatchObject({ state: 'completed', mode: 'ephemeral' })
    const runId = runs.body[0].id
    const entryTree = await t.req('GET', `/api/sessions/${reqId}/entry-tree`)
    expect(entryTree.body.runs.map((r: any) => r.id)).toContain(runId)
    // The run's exploration is in the entry tree, but not in the committed history.
    expect(entryTree.body.entries.length).toBeGreaterThan(history.body.length)

    const runHistory = await t.req('GET', `/api/runs/${runId}/history`)
    expect(runHistory.body.map((e: any) => e.kind)).toEqual([
      'system',
      'system',
      // The employee's current projects (the run's input, after the cached history).
      'system',
      'event',
      'assistant',
      'tool_result',
      'assistant',
    ])
    const children = await t.req('GET', `/api/entries/${history.body[0].id}/children`)
    expect(children.body.length).toBeGreaterThanOrEqual(1)
    expect((await t.req('GET', '/api/entries/ent_missing/children')).status).toBe(404)
    expect((await t.req('GET', `/api/runs/${runId}`)).body.data.result.output).toContain('echo')
    expect((await t.req('GET', '/api/sessions/ses_nope')).status).toBe(404)
  })

  it('forks a session and sends it a message, which starts a run', async () => {
    const fork = await t.req('POST', `/api/sessions/${routerId}/fork`, { title: 'A fork from the UI' })
    expect(fork.status).toBe(201)
    expect(fork.body.data).toMatchObject({ title: 'A fork from the UI', parent: { sessionId: routerId }, depth: 1 })
    const sent = await t.req('POST', `/api/sessions/${fork.body.id}/message`, { text: 'please answer' })
    expect(sent.status).toBe(200)
    expect(sent.body).toMatchObject({ inbox: false, event: { data: { source: 'ui', routed: true } } })
    expect(sent.body.runId).toMatch(/^run_/)
    await quiet(t)
    const run = await t.req('GET', `/api/runs/${sent.body.runId}`)
    expect(run.body.data).toMatchObject({ state: 'completed', mode: 'continuing' })
    const ev = await t.req('GET', `/api/events/${sent.body.event.id}`)
    expect(ev.body.deliveries[0].data).toMatchObject({ sessionId: fork.body.id, rule: 'session_tag', runId: sent.body.runId })
    expect((await t.req('POST', `/api/sessions/${fork.body.id}/message`, {})).status).toBe(400)
    const tree = await t.req('GET', `/api/sessions/${routerId}/tree`)
    expect(tree.body.children.map((c: any) => [c.id, c.origin])).toContainEqual([fork.body.id, 'fork'])
    const lineage = await t.req('GET', `/api/lineage/${fork.body.id}`)
    expect(lineage.body.focus).toBe(fork.body.id)
    expect(lineage.body.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: routerId, to: fork.body.id, type: 'forked' })]),
    )
    expect((await t.req('GET', '/api/lineage/xyz_123')).status).toBe(404)
  })

  it('pauses, resumes and cancels runs', async () => {
    const s = t.a.services
    const session = await s.sessions.create({
      employeeId,
      title: 'Manual',
      toolset: [],
      entries: [{ kind: 'user', content: { text: 'hi' } }],
    })
    const run = await s.sessions.createRun({ sessionId: session.id, cause: { type: 'manual' } })
    const paused = await t.req('POST', `/api/runs/${run.id}/pause`, { reason: 'hold on' })
    expect(paused.body.data).toMatchObject({ state: 'paused', pauseReason: 'hold on' })
    const resumed = await t.req('POST', `/api/runs/${run.id}/resume`, {})
    expect(resumed.body.data.state).toBe('queued')
    await quiet(t)
    expect((await s.sessions.getRun(run.id))!.data.state).toBe('completed')
    expect((await t.req('POST', `/api/runs/${run.id}/cancel`, {})).status).toBe(409)

    const run2 = await s.sessions.createRun({ sessionId: session.id, cause: { type: 'manual' } })
    const cancelled = await t.req('POST', `/api/runs/${run2.id}/cancel`, {})
    expect(cancelled.body.data).toMatchObject({ state: 'cancelled', result: { status: 'cancelled' } })
    expect((await t.req('POST', `/api/runs/${run2.id}/resume`, {})).status).toBe(409)
    expect((await t.req('POST', '/api/runs/run_nope/pause', {})).status).toBe(404)
  })

  it('lists subscriptions in the API shape', async () => {
    const s = t.a.services
    await s.events.subscriptions.subscribe(routerId, { system: 'linear', id: 'PAY-1' }, { primary: true })
    const r = await t.req('GET', `/api/subscriptions?sessionId=${routerId}`)
    expect(r.body).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ subject: { system: 'linear', ref: 'PAY-1' }, primary: true, active: true }),
      }),
    ])
    expect((await t.req('GET', '/api/subscriptions')).body.length).toBeGreaterThanOrEqual(1)
  })

  it('gives subscriptions what the UI needs to link them', async () => {
    const s = t.a.services
    const session = await s.sessions.create({ employeeId, title: 'Links', toolset: [], entries: [] })
    const root = await t.req('POST', `/api/chat/channels/${requestsId}/messages`, { text: 'lunch anyone?' })
    await s.events.subscriptions.subscribe(session.id, { system: 'mp', id: root.body.id }, { primary: true })
    await s.events.subscriptions.subscribe(session.id, { system: 'gitlab', id: 'acme/app!4' }, { primary: true })
    await s.events.subscriptions.subscribe(session.id, { system: 'local-git', id: 'nope/mp/x' }, { primary: true })
    const r = await t.req('GET', `/api/subscriptions?sessionId=${session.id}`)
    const subject = (system: string) => r.body.find((x: any) => x.data.subject.system === system).data.subject
    expect(subject('mp')).toEqual({ system: 'mp', ref: root.body.id, title: 'lunch anyone?', channelId: requestsId })
    expect(subject('gitlab')).toEqual({ system: 'gitlab', ref: 'acme/app!4', baseUrl: 'https://gitlab.com' })
    // No project hosts that repository: nothing to link to.
    expect(subject('local-git')).toEqual({ system: 'local-git', ref: 'nope/mp/x' })

    await s.secrets.set('GITLAB_BASE_URL', 'https://git.example.com/', { type: 'employee', id: employeeId })
    const again = await t.req('GET', `/api/subscriptions?sessionId=${session.id}`)
    expect(again.body.find((x: any) => x.data.subject.system === 'gitlab').data.subject.baseUrl).toBe('https://git.example.com')
    await s.secrets.delete('GITLAB_BASE_URL', { type: 'employee', id: employeeId })
  })
})

describe('now, inbox and control', () => {
  it('pause-all pauses runs at the next model call and resume-all re-queues them', async () => {
    const s = t.a.services
    expect((await t.req('GET', '/api/control')).body).toEqual({ paused: false })
    const p = await t.req('POST', '/api/control/pause-all', {})
    expect(p.body).toMatchObject({ paused: true, pausedBy: { type: 'contact' } })
    await t.req('POST', `/api/chat/channels/${requestsId}/messages`, { text: 'while paused' })
    const run = await until(
      async () => (await s.sessions.runs({ state: 'paused' })).find((r) => r.data.pauseReason === GLOBAL_PAUSE_REASON),
      'a paused run',
    )
    const now = await t.req('GET', '/api/now')
    expect(now.body.paused).toBe(true)
    expect(now.body.counts.paused).toBeGreaterThanOrEqual(1)
    expect(now.body.items.find((i: any) => i.run.id === run.id)).toMatchObject({
      step: { kind: 'paused' },
      employee: { name: 'Meatless' },
    })
    const inbox = await t.req('GET', '/api/inbox')
    expect(inbox.body.find((i: any) => i.runId === run.id)).toMatchObject({ type: 'paused_run', read: false })

    const r = await t.req('POST', '/api/control/resume-all', {})
    expect(r.body).toEqual({ paused: false })
    await quiet(t)
    expect((await s.sessions.getRun(run.id))!.data.state).toBe('completed')
  })
})

describe('events and triggers', () => {
  it('ingests webhooks with dedupe, lists and filters events', async () => {
    const body = {
      source: 'webhook',
      type: 'build.failed',
      dedupeKey: 'ci:42',
      subject: { system: 'ci', ref: 'build-42' },
      payload: { job: 42 },
    }
    const a = await t.req('POST', '/api/events', body)
    expect(a.status).toBe(201)
    expect(a.body.created).toBe(true)
    expect(a.body.event.data).toMatchObject({ source: 'webhook', dedupeKey: 'ci:42', subject: { system: 'ci', ref: 'build-42' } })
    const b = await t.req('POST', '/api/events', body)
    expect(b.status).toBe(200)
    expect(b.body).toMatchObject({ created: false, event: { id: a.body.event.id } })
    expect((await t.req('POST', '/api/events', { type: 'x', payload: {} })).status).toBe(400)
    await quiet(t)

    const list = await t.req('GET', '/api/events?source=webhook')
    expect(list.body.items.map((e: any) => e.id)).toEqual([a.body.event.id])
    expect(list.body.items[0].data.routed).toBe(true)
    const unmatched = await t.req('GET', '/api/events?routed=unmatched&source=webhook')
    expect(unmatched.body.total).toBe(1)
    expect((await t.req('GET', '/api/events?subject=ci:build-42')).body.total).toBe(1)
    expect((await t.req('GET', '/api/events?routed=maybe')).status).toBe(400)
    const detail = await t.req('GET', `/api/events/${a.body.event.id}`)
    expect(detail.body.deliveries[0].data).toMatchObject({ rule: 'fallback', sessionId: routerId })
    expect(detail.body.runs.length).toBe(1)
  })

  it('lists triggers with stats', async () => {
    const r = await t.req('GET', '/api/triggers')
    const tr = r.body.find((x: any) => x.trigger.data.name === '#requests: new requests')
    expect(tr).toMatchObject({
      employee: { id: employeeId },
      context: { id: routerId },
      trigger: { data: { source: 'chat', type: 'message.*', fork: false, mode: 'ephemeral' } },
    })
    expect(tr.fires).toBeGreaterThanOrEqual(1)
    expect(tr.recentEvents.length).toBeGreaterThanOrEqual(1)
  })
})

describe('chat', () => {
  it('creates channels, posts, reads threads and adds members', async () => {
    const ch = await t.req('POST', '/api/chat/channels', {
      name: 'Incidents',
      topic: 'Things on fire',
      members: [{ type: 'employee', id: employeeId }],
    })
    expect(ch.status).toBe(201)
    expect(ch.body.data).toMatchObject({ name: 'incidents', archived: false, dm: false, createdBy: { type: 'contact' } })
    expect(ch.body.data.members).toEqual([{ type: 'employee', id: employeeId, label: 'Meatless' }])
    expect((await t.req('POST', '/api/chat/channels', { name: 'incidents' })).status).toBe(409)
    expect((await t.req('POST', '/api/chat/channels', { name: 'Bad name!' })).status).toBe(422)

    const root = await t.req('POST', `/api/chat/channels/${ch.body.id}/messages`, { text: 'Is prod down? @meatless' })
    expect(root.body.data).toMatchObject({
      threadId: null,
      author: { type: 'person', name: 'Admin' },
      tags: [{ type: 'employee', id: employeeId, text: '@meatless' }],
    })
    const replyMsg = await t.req('POST', `/api/chat/channels/${ch.body.id}/messages`, {
      text: 'Never mind',
      threadId: root.body.id,
    })
    expect(replyMsg.body.data.threadId).toBe(root.body.id)
    await quiet(t)

    const msgs = await t.req('GET', `/api/chat/channels/${ch.body.id}/messages`)
    expect(msgs.body.map((m: any) => m.id)).toEqual([root.body.id])
    const thread = await t.req('GET', `/api/chat/threads/${root.body.id}`)
    expect(thread.body.root.id).toBe(root.body.id)
    // The person's reply, and the employee's answer to being tagged, posted where it was asked.
    expect(thread.body.replies.filter((m: any) => m.data.author.type === 'person').map((m: any) => m.data.text)).toEqual([
      'Never mind',
    ])
    // The router context answered: shown as the employee, not as `@meatless#router`.
    expect(thread.body.replies.find((m: any) => m.data.author.type !== 'person').data.author).toEqual({
      type: 'employee',
      id: employeeId,
      name: 'Meatless',
      handle: 'meatless',
    })
    expect(msgs.body[0].data.replyCount).toBeGreaterThanOrEqual(2)

    const session = await t.a.services.sessions.create({ employeeId, title: 'Incident helper', toolset: [] })
    const added = await t.req('POST', `/api/chat/channels/${ch.body.id}/members`, { type: 'session', id: session.id })
    expect(added.body.data.members.map((m: any) => m.type)).toEqual(['employee', 'session'])
    expect(added.body.data.members[1].label).toBe('@meatless#incident-helper')

    const channels = await t.req('GET', '/api/chat/channels')
    const inc = channels.body.find((c: any) => c.channel.id === ch.body.id)
    // The question, the employee's answer, the person's untagged follow-up (it reaches the tagged employee
    // too, docs/execution.md "Follow-ups"), and the scripted model's answer to it.
    expect(inc.messages).toBe(4)
    expect(inc.lastMessageAt).toBeTruthy()
  })
})

describe('everyday chat', () => {
  let otherId: string
  let channelId: string
  const asOther = () => ({ 'x-mp-contact': otherId }) // signed in as Robin (see helpers.ts)

  beforeAll(async () => {
    const other = await t.req('POST', '/api/records/contact', {
      data: { name: 'Robin Tester', kind: 'person', handles: [{ system: 'mp', id: 'robin' }] },
    })
    otherId = other.body.id
    channelId = (await t.req('POST', '/api/chat/channels', { name: 'everyday' })).body.id
  })

  it('tells the UI who it is', async () => {
    const me = await t.req('GET', '/api/me')
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ name: 'Admin', access: 'admin', via: 'token' })
    expect(me.body.contactId).toMatch(/^con_/)
  })

  it('edits and deletes own messages only', async () => {
    const m = await t.req('POST', `/api/chat/channels/${channelId}/messages`, { text: 'frist' })
    const edited = await t.req('PATCH', `/api/chat/messages/${m.body.id}`, { text: 'first' })
    expect(edited.status).toBe(200)
    expect(edited.body.data).toMatchObject({ text: 'first' })
    expect(edited.body.data.editedAt).toBeTruthy()
    expect((await t.req('PATCH', `/api/chat/messages/${m.body.id}`, { text: 'mine now' }, asOther())).status).toBe(403)
    expect((await t.req('DELETE', `/api/chat/messages/${m.body.id}`, undefined, asOther())).status).toBe(403)
    expect((await t.req('PATCH', `/api/chat/messages/${m.body.id}`, {})).status).toBe(400)
    expect((await t.req('PATCH', '/api/chat/messages/msg_00000000000000000000000000', { text: 'x' })).status).toBe(404)
    const deleted = await t.req('DELETE', `/api/chat/messages/${m.body.id}`)
    expect(deleted.status).toBe(200)
    expect(deleted.body.data).toMatchObject({ text: '', deleted: true })
    const msgs = await t.req('GET', `/api/chat/channels/${channelId}/messages`)
    expect(msgs.body.find((x: any) => x.id === m.body.id).data.deleted).toBe(true)
  })

  it('adds and removes reactions, idempotently', async () => {
    const m = await t.req('POST', `/api/chat/channels/${channelId}/messages`, { text: 'ship it?' })
    const a = await t.req('POST', `/api/chat/messages/${m.body.id}/reactions`, { emoji: '✅' })
    expect(a.status).toBe(200)
    await t.req('POST', `/api/chat/messages/${m.body.id}/reactions`, { emoji: '✅' })
    const b = await t.req('POST', `/api/chat/messages/${m.body.id}/reactions`, { emoji: '✅' }, asOther())
    expect(b.body.data.reactions['✅']).toHaveLength(2)
    expect((await t.req('POST', `/api/chat/messages/${m.body.id}/reactions`, {})).status).toBe(400)
    const c = await t.req('DELETE', `/api/chat/messages/${m.body.id}/reactions?emoji=${encodeURIComponent('✅')}`)
    expect(c.body.data.reactions['✅']).toEqual([{ kind: 'contact', id: otherId }])
    const d = await t.req(
      'DELETE',
      `/api/chat/messages/${m.body.id}/reactions?emoji=${encodeURIComponent('✅')}`,
      undefined,
      asOther(),
    )
    expect(d.body.data.reactions).toBeUndefined()
  })

  it('counts unread messages and mentions, and marks them read', async () => {
    await t.req('POST', '/api/chat/read', { scope: channelId })
    // Messages in the same millisecond as the marker count as read.
    await new Promise((r) => setTimeout(r, 5))
    await t.req('POST', `/api/chat/channels/${channelId}/messages`, { text: 'hello' }, asOther())
    await t.req('POST', `/api/chat/channels/${channelId}/messages`, { text: 'ping @admin' }, asOther())
    const unread = await t.req('GET', '/api/chat/unread')
    expect(unread.status).toBe(200)
    expect(unread.body.find((u: any) => u.channelId === channelId)).toMatchObject({ unread: 2, mentions: 1 })
    expect((await t.req('POST', '/api/chat/read', { scope: channelId })).status).toBe(204)
    const after = await t.req('GET', '/api/chat/unread')
    expect(after.body.find((u: any) => u.channelId === channelId)).toMatchObject({ unread: 0, mentions: 0 })
    expect((await t.req('POST', '/api/chat/read', {})).status).toBe(400)
  })

  it('opens one DM per member set and routes it to the employee', async () => {
    const a = await t.req('POST', '/api/chat/dms', { members: [{ kind: 'employee', id: employeeId }] })
    expect(a.status).toBe(201)
    expect(a.body.data.dm).toBe(true)
    expect(a.body.data.members.map((m: any) => m.type).sort()).toEqual(['employee', 'person'])
    const again = await t.req('POST', '/api/chat/dms', { members: [{ kind: 'employee', id: employeeId }] })
    expect(again.status).toBe(200)
    expect(again.body.id).toBe(a.body.id)
    const triggers = await t.req('GET', '/api/triggers')
    expect(triggers.body.filter((x: any) => x.trigger.data.filters?.['payload.channelId'] === a.body.id)).toHaveLength(1)
    const withPerson = await t.req('POST', '/api/chat/dms', { members: [{ kind: 'contact', id: otherId }] })
    expect(withPerson.status).toBe(201)
    expect(withPerson.body.id).not.toBe(a.body.id)
    expect((await t.req('POST', '/api/chat/dms', { members: [] })).status).toBe(400)
  })

  it("routes a person's untagged follow-up to the employee that answered in the thread", async () => {
    const s = t.a.services
    const root = await t.req('POST', `/api/chat/channels/${channelId}/messages`, { text: '@meatless who are you?' })
    await s.chat.post({ channelId, threadId: root.body.id, author: { kind: 'session', id: routerId }, text: 'Meatless.' })
    await t.req(
      'POST',
      `/api/chat/channels/${channelId}/messages`,
      { text: 'which projects?', threadId: root.body.id },
      asOther(),
    )
    const events = await s.records.query<any>('event', {
      where: { type: 'message.replied' },
      orderBy: { field: 'createdAt', dir: 'desc' },
      limit: 5,
    })
    const followUp = events.items.find(
      (e: any) => e.data.payload?.text === 'which projects?' || e.data.text?.includes('which projects?'),
    )
    expect(followUp).toBeTruthy()
    const plan = await s.router.plan(followUp!)
    expect(plan).toContainEqual(
      expect.objectContaining({ sessionId: routerId, reason: 'thread_participant', expectedToAct: true }),
    )
  })

  it('searches by text, author and thread, with channel and thread', async () => {
    const root = await t.req('POST', `/api/chat/channels/${channelId}/messages`, { text: 'the quarterly invoice run' })
    const reply = await t.req(
      'POST',
      `/api/chat/channels/${channelId}/messages`,
      { text: 'invoice run is done', threadId: root.body.id },
      asOther(),
    )
    const hits = await t.req('GET', '/api/chat/search?text=invoice')
    expect(hits.status).toBe(200)
    expect(hits.body.map((h: any) => h.message.id)).toEqual([reply.body.id, root.body.id])
    expect(hits.body[0]).toMatchObject({ channel: { id: channelId, name: 'everyday', dm: false }, threadId: root.body.id })
    expect(hits.body[1].threadId).toBe(root.body.id)
    const byAuthor = await t.req('GET', `/api/chat/search?text=invoice&author=contact:${otherId}`)
    expect(byAuthor.body.map((h: any) => h.message.id)).toEqual([reply.body.id])
    const inThread = await t.req('GET', `/api/chat/search?threadId=${root.body.id}`)
    expect(inThread.body).toHaveLength(2)
  })
})

describe('usage', () => {
  it('totals, breakdowns and series', async () => {
    const totals = await t.req('GET', '/api/usage/totals')
    expect(totals.body.calls).toBeGreaterThan(0)
    expect(totals.body.total).toBe(totals.body.input + totals.body.output)
    const byEmployee = await t.req('GET', '/api/usage/breakdown?groupBy=employee')
    expect(byEmployee.body.rows[0]).toMatchObject({ key: employeeId, label: 'Meatless' })
    const byDay = await t.req('GET', '/api/usage/breakdown?groupBy=day')
    expect(byDay.body.rows.length).toBe(1)
    expect((await t.req('GET', '/api/usage/breakdown?groupBy=nope')).status).toBe(400)
    const series = await t.req('GET', '/api/usage/series?interval=hour&splitBy=model')
    expect(series.body).toMatchObject({ interval: 'hour', splitBy: 'model', keys: [{ key: 'scripted', label: 'scripted' }] })
    expect(series.body.points[0].scripted).toBeGreaterThan(0)
    expect((await t.req('GET', '/api/usage/series?interval=week')).status).toBe(400)
  })
})

describe('files', () => {
  it('writes, reads and lists an employee filesystem with CAS', async () => {
    const w = await t.req('PUT', `/api/files/${employeeId}/content?path=/notes/a.md`, { content: '# A' })
    expect(w.status).toBe(200)
    expect(w.body).toMatchObject({ path: '/notes/a.md', content: '# A' })
    expect(w.body.version).toBeGreaterThan(0)
    expect((await t.req('PUT', `/api/files/${employeeId}/content?path=/notes/a.md`, { content: '# B', version: 7 })).status).toBe(
      409,
    )
    expect((await t.req('GET', `/api/files/${employeeId}/content?path=/notes/a.md`)).body.content).toBe('# A')
    const ls = await t.req('GET', `/api/files/${employeeId}?dir=/notes`)
    expect(ls.body).toEqual([expect.objectContaining({ path: '/notes/a.md', name: 'a.md', type: 'file' })])
    expect((await t.req('GET', `/api/files/${employeeId}/content`)).status).toBe(400)
    expect((await t.req('GET', '/api/files/emp_nope')).status).toBe(404)
  })
})

describe('secrets', () => {
  it('stores values write-only and never returns them', async () => {
    const put = await t.req('PUT', '/api/secrets', {
      name: 'LINEAR_TOKEN',
      value: 'lin-test-value-123',
      scope: { type: 'global' },
    })
    expect(put.status).toBe(200)
    expect(put.body).toMatchObject({ name: 'LINEAR_TOKEN', scope: { type: 'global' } })
    await t.req('PUT', '/api/secrets', {
      name: 'DEPLOY_KEY',
      value: 'deploy-test-value-456',
      scope: { type: 'tool', id: 'mcp.github.push' },
    })
    const list = await t.req('GET', '/api/secrets')
    const text = JSON.stringify(list.body)
    expect(text).not.toContain('lin-test-value-123')
    expect(text).not.toContain('deploy-test-value-456')
    expect(list.body.map((x: any) => x.name)).toEqual(expect.arrayContaining(['LINEAR_TOKEN', 'DEPLOY_KEY', 'SSH_PRIVATE_KEY']))
    expect(list.body.find((x: any) => x.name === 'DEPLOY_KEY').scope).toEqual({ type: 'tool', id: 'mcp.github.push' })
    // Neither the record API nor revisions leak values.
    const all = JSON.stringify((await t.req('GET', '/api/kinds')).body)
    expect(all).not.toContain('lin-test-value-123')
    expect((await t.req('PUT', '/api/secrets', { name: 'X', scope: { type: 'global' } })).status).toBe(400)
    expect((await t.req('PUT', '/api/secrets', { name: 'X', value: 'v', scope: { type: 'employee' } })).status).toBe(400)
    expect((await t.req('DELETE', '/api/secrets?name=LINEAR_TOKEN&scopeType=global')).status).toBe(204)
    expect((await t.req('GET', '/api/secrets')).body.map((x: any) => x.name)).not.toContain('LINEAR_TOKEN')
  })

  it('every employee has an SSH keypair: public key on the record, private key a secret', async () => {
    const e = await t.req('GET', `/api/records/employee/${employeeId}`)
    expect(e.body.data.sshPublicKey).toMatch(/^ssh-ed25519 AAAA\S+ meatless@meatless-proxy$/)
    const secrets = (await t.req('GET', '/api/secrets')).body
    expect(secrets).toEqual(
      expect.arrayContaining([
        {
          name: 'SSH_PRIVATE_KEY',
          scope: { type: 'employee', id: employeeId },
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      ]),
    )
    expect(JSON.stringify(e.body)).not.toContain(OPENSSH_KEY_HEADER)
    const rotated = await t.req('POST', `/api/employees/${employeeId}/ssh-key`, {})
    expect(rotated.body.publicKey).toMatch(/^ssh-ed25519 /)
    expect(rotated.body.publicKey).not.toBe(e.body.data.sshPublicKey)
    // An employee created any other way gets one too.
    const other = await t.a.services.directory.employees.create({ name: 'Billing Bot' })
    await until(async () => (await t.a.services.directory.employees.get(other.id))?.data.sshPublicKey, 'the new key')
  })
})

describe('MCP tokens', () => {
  it('creates a token once and stores only its hash', async () => {
    const contact = (await t.req('POST', '/api/records/contact', { data: { name: 'Cy Example', kind: 'person' } })).body
    const r = await t.req('POST', '/api/mcp/tokens', { contactId: contact.id, name: 'laptop' })
    expect(r.status).toBe(201)
    expect(r.body.token).toMatch(/^mpt_/)
    const stored = await t.a.services.records.query('mcp_token', {})
    expect(JSON.stringify(stored.items)).not.toContain(r.body.token)
    expect((await t.req('POST', '/api/mcp/tokens', { contactId: 'con_nope' })).status).toBe(404)
  })
})

describe('the signed-in person', () => {
  it('is the author, and an x-mp-contact header changes nothing', async () => {
    const contact = (await t.req('POST', '/api/records/contact', { data: { name: 'Di Example', kind: 'person' } })).body
    const di = await t.as(contact.id)
    const m = await t.req('POST', `/api/chat/channels/${requestsId}/messages`, { text: 'from Di' }, di)
    expect(m.body.data.author).toEqual({ type: 'person', id: contact.id, name: 'Di Example' })
    const other = (await t.req('POST', '/api/records/contact', { data: { name: 'Ed Example', kind: 'person' } })).body
    const raw = await t.a.app.request(`/api/chat/channels/${requestsId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...di, 'x-mp-contact': other.id },
      body: JSON.stringify({ text: 'still Di' }),
    })
    expect(((await raw.json()) as any).data.author.id).toBe(contact.id)
    await quiet(t)
  })
})
