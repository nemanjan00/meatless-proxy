import type { ModelRequest } from '@mp/model'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_MEMORY_HEADER } from '../src/session-memory.ts'
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
  const quiet = () =>
    until(async () => {
      await t.settle()
      return (await s.sessions.runs({ state: ['queued', 'running'] })).length === 0
    }, 'runs to finish')
  const request = async (text: string, headers: Record<string, string> = {}) => {
    const ch = (await s.chat.channelByName('requests'))!
    const r = await t.req('POST', `/api/chat/channels/${ch.id}/messages`, { text }, headers)
    expect(r.status).toBe(201)
    await quiet()
    const forks = await s.sessions.children(employee.data.routerSessionId!)
    const fork = forks.at(-1)!
    const [run] = await s.sessions.runs({ sessionId: fork.id })
    return { fork, run: run!, history: await s.sessions.runHistory(run!.id) }
  }
  return { t, s, employee, requests, request }
}

describe('memory at session start', () => {
  it('puts relevant memories into a request fork, after the fork point and before the event', async () => {
    const { s, employee, requests, request } = await make()
    const { memory } = await s.memory.remember({
      summary: 'The staging database password rotates every Friday',
      content: 'Ask the platform team in #ops before rotating the staging database credentials by hand.',
      employeeId: employee.id,
    })
    await s.memory.remember({ summary: 'Ben likes tea', content: 'Green, no sugar.' })

    const { fork, history } = await request('How do I rotate the staging database password?')
    const routerHistory = await s.sessions.history(employee.data.routerSessionId!)
    // The fork point is the router's head: the run's history starts with it, unchanged.
    expect(history.slice(0, routerHistory.length).map((e) => e.id)).toEqual(routerHistory.map((e) => e.id))
    const added = history.slice(routerHistory.length)
    expect(added.map((e) => e.kind)).toEqual(['system', 'event', 'assistant'])
    const text = (added[0]!.content as { text: string }).text
    expect(text.startsWith(SESSION_MEMORY_HEADER)).toBe(true)
    expect(text).toContain(`- The staging database password rotates every Friday (fact, ${memory.id}): Ask the platform team`)
    expect(text).not.toContain('Ben likes tea')
    expect(added[0]!.meta.recalledMemories).toEqual([memory.id])
    expect((added[1]!.content as { text: string }).text).toContain('How do I rotate the staging database password?')
    // The fork itself still shares the router's committed history (the cached prefix).
    expect(fork.data.parent?.entryId).toBe(routerHistory.at(-1)!.id)
    // And the model saw the memory before the request.
    const msgs = requests[0]!.messages.map((m) => m.content ?? '')
    const mi = msgs.findIndex((m) => m.startsWith(SESSION_MEMORY_HEADER))
    const ei = msgs.findIndex((m) => m.includes('How do I rotate the staging database password?'))
    expect(mi).toBeGreaterThan(0)
    expect(ei).toBeGreaterThan(mi)
  })

  it('adds nothing when no memory is relevant, and never another employee’s private memory', async () => {
    const { s, request } = await make()
    const other = await s.directory.employees.create({ name: 'Other Bot' })
    await s.memory.remember({ summary: 'Kubernetes upgrade is planned for May', employeeId: other.id })
    const { history } = await request('When is the kubernetes upgrade?')
    expect(history.filter((e) => e.kind === 'system').map((e) => (e.content as { text: string }).text)).not.toContainEqual(
      expect.stringContaining(SESSION_MEMORY_HEADER),
    )
  })

  it('recalls at most five memories, including ones about the requester', async () => {
    const { s, t, request } = await make()
    const ana = await s.directory.contacts.create({
      name: 'Ana Lopez',
      kind: 'person',
      status: 'active',
      handles: [{ system: 'mp', id: 'ana' }],
    })
    await s.memory.remember({ summary: 'Ana prefers answers as bullet points', scope: { type: 'contact', id: ana.id } })
    for (let i = 0; i < 7; i++) await s.memory.remember({ summary: `Invoice rule ${i}: invoices need a PO number` })
    const { history } = await request('Question about invoices', { 'x-mp-contact': ana.id })
    const entry = history.find(
      (e) => e.kind === 'system' && (e.content as { text: string }).text.startsWith(SESSION_MEMORY_HEADER),
    )!
    const lines = (entry.content as { text: string }).text.split('\n').slice(1)
    expect(lines).toHaveLength(5)
    expect(lines.join('\n')).toContain('Ana prefers answers as bullet points')
    expect(t.logs.filter((l) => l.level === 'error')).toEqual([])
  })
})
