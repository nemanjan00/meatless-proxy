import {
  ConflictError,
  DeniedError,
  LimitError,
  ManualClock,
  NotFoundError,
  UnavailableError,
  ValidationError,
  silentLogger,
} from '@mp/core'
import type { McpCallResult, McpHub, McpToolInfo } from '@mp/mcp'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  checkArgs,
  createToolRegistry,
  mcpToolName,
  registerMcpTools,
  toProviderName,
  type ToolContext,
  type ToolDefinition,
  type ToolRegistry,
} from '../src/index.ts'

const def = (name: string, over: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name,
  description: `does ${name}`,
  parameters: { type: 'object', properties: {} },
  effect: 'read',
  source: 'stdlib',
  ...over,
})

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  employeeId: 'emp_1',
  sessionId: 'ses_1',
  runId: 'run_1',
  callId: 'call_1',
  idempotencyKey: 'run_1:1:call_1',
  secrets: {},
  signal: new AbortController().signal,
  logger: silentLogger,
  clock: new ManualClock(),
  emit: () => {},
  ...over,
})

const ok = async () => ({ output: 'ok' })

let reg: ToolRegistry
beforeEach(() => {
  reg = createToolRegistry()
})

describe('register', () => {
  it('registers, gets, lists sorted and unregisters', () => {
    reg.register(def('sessions.fork'), ok)
    reg.register(def('chat.post', { effect: 'idempotent' }), ok)
    expect(reg.list().map((d) => d.name)).toEqual(['chat.post', 'sessions.fork'])
    expect(reg.get('chat.post')!.def.effect).toBe('idempotent')
    expect(reg.get('nope')).toBeNull()
    expect(reg.unregister('chat.post')).toBe(true)
    expect(reg.unregister('chat.post')).toBe(false)
    expect(reg.list().map((d) => d.name)).toEqual(['sessions.fork'])
  })

  it('refuses duplicates unless replace', () => {
    reg.register(def('a.b'), ok)
    expect(() => reg.register(def('a.b'), ok)).toThrow(ConflictError)
    reg.register(def('a.b', { description: 'new' }), ok, { replace: true })
    expect(reg.get('a.b')!.def.description).toBe('new')
  })

  it('refuses provider-name clashes', () => {
    reg.register(def('a.b'), ok)
    expect(() => reg.register(def('a__b'), ok)).toThrow(ConflictError)
  })

  it('validates definitions', () => {
    expect(() => reg.register(def('bad name'), ok)).toThrow(ValidationError)
    expect(() => reg.register(def('a..b'), ok)).toThrow(ValidationError)
    expect(() => reg.register(def('a.b', { effect: 'write' as any }), ok)).toThrow(ValidationError)
    expect(() => reg.register(def('a.b', { source: 'x' as any }), ok)).toThrow(ValidationError)
    expect(() => reg.register(def('a.b', { parameters: null as any }), ok)).toThrow(ValidationError)
    expect(() => reg.register(def('a.b'), null as any)).toThrow(ValidationError)
  })
})

describe('allow and deny lists', () => {
  beforeEach(() => {
    for (const n of [
      'sessions.fork',
      'sessions.loop',
      'chat.post',
      'mcp.linear.create_issue',
      'mcp.linear.list',
      'mcp.slack.post',
    ])
      reg.register(def(n), ok)
  })

  it('allows nothing by default', () => {
    expect(reg.allowed({ allow: [], deny: [] })).toEqual([])
    expect(reg.isAllowed('chat.post', { allow: [], deny: [] })).toBe(false)
  })

  it('matches patterns and lets deny win', () => {
    const lists = { allow: ['sessions.*', 'mcp.**', 'chat.post'], deny: ['mcp.slack.*', 'sessions.loop'] }
    expect(reg.allowed(lists).map((d) => d.name)).toEqual([
      'chat.post',
      'mcp.linear.create_issue',
      'mcp.linear.list',
      'sessions.fork',
    ])
    expect(reg.isAllowed('mcp.slack.post', lists)).toBe(false)
    expect(reg.isAllowed('sessions.fork', lists)).toBe(true)
    expect(reg.isAllowed('unknown.tool', { allow: ['**'], deny: [] })).toBe(false)
    expect(reg.allowed({ allow: ['mcp.*'], deny: [] })).toEqual([])
  })
})

describe('specs and provider names', () => {
  it('maps names and keeps a stable order', () => {
    reg.register(def('sessions.fork', { parameters: { type: 'object', properties: { title: { type: 'string' } } } }), ok)
    reg.register(def('chat.post'), ok)
    reg.register(def('mcp.linear.create-issue'), ok)
    const a = reg.specs(['sessions.fork', 'mcp.linear.create-issue', 'chat.post'])
    const b = reg.specs(['chat.post', 'sessions.fork', 'mcp.linear.create-issue', 'chat.post'])
    expect(a).toEqual(b)
    expect(a.map((s) => s.function.name)).toEqual(['chat__post', 'mcp__linear__create-issue', 'sessions__fork'])
    expect(a[2]).toEqual({
      type: 'function',
      function: {
        name: 'sessions__fork',
        description: 'does sessions.fork',
        parameters: { type: 'object', properties: { title: { type: 'string' } } },
      },
    })
    for (const s of a) expect(s.function.name).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(reg.resolveProviderName('sessions__fork')).toBe('sessions.fork')
    expect(reg.resolveProviderName('sessions.fork')).toBe('sessions.fork')
    expect(reg.resolveProviderName('nope')).toBeNull()
    expect(() => reg.specs(['nope'])).toThrow(NotFoundError)
  })

  it('shortens long names deterministically', () => {
    const long = `mcp.${'x'.repeat(40)}.${'y'.repeat(40)}`
    const pn = toProviderName(long)
    expect(pn.length).toBe(64)
    expect(pn).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(toProviderName(long)).toBe(pn)
    expect(toProviderName(`${long}z`)).not.toBe(pn)
    reg.register(def(long), ok)
    expect(reg.resolveProviderName(pn)).toBe(long)
    reg.unregister(long)
    expect(reg.resolveProviderName(pn)).toBeNull()
  })
})

describe('checkArgs', () => {
  const schema = {
    type: 'object',
    required: ['title'],
    properties: { title: { type: 'string' }, n: { type: 'integer' }, tags: { type: ['array', 'null'] }, any: {} },
  }
  it('checks object, required and top-level types', () => {
    expect(checkArgs(schema, { title: 'x', n: 2, tags: null, any: 1, extra: true })).toEqual([])
    expect(checkArgs(schema, 'x')).toEqual(['arguments must be an object'])
    expect(checkArgs(schema, [])).toEqual(['arguments must be an object'])
    expect(checkArgs(schema, {})).toEqual(['title is required'])
    expect(checkArgs(schema, { title: 1, n: 1.5, tags: 'a' })).toEqual([
      'title must be string',
      'n must be integer',
      'tags must be array or null',
    ])
  })
})

describe('execute', () => {
  it('runs the handler with args and context', async () => {
    const seen: unknown[] = []
    reg.register(
      def('a.echo', { parameters: { type: 'object', required: ['x'], properties: { x: { type: 'number' } } } }),
      async (args, c) => {
        seen.push(args, c.idempotencyKey, c.secrets)
        return { output: { x: args.x }, control: [{ type: 'commit', summary: 'done' }] }
      },
    )
    const res = await reg.execute('a.echo', { x: 1 }, ctx({ secrets: { TOKEN: 'sk-test' } }))
    expect(res).toEqual({ output: { x: 1 }, control: [{ type: 'commit', summary: 'done' }] })
    expect(seen).toEqual([{ x: 1 }, 'run_1:1:call_1', { TOKEN: 'sk-test' }])
  })

  it('throws NotFoundError for unknown tools', async () => {
    await expect(reg.execute('nope', {}, ctx())).rejects.toBeInstanceOf(NotFoundError)
  })

  it('returns invalid arguments as a tool error without calling the handler', async () => {
    let called = false
    reg.register(
      def('a.b', {
        parameters: { type: 'object', properties: { x: { type: 'string' }, n: { type: 'number' } }, required: ['x', 'n'] },
      }),
      async () => {
        called = true
        return { output: null }
      },
    )
    const res = await reg.execute('a.b', {}, ctx())
    expect(res.isError).toBe(true)
    // What arrived and what to send: a model repeating `{}` couldn't tell from "x is required" alone.
    expect(res.output).toMatchObject({
      error: 'invalid arguments for a.b: x is required; n is required',
      received: '{}',
      example: { x: '…', n: 0 },
    })
    expect((res.output as { hint: string }).hint).toContain('received')
    expect(called).toBe(false)
  })

  it('turns handler errors into tool errors', async () => {
    reg.register(def('a.fail'), async () => {
      throw new Error('boom')
    })
    reg.register(def('a.validation'), async () => {
      throw new ValidationError('bad input')
    })
    reg.register(def('a.empty'), async () => undefined as any)
    expect(await reg.execute('a.fail', {}, ctx())).toEqual({ output: { error: 'boom' }, isError: true })
    expect(await reg.execute('a.validation', {}, ctx())).toEqual({ output: { error: 'bad input' }, isError: true })
    expect((await reg.execute('a.empty', {}, ctx())).isError).toBe(true)
  })

  it('rethrows denied, limit and unavailable errors, and errors after abort', async () => {
    reg.register(def('a.denied'), async () => {
      throw new DeniedError('no')
    })
    reg.register(def('a.limit'), async () => {
      throw new LimitError('budget')
    })
    reg.register(def('a.down'), async () => {
      throw new UnavailableError('down')
    })
    reg.register(def('a.slow'), async (_a, c) => {
      await new Promise((_r, rej) => c.signal.addEventListener('abort', () => rej(new Error('aborted'))))
      return { output: null }
    })
    await expect(reg.execute('a.denied', {}, ctx())).rejects.toBeInstanceOf(DeniedError)
    await expect(reg.execute('a.limit', {}, ctx())).rejects.toBeInstanceOf(LimitError)
    await expect(reg.execute('a.down', {}, ctx())).rejects.toBeInstanceOf(UnavailableError)
    const ac = new AbortController()
    const p = reg.execute('a.slow', {}, ctx({ signal: ac.signal }))
    ac.abort()
    await expect(p).rejects.toThrow('aborted')
  })
})

/** A tiny McpHub fake, local to this test. */
function fakeHub(initial: McpToolInfo[]) {
  let tools = initial
  const calls: { server: string; tool: string; args: Record<string, unknown>; signal?: AbortSignal }[] = []
  let next: McpCallResult = { content: [{ type: 'text', text: 'done' }], isError: false }
  const hub: McpHub = {
    servers: () => [...new Set(tools.map((t) => t.server))],
    listTools: async (server) => tools.filter((t) => server === undefined || t.server === server),
    async callTool(server, tool, args, o) {
      calls.push({ server, tool, args, ...(o?.signal ? { signal: o.signal } : {}) })
      return next
    },
    onNotification: () => () => {},
    close: async () => {},
  }
  return {
    hub,
    calls,
    setTools: (t: McpToolInfo[]) => void (tools = t),
    respond: (r: McpCallResult) => void (next = r),
  }
}

const info = (
  server: string,
  name: string,
  inputSchema: Record<string, unknown> = { type: 'object', properties: {} },
): McpToolInfo => ({
  server,
  name,
  description: `${server} ${name}`,
  inputSchema,
})

describe('registerMcpTools', () => {
  it('registers hub tools with effects and secrets and calls through', async () => {
    const f = fakeHub([
      info('linear', 'create_issue', { type: 'object', required: ['title'] }),
      info('linear', 'list_issues'),
      info('slack', 'post'),
    ])
    reg.register(def('chat.post'), ok)
    const names = await registerMcpTools(reg, f.hub, {
      effectOf: (_s, t) => (t.startsWith('list') ? 'read' : 'non_idempotent'),
      secretsOf: (s) => (s === 'linear' ? ['LINEAR_TOKEN'] : undefined),
    })
    expect(names).toEqual(['mcp.linear.create_issue', 'mcp.linear.list_issues', 'mcp.slack.post'])
    expect(reg.get('mcp.linear.list_issues')!.def).toMatchObject({
      effect: 'read',
      source: 'mcp',
      server: 'linear',
      secrets: ['LINEAR_TOKEN'],
    })
    expect(reg.get('mcp.slack.post')!.def.effect).toBe('non_idempotent')
    expect(reg.get('mcp.slack.post')!.def.secrets).toBeUndefined()

    const c = ctx()
    expect(await reg.execute('mcp.linear.create_issue', { title: 'x' }, c)).toEqual({ output: 'done' })
    expect(f.calls).toEqual([{ server: 'linear', tool: 'create_issue', args: { title: 'x' }, signal: c.signal }])
    expect((await reg.execute('mcp.linear.create_issue', {}, c)).isError).toBe(true)
    expect(f.calls.length).toBe(1)

    f.respond({ content: [{ type: 'text', text: 'nope' }], isError: true })
    expect(await reg.execute('mcp.slack.post', {}, c)).toEqual({ output: 'nope', isError: true })
    f.respond({ content: [], structuredContent: { id: 'PAY-1' }, isError: false })
    expect(await reg.execute('mcp.slack.post', {}, c)).toEqual({ output: { id: 'PAY-1' } })
    f.respond({
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', data: '' },
        { type: 'text', text: 'b' },
      ],
      isError: false,
    })
    expect(await reg.execute('mcp.slack.post', {}, c)).toEqual({ output: 'a\nb' })
  })

  it('refreshes: replaces changed tools and removes gone ones', async () => {
    const f = fakeHub([info('linear', 'a'), info('linear', 'b'), info('slack', 'post')])
    reg.register(def('chat.post'), ok)
    await registerMcpTools(reg, f.hub)
    f.setTools([{ ...info('linear', 'a'), description: 'changed' }, info('slack', 'post'), info('slack', 'read')])
    expect(await registerMcpTools(reg, f.hub, { server: 'linear' })).toEqual(['mcp.linear.a'])
    expect(reg.list().map((d) => d.name)).toEqual(['chat.post', 'mcp.linear.a', 'mcp.slack.post'])
    expect(reg.get('mcp.linear.a')!.def.description).toBe('changed')
    expect(await registerMcpTools(reg, f.hub)).toEqual(['mcp.linear.a', 'mcp.slack.post', 'mcp.slack.read'])
    f.setTools([])
    expect(await registerMcpTools(reg, f.hub)).toEqual([])
    expect(reg.list().map((d) => d.name)).toEqual(['chat.post'])
  })

  it('names tools safely', () => {
    expect(mcpToolName('linear', 'create_issue')).toBe('mcp.linear.create_issue')
    expect(mcpToolName('my server', 'do.thing')).toBe('mcp.my_server.do_thing')
  })
})
