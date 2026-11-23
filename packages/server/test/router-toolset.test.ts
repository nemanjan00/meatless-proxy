import { afterEach, describe, expect, it } from 'vitest'
import { routerToolset } from '../src/provision.ts'
import { testApp, type TestApp } from './helpers.ts'

/** A router context carries few tool definitions: no MCP tools but its answer and lookup ones. Its forks do the work. */

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

describe('the router toolset', () => {
  it("leaves out MCP tools but the ones it answers and looks with; a fork of the router gets the employee's full toolset", async () => {
    const t = await testApp({ workers: false })
    apps.push(t)
    const s = t.a.services
    const employee = (await s.directory.employees.byHandle('meatless'))!
    const lists = await s.toolListsFor(employee.id)
    const full = s.tools.allowed(lists).map((x) => x.name)
    expect(full).toContain('mcp.gitlab.create_merge_request')
    const router = routerToolset(s, lists)
    expect(router).toContain('mcp.slack.reply')
    expect(router).toContain('mcp.linear.get_issue')
    expect(router).not.toContain('mcp.gitlab.create_merge_request')
    expect(router).not.toContain('mcp.slack.list_channels')
    expect(router.filter((n) => n.startsWith('mcp.')).length).toBeLessThan(15)
    // The live router context has it (provisioning brings older ones up to date).
    expect((await s.sessions.require(employee.data.routerSessionId!)).data.toolset).toEqual(router)

    await s.events.triggers.create({
      name: 'GitLab: new issues',
      employeeId: employee.id,
      match: { source: 'integration:gitlab', type: 'issue.opened' },
      target: { type: 'router' },
      fork: true,
      mode: 'continuing',
    })
    const { event } = await s.events.ingest({
      source: 'integration:gitlab',
      type: 'issue.opened',
      dedupeKey: 'gitlab:issue-1',
      subject: { system: 'gitlab', id: 'acme/web#1' },
      payload: { project: 'acme/web', iid: 1 },
    })
    const [delivery] = await s.router.plan(event)
    expect(delivery).toMatchObject({ reason: 'trigger', fork: true })
    const outcome = await s.router.deliver(event, delivery!)
    const fork = await s.sessions.require((outcome as { sessionId: string }).sessionId)
    expect(fork.id).not.toBe(employee.data.routerSessionId)
    expect(fork.data.toolset).toContain('mcp.gitlab.create_merge_request')
  })
})
