import { memoryLogger } from '@mp/core'
import type { ToolContext } from '@mp/tools'
import { afterEach, describe, expect, it } from 'vitest'
import { decide, eventText, signBody } from '../src/webhooks/service.ts'
import { testApp, type TestApp } from './helpers.ts'

/** An employee's own webhooks: a URL other systems post to, checked, mapped, and routed by its rules. */

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function make() {
  const t = await testApp({ workers: false })
  apps.push(t)
  const s = t.a.services
  const employee = (await s.directory.employees.byHandle('meatless'))!
  /** Posts to a webhook as an outside system would: no session, its own headers. */
  const deliver = (id: string, body: unknown, headers: Record<string, string> = {}) =>
    t.req('POST', `/webhooks/custom/${id}`, typeof body === 'string' ? body : JSON.stringify(body), {
      authorization: '',
      ...headers,
    })
  const plan = async (eventId: string) =>
    (await s.router.plan((await s.events.get(eventId))!)).map((d) => [d.sessionId, d.reason, d.expectedToAct, d.trusted])
  return { t, s, employee, deliver, plan, router: employee.data.routerSessionId! }
}

describe('employee webhooks', () => {
  it('are made by admins, with a secret shown once, and checked on every delivery', async () => {
    const { t, s, employee, deliver, plan, router } = await make()
    const created = await t.req('POST', '/api/webhooks', {
      employeeId: employee.id,
      name: 'sentry',
      about: 'Errors from the web app',
      mapping: { type: 'action', subject: 'data.issue.id', text: 'Sentry {action}: {data.issue.title}' },
    })
    expect(created.status).toBe(201)
    const { webhook, secret } = created.body
    expect(secret).toMatch(/^[0-9a-f]{48}$/)
    expect(webhook).toMatchObject({ name: 'sentry', url: `/webhooks/custom/${webhook.id}`, auth: { type: 'token' } })
    expect(JSON.stringify((await t.req('GET', `/api/webhooks?employeeId=${employee.id}`)).body)).not.toContain(secret)
    // Not for members, and not through the generic records API.
    const bo = await s.directory.contacts.create({ name: 'Bo Example', kind: 'person', access: 'member' })
    expect((await t.req('GET', '/api/webhooks', undefined, { 'x-mp-contact': bo.id })).status).toBe(403)
    expect((await t.req('GET', `/api/records/webhook/${webhook.id}`)).status).toBe(404)

    const issue = { action: 'created', data: { issue: { id: 'ISS-1', title: 'TypeError in checkout' } } }
    expect((await deliver(webhook.id, issue)).status).toBe(404)
    expect((await deliver(webhook.id, issue, { 'x-webhook-token': 'wrong' })).status).toBe(404)
    expect((await deliver('whk_nope', issue, { 'x-webhook-token': secret })).status).toBe(404)
    const ok = await deliver(webhook.id, issue, { 'x-webhook-token': secret })
    expect(ok.status).toBe(202)
    const event = (await s.events.get(ok.body.eventId))!
    expect(event.data).toMatchObject({
      source: 'webhook:sentry',
      type: 'created',
      employeeId: employee.id,
      subject: { system: 'webhook:sentry', id: 'ISS-1' },
      text: 'Sentry created: TypeError in checkout',
    })
    // No rule: the employee's router, as untrusted input.
    expect(await plan(event.id)).toEqual([[router, 'fallback', true, false]])
    expect((await t.req('GET', `/api/webhooks?employeeId=${employee.id}`)).body[0]).toMatchObject({ received: 1 })

    // A new secret: the old one stops working.
    const rotated = (await t.req('POST', `/api/webhooks/${webhook.id}/rotate`)).body
    expect((await deliver(webhook.id, { action: 'x' }, { 'x-webhook-token': secret })).status).toBe(404)
    expect((await deliver(webhook.id, { action: 'x' }, { 'x-webhook-token': rotated.secret })).status).toBe(202)
    // Off: nothing gets in.
    await t.req('PATCH', `/api/webhooks/${webhook.id}`, { enabled: false })
    expect((await deliver(webhook.id, { action: 'y' }, { 'x-webhook-token': rotated.secret })).status).toBe(404)
    // Removed with its secret.
    expect((await t.req('DELETE', `/api/webhooks/${webhook.id}`)).status).toBe(204)
    expect((await s.secrets.list()).some((m) => m.name === 'WEBHOOK_SENTRY_SECRET')).toBe(false)
  })

  it('send each event where its first matching rule says: nowhere, a session, or the router', async () => {
    const { t, s, employee, deliver, plan, router } = await make()
    const billing = await s.sessions.create({ employeeId: employee.id, title: 'Billing watch' })
    const { webhook, secret } = (
      await t.req('POST', '/api/webhooks', {
        employeeId: employee.id,
        name: 'stripe',
        auth: { type: 'hmac', header: 'Stripe-Signature' },
        mapping: { type: 'type', subject: 'data.object.customer' },
        rules: [
          { type: 'invoice.paid', action: { type: 'ignore' } },
          { type: 'charge.*', field: 'data.object.status', equals: 'failed', action: { type: 'session', sessionId: billing.id } },
          { field: 'livemode', equals: 'false', action: { type: 'ignore' } },
        ],
      })
    ).body
    const send = (body: object) => {
      const raw = JSON.stringify(body)
      return deliver(webhook.id, raw, { 'stripe-signature': signBody(secret, raw) })
    }
    // A signature of another body is refused.
    expect((await deliver(webhook.id, '{"type":"a"}', { 'stripe-signature': signBody(secret, '{"type":"b"}') })).status).toBe(404)

    const paid = await send({ type: 'invoice.paid', livemode: true, data: { object: { customer: 'cus_1' } } })
    expect(paid.body).toEqual({ ignored: true, rule: 1 })
    const failed = await send({
      type: 'charge.failed',
      livemode: true,
      data: { object: { customer: 'cus_1', status: 'failed' } },
    })
    expect(await plan(failed.body.eventId)).toEqual([[billing.id, 'trigger', true, false]])
    expect((await send({ type: 'charge.refunded', livemode: false, data: { object: {} } })).body.ignored).toBe(true)
    const other = await send({ type: 'customer.updated', livemode: true, data: { object: { customer: 'cus_2' } } })
    expect(await plan(other.body.eventId)).toEqual([[router, 'fallback', true, false]])
    // The session done: its rule's events go to the router instead.
    await s.records.update('session', billing.id, { status: 'done' })
    const again = await send({ type: 'charge.failed', livemode: true, data: { object: { customer: 'cus_3', status: 'failed' } } })
    expect(await plan(again.body.eventId)).toEqual([[router, 'fallback', true, false]])
    expect((await t.req('GET', `/api/webhooks?employeeId=${employee.id}`)).body[0]).toMatchObject({ received: 3, ignored: 2 })
  })

  it('refuse bad input, and a name an employee already has', async () => {
    const { t, employee } = await make()
    const add = (body: object) => t.req('POST', '/api/webhooks', { employeeId: employee.id, name: 'ci', ...body })
    expect((await add({ name: 'Not A Slug' })).status).toBe(422)
    expect((await add({ rules: [{ action: { type: 'delete-everything' } }] })).status).toBe(422)
    expect((await add({ rules: [{ field: 'a', action: { type: 'ignore' } }] })).status).toBe(422)
    expect((await add({ mapping: { type: 'a b' } })).status).toBe(422)
    expect((await add({})).status).toBe(201)
    expect((await add({})).status).toBe(409)
  })
})

describe('the webhooks tools', () => {
  it('let an employee set up its own webhook, whose secret nobody sees until an admin makes one', async () => {
    const { t, s, employee, deliver, plan } = await make()
    const session = await s.sessions.create({ employeeId: employee.id, title: 'Watch CI' })
    const ctx = {
      employeeId: employee.id,
      sessionId: session.id,
      runId: 'run_test',
      callId: 'call_1',
      idempotencyKey: 'run_test:1:call_1',
      secrets: {},
      signal: new AbortController().signal,
      logger: memoryLogger([]),
      clock: { now: () => Date.now(), iso: () => new Date().toISOString() },
    } as unknown as ToolContext
    const made = await s.tools.execute(
      'webhooks.create',
      { name: 'ci', mapping: { type: 'status' }, rules: [{ type: 'failed', action: { type: 'session' } }] },
      ctx,
    )
    const out = made.output as any
    expect(out.webhook).toMatchObject({ name: 'ci', rules: [{ action: { type: 'session', sessionId: session.id } }] })
    expect(out.next).toMatch(/New secret/)
    const stored = (await s.secrets.resolve(['WEBHOOK_CI_SECRET'], { employeeId: employee.id })).WEBHOOK_CI_SECRET!
    expect(JSON.stringify(made)).not.toContain(stored)
    // An admin makes a secret; the failed build goes to the session that set it up.
    const { secret } = (await t.req('POST', `/api/webhooks/${out.webhook.id}/rotate`)).body
    const res = await deliver(out.webhook.id, { status: 'failed' }, { 'x-webhook-token': secret })
    expect(await plan(res.body.eventId)).toEqual([[session.id, 'trigger', true, false]])
    // Not another employee's.
    const other = (await s.directory.employees.create({ name: 'Other Bot' })).id
    const theirs = (await t.req('POST', '/api/webhooks', { employeeId: other, name: 'theirs' })).body.webhook
    const refused = await s.tools.execute('webhooks.update', { id: theirs.id, enabled: false }, ctx)
    expect(refused.isError).toBe(true)
    expect((await s.tools.execute('webhooks.list', {}, ctx)).output).toMatchObject({ webhooks: [{ name: 'ci' }] })
  })
})

describe('webhook helpers', () => {
  it('match rules by type glob and field, first one wins, else the router', () => {
    const rules = [
      { type: 'push', action: { type: 'ignore' as const } },
      { field: 'repo.name', contains: 'API', action: { type: 'session' as const, sessionId: 'ses_1' } },
    ]
    expect(decide(rules, 'push', {})).toEqual({ action: { type: 'ignore' }, rule: 1 })
    expect(decide(rules, 'build', { repo: { name: 'billing-api' } })).toEqual({
      action: { type: 'session', sessionId: 'ses_1' },
      rule: 2,
    })
    expect(decide(rules, 'build', { repo: { name: 'web' } })).toEqual({ action: { type: 'router' } })
  })

  it('write the event text from the template, or the name, type, subject and body', () => {
    expect(
      eventText('ci', { text: '{repo.name} failed at {steps.0}' }, 'x', undefined, { repo: { name: 'web' }, steps: ['lint'] }),
    ).toBe('web failed at lint')
    expect(eventText('ci', {}, 'build', 'web#12', { ok: false })).toBe('Webhook ci: build (web#12)\n{"ok":false}')
  })
})
