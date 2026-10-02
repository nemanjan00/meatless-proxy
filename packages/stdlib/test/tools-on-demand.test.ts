import { LOADED_TOOLS_META } from '@mp/tools'
import { describe, expect, it } from 'vitest'
import {
  CORE_TOOLS,
  DEFAULT_TOOLSET,
  employeePrompt,
  isOnDemandTool,
  offeredTools,
  ON_DEMAND_GROUPS,
  onDemandFor,
  ROUTER_EXCLUDED_TOOLS,
} from '../src/index.ts'
import { globMatch } from '@mp/core'
import { stack } from './helpers.ts'

describe('the core set and the on-demand groups', () => {
  it('classify every default tool, and the prompt names every on-demand stdlib tool', async () => {
    const t = await stack()
    for (const n of CORE_TOOLS) if (!n.startsWith('mcp.')) expect(t.names).toContain(n)
    const onDemand = DEFAULT_TOOLSET.filter(isOnDemandTool)
    expect(onDemand.length).toBeGreaterThan(30)
    for (const n of DEFAULT_TOOLSET) {
      if (CORE_TOOLS.includes(n)) expect(isOnDemandTool(n)).toBe(false)
      else expect(isOnDemandTool(n), n).toBe(true)
    }
    // Each on-demand tool is listed in its group's line, by full name or as `/short` after its namespace.
    for (const n of onDemand) {
      const group = ON_DEMAND_GROUPS.find((g) => g.tools.some((p) => globMatch(p, n)))!
      const short = n.split('.').at(-1)!
      expect(group.list.includes(n) || new RegExp(`[/.]${short}(/|,|$|…)`).test(group.list), n).toBe(true)
    }
  })

  it('keep the most used integration tools in the core set, the rest on demand', () => {
    for (const n of ['mcp.slack.reply', 'mcp.slack.post_message', 'mcp.slack.read_thread', 'mcp.gitlab.get_file'])
      expect(isOnDemandTool(n)).toBe(false)
    for (const n of ['mcp.slack.ask', 'mcp.slack.upload_file', 'mcp.gitlab.job_log', 'mcp.linear.create_issue'])
      expect(isOnDemandTool(n)).toBe(true)
    // A configured MCP server's tools aren't classified: they are offered from the start.
    expect(isOnDemandTool('mcp.wiki.search')).toBe(false)
  })

  it('offer the core set and what was loaded, or everything without the loader', () => {
    const toolset = ['chat.reply', 'schedule.create', 'schedule.list', 'tools.find', 'tools.load']
    expect(offeredTools(toolset, [])).toEqual(['chat.reply', 'tools.find', 'tools.load'])
    expect(offeredTools(toolset, ['schedule.create'])).toEqual(['chat.reply', 'schedule.create', 'tools.find', 'tools.load'])
    expect(onDemandFor(['chat.reply', 'schedule.create'])).toBeUndefined()
    expect(offeredTools(['chat.reply', 'schedule.create'], [])).toEqual(['chat.reply', 'schedule.create'])
  })

  it('leave router contexts alone: they get no loader', () => {
    expect(ROUTER_EXCLUDED_TOOLS).toContain('tools.**')
  })
})

describe('tools.find', () => {
  it('finds tools by what the model wants to do, saying which are loaded', async () => {
    const t = await stack()
    const o = await t.out('tools.find', { query: 'remind me tomorrow on a schedule' })
    const names = o.tools.map((x: { name: string }) => x.name)
    expect(names).toContain('schedule.create')
    expect(o.tools.find((x: { name: string }) => x.name === 'schedule.create')).toMatchObject({ loaded: false })
    expect(o.next).toContain('tools.load')
    const git = await t.out('tools.find', { query: 'git commit' })
    expect(git.tools[0]).toMatchObject({ name: 'git.commit', loaded: true })
  })

  it('takes a name or a pattern, and lists the groups when nothing matches', async () => {
    const t = await stack()
    expect((await t.out('tools.find', { query: 'env.screenshot' })).tools.map((x: any) => x.name)).toEqual(['env.screenshot'])
    expect((await t.out('tools.find', { query: 'schedule.*' })).tools.length).toBe(5)
    const none = await t.out('tools.find', { query: 'zzzz qqqq' })
    expect(none.tools).toEqual([])
    expect(none.groups.map((g: { name: string }) => g.name)).toContain('scheduling')
  })

  it('only sees the tools of the session toolset', async () => {
    const t = await stack()
    const narrow = await t.sessions.create({
      employeeId: t.employee.id,
      title: 'narrow',
      toolset: ['chat.reply', 'tools.find', 'tools.load'],
      entries: [{ kind: 'system', content: { text: 'x' } }],
    })
    const run = await t.startRun(narrow.id)
    const o = await t.out('tools.find', { query: 'schedule reminder' }, t.ctxFor(narrow.id, run.id))
    expect(o.tools).toEqual([])
  })
})

describe('tools.load', () => {
  it('loads tools into the session meta, by name or pattern, and says what was already there', async () => {
    const t = await stack()
    const o = await t.out('tools.load', { names: ['schedule.create', 'chat.reply', 'mcp.nope.x'] })
    expect(o).toMatchObject({ loaded: ['schedule.create'], alreadyLoaded: ['chat.reply'], unknown: ['mcp.nope.x'] })
    expect((await t.sessions.require(t.session.id)).data.meta?.[LOADED_TOOLS_META]).toEqual(['schedule.create'])
    const again = await t.out('tools.load', { names: ['schedule.*'] })
    expect(again.loaded).toEqual(['schedule.cancel', 'schedule.list', 'schedule.run_now', 'schedule.update'])
    expect(again.alreadyLoaded).toEqual(['schedule.create'])
    expect((await t.sessions.require(t.session.id)).data.meta?.[LOADED_TOOLS_META]).toHaveLength(5)
  })

  it('refuses tools outside the toolset, and the meta field belongs to the harness', async () => {
    const t = await stack()
    const narrow = await t.sessions.create({
      employeeId: t.employee.id,
      title: 'narrow',
      toolset: ['chat.reply', 'tools.find', 'tools.load'],
      entries: [{ kind: 'system', content: { text: 'x' } }],
    })
    const run = await t.startRun(narrow.id)
    const r = await t.call('tools.load', { names: ['schedule.create'] }, t.ctxFor(narrow.id, run.id))
    expect(r.isError).toBe(true)
    expect((await t.sessions.require(narrow.id)).data.meta?.[LOADED_TOOLS_META]).toBeUndefined()
    const meta = await t.call('sessions.save_metadata', { meta: { [LOADED_TOOLS_META]: ['triggers.create'] } })
    expect(meta.isError).toBe(true)
  })

  it('is inherited by forks and loop children', async () => {
    const t = await stack()
    await t.out('tools.load', { names: ['env.preview'] })
    const fork = await t.out('sessions.fork', { instruction: 'look at it' })
    expect((await t.sessions.require(fork.sessionId)).data.meta?.[LOADED_TOOLS_META]).toEqual(['env.preview'])
    const loop = await t.out('sessions.loop', { items: ['a'], instruction: 'each' })
    expect((await t.sessions.require(loop.children[0].sessionId)).data.meta?.[LOADED_TOOLS_META]).toEqual(['env.preview'])
  })
})

describe('the switch', () => {
  it('on: the prompt lists what can be loaded; off: no loader tools and no list', async () => {
    const t = await stack()
    const contact = await t.directory.contacts.require(t.employee.data.contactId)
    const on = employeePrompt({ employee: t.employee, contact, now: 'now', toolsOnDemand: true })
    expect(on).toContain('## Tools on demand')
    expect(on).toContain('tools.find { query }')
    expect(on).toContain('mcp.slack.ask/upload_file')
    expect(on).toContain('schedule.create')
    expect(employeePrompt({ employee: t.employee, contact, now: 'now' })).not.toContain('## Tools on demand')
    // Sessions it creates get the prompt as the stdlib is configured.
    const created = await t.out('sessions.create', { title: 'x', instruction: 'y' })
    expect(((await t.sessions.history(created.sessionId))[0]!.content as any).text).toContain('## Tools on demand')

    const off = await stack({ toolsOnDemand: false })
    expect(off.names).not.toContain('tools.find')
    expect(off.names).not.toContain('tools.load')
    const o = await off.out('sessions.create', { title: 'x', instruction: 'y' })
    expect(((await off.sessions.history(o.sessionId))[0]!.content as any).text).not.toContain('## Tools on demand')
  })
})
