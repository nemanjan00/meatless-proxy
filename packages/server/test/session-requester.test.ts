import type { ModelRequest } from '@mp/model'
import { REQUESTER_HEADER } from '@mp/stdlib'
import { afterEach, describe, expect, it } from 'vitest'
import { testApp, until, type TestApp } from './helpers.ts'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function make() {
  const requests: ModelRequest[] = []
  const t = await testApp({
    script: (req) => {
      requests.push(req)
      return 'On it.'
    },
  })
  apps.push(t)
  const s = t.a.services
  const employee = (await s.directory.employees.byHandle('meatless'))!
  const request = async (text: string, contactId: string) => {
    const ch = (await s.chat.channelByName('requests'))!
    const r = await t.req('POST', `/api/chat/channels/${ch.id}/messages`, { text }, { 'x-mp-contact': contactId })
    expect(r.status).toBe(201)
    await until(async () => {
      await t.settle()
      return (await s.sessions.runs({ state: ['queued', 'running'] })).length === 0
    }, 'runs to finish')
    const runs = await s.sessions.runs({ sessionId: employee.data.routerSessionId! })
    return s.sessions.runHistory(runs.at(-1)!.id)
  }
  return { t, s, requests, request }
}

const about = (h: { kind: string; content: unknown }[]) =>
  h.filter((e) => e.kind === 'system' && String((e.content as { text?: string }).text).startsWith(REQUESTER_HEADER))

describe('about the requester', () => {
  it('tells the router who is asking, before the event, from their contact', async () => {
    const { s, t, requests, request } = await make()
    const ana = await s.directory.contacts.create({
      name: 'Ana Lopez',
      kind: 'person',
      status: 'active',
      handles: [{ system: 'mp', id: 'ana' }],
      role: 'Support agent',
      team: 'Customer success',
      bio: 'Not technical: no jargon, and give her wording she can send to the customer.',
    })
    const history = await request('A customer says invoices are blank', ana.id)
    const [entry] = about(history)
    expect((entry!.content as { text: string }).text).toContain('Support agent, Customer success')
    expect((entry!.content as { text: string }).text).toContain('no jargon')
    const msgs = requests[0]!.messages.map((m) => m.content ?? '')
    const ai = msgs.findIndex((m) => m.startsWith(REQUESTER_HEADER))
    const ei = msgs.findIndex((m) => m.includes('invoices are blank'))
    expect(ai).toBeGreaterThan(0)
    expect(ei).toBeGreaterThan(ai)
    expect(t.logs.filter((l) => l.level === 'error')).toEqual([])
  })

  it('says nothing about a contact with only a name', async () => {
    const { s, request } = await make()
    const bo = await s.directory.contacts.create({
      name: 'Bo',
      kind: 'person',
      status: 'active',
      handles: [{ system: 'mp', id: 'bo' }],
    })
    expect(about(await request('lunch anyone?', bo.id))).toEqual([])
  })
})
