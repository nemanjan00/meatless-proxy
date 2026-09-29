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
      })
      const res = await t.a.app.request(url, {
        method,
        headers: { 'content-type': 'application/json' },
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
    const list = await t.req('GET', `/api/sessions?employeeId=${employeeId}&status=active,waiting`)
    const row = list.body.items.find((x: any) => x.session.id === routerId)
    expect(row).toMatchObject({ employee: { id: employeeId, name: 'Meatless' }, runState: 'completed', children: 0 })
    expect(row.tokens.calls).toBeGreaterThan(0)

    const detail = await t.req('GET', `/api/sessions/${routerId}`)
    expect(detail.body).toMatchObject({ session: { id: routerId }, employee: { name: 'Meatless' }, activeRun: null })
    expect(detail.body.checklist?.data.items ?? []).toEqual([])
    expect(detail.body.tokens.total).toBeGreaterThan(0)

    const history = await t.req('GET', `/api/sessions/${routerId}/history`)
    expect(history.body[0]).toMatchObject({ kind: 'system', parent: null })
    const tree = await t.req('GET', `/api/sessions/${routerId}/tree`)
    expect(tree.body).toMatchObject({ id: routerId, origin: 'root', children: [], employee: { name: 'Meatless' } })

    const runs = await t.req('GET', `/api/sessions/${routerId}/runs`)
    expect(runs.body[0].data).toMatchObject({ state: 'completed', mode: 'ephemeral' })
    const runId = runs.body[0].id
    const entryTree = await t.req('GET', `/api/sessions/${routerId}/entry-tree`)
    expect(entryTree.body.runs.map((r: any) => r.id)).toContain(runId)
    // The ephemeral run's entries are in the entry tree, but not in the committed history.
    expect(entryTree.body.entries.length).toBeGreaterThan(history.body.length)

    const runHistory = await t.req('GET', `/api/runs/${runId}/history`)
    expect(runHistory.body.map((e: any) => e.kind)).toEqual(['system', 'event', 'assistant'])
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
    expect(tree.body.children.map((c: any) => [c.id, c.origin])).toEqual([[fork.body.id, 'fork']])
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
      trigger: { data: { source: 'chat', type: 'message.posted' } },
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
      author: { type: 'person', name: 'Web user' },
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
    expect(msgs.body[0].data.replyCount).toBe(1)
    const thread = await t.req('GET', `/api/chat/threads/${root.body.id}`)
    expect(thread.body.root.id).toBe(root.body.id)
    expect(thread.body.replies.map((m: any) => m.data.text)).toEqual(['Never mind'])

    const session = await t.a.services.sessions.create({ employeeId, title: 'Incident helper', toolset: [] })
    const added = await t.req('POST', `/api/chat/channels/${ch.body.id}/members`, { type: 'session', id: session.id })
    expect(added.body.data.members.map((m: any) => m.type)).toEqual(['employee', 'session'])
    expect(added.body.data.members[1].label).toBe('@meatless#incident-helper')

    const channels = await t.req('GET', '/api/chat/channels')
    const inc = channels.body.find((c: any) => c.channel.id === ch.body.id)
    expect(inc.messages).toBe(2)
    expect(inc.lastMessageAt).toBeTruthy()
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
    expect(w.body).toMatchObject({ path: '/notes/a.md', content: '# A', version: 1 })
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

describe('web contact', () => {
  it('uses x-mp-contact as the author when given', async () => {
    const contact = (await t.req('POST', '/api/records/contact', { data: { name: 'Di Example', kind: 'person' } })).body
    const m = await t.req(
      'POST',
      `/api/chat/channels/${requestsId}/messages`,
      { text: 'from Di' },
      { 'x-mp-contact': contact.id },
    )
    expect(m.body.data.author).toEqual({ type: 'person', id: contact.id, name: 'Di Example' })
    expect(
      (await t.req('POST', `/api/chat/channels/${requestsId}/messages`, { text: 'x' }, { 'x-mp-contact': 'con_nope' })).status,
    ).toBe(400)
    await quiet(t)
  })
})
