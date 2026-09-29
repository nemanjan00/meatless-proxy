import { describe, expect, it } from 'vitest'
import {
  ConflictError,
  ManualClock,
  checkRecord,
  createEventBus,
  createHooks,
  defineHook,
  extendSchema,
  globMatch,
  idPrefix,
  isId,
  isMpError,
  memoryLogger,
  newId,
  nextMessage,
  stableStringify,
  topicMatches,
  type KindSchema,
} from '../src/index.ts'

describe('ids', () => {
  it('are prefixed, valid and sortable in creation order', () => {
    const ids = Array.from({ length: 200 }, () => newId('ses'))
    expect(ids.every((id) => isId(id, 'ses'))).toBe(true)
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
    expect(idPrefix(ids[0]!)).toBe('ses')
    expect(isId('nope')).toBe(false)
    expect(isId(ids[0], 'run')).toBe(false)
  })

  it('stay sortable when the clock goes backwards', () => {
    const a = newId('x', 2_000_000_000_000)
    const b = newId('x', 1_000_000_000_000)
    expect(b > a).toBe(true)
  })
})

describe('errors', () => {
  it('carry a code', () => {
    const e = new ConflictError('head moved')
    expect(isMpError(e, 'conflict')).toBe(true)
    expect(e.name).toBe('ConflictError')
  })
})

describe('clock', () => {
  it('only moves when told to', () => {
    const c = new ManualClock(1000)
    expect(c.now()).toBe(1000)
    c.advance(500)
    expect(c.now()).toBe(1500)
    expect(c.iso()).toBe(new Date(1500).toISOString())
  })
})

describe('event bus', () => {
  it('matches topic patterns', () => {
    expect(topicMatches('run.*', 'run.state')).toBe(true)
    expect(topicMatches('run.*', 'run.state.x')).toBe(false)
    expect(topicMatches('run.**', 'run.state.x')).toBe(true)
    expect(topicMatches('**', 'anything.at.all')).toBe(true)
    expect(topicMatches('a.**.c', 'a.c')).toBe(true)
    expect(topicMatches('a.**.c', 'a.b.b.c')).toBe(true)
    expect(topicMatches('a.b', 'a.c')).toBe(false)
  })

  it('delivers to matching subscribers and isolates handler errors', async () => {
    const logger = memoryLogger()
    const bus = createEventBus({ logger })
    const got: string[] = []
    bus.subscribe('run.*', () => {
      throw new Error('boom')
    })
    const off = bus.subscribe<{ n: number }>('run.*', (m) => void got.push(`${m.topic}:${m.payload.n}`))
    bus.publish('run.state', { n: 1 })
    bus.publish('other', { n: 2 })
    await bus.idle()
    off()
    bus.publish('run.state', { n: 3 })
    await bus.idle()
    expect(got).toEqual(['run.state:1'])
    expect(logger.lines.some((l) => l.level === 'error')).toBe(true)
  })

  it('nextMessage waits for a matching message', async () => {
    const bus = createEventBus()
    const p = nextMessage<{ id: string }>(bus, 'x.*', (m) => m.payload.id === 'b')
    bus.publish('x.y', { id: 'a' })
    bus.publish('x.y', { id: 'b' })
    expect((await p).payload.id).toBe('b')
    await expect(nextMessage(bus, 'never', undefined, 10)).rejects.toThrow('timed out')
  })
})

describe('hooks', () => {
  const gate = defineHook<{ tool: string }, { deny: string }>('test.gate')
  const redact = defineHook<string>('test.redact')

  it('decide: first decision wins, in order', async () => {
    const hooks = createHooks()
    const calls: string[] = []
    hooks.on(gate, () => void calls.push('late'), { order: 10 })
    hooks.on(gate, (p) => {
      calls.push('early')
      return p.tool === 'rm' ? { deny: 'no' } : undefined
    })
    expect(await hooks.decide(gate, { tool: 'ls' })).toBeUndefined()
    expect(await hooks.decide(gate, { tool: 'rm' })).toEqual({ deny: 'no' })
    expect(calls).toEqual(['early', 'late', 'early'])
    expect(hooks.registered()).toContain('test.gate')
  })

  it('transform: handlers chain', async () => {
    const hooks = createHooks()
    hooks.onTransform(redact, (s) => s.replace('secret', '***'))
    const off = hooks.onTransform(redact, (s) => s.toUpperCase())
    expect(await hooks.transform(redact, 'a secret')).toBe('A ***')
    off()
    expect(await hooks.transform(redact, 'a secret')).toBe('a ***')
  })
})

describe('schema', () => {
  const contact: KindSchema = {
    kind: 'contact',
    prefix: 'con',
    core: [
      { name: 'name', type: 'string', required: true },
      {
        name: 'handles',
        type: 'list',
        of: {
          type: 'object',
          fields: [
            { name: 'system', type: 'string', required: true },
            { name: 'id', type: 'string', required: true },
          ],
        },
      },
      { name: 'manager', type: 'ref', ref: 'contact' },
      { name: 'status', type: 'enum', values: ['active', 'left'] },
    ],
  }

  it('checks core and extension fields', () => {
    expect(checkRecord(contact, { name: 'Ana', handles: [{ system: 'slack', id: 'U1' }] })).toEqual([])
    expect(checkRecord(contact, { handles: [{ system: 'slack' }], manager: 3, status: 'gone' })).toEqual([
      'name is required',
      'handles[0].id is required',
      'manager must be a record id',
      'status must be one of active, left',
    ])
    expect(checkRecord(contact, { status: 'left' }, { partial: true })).toEqual([])
    const ext = extendSchema(contact, [{ name: 'timezone', type: 'string' }])
    expect(checkRecord(ext, { name: 'Ana', timezone: 5 })).toEqual(['timezone must be a string'])
    expect(() => extendSchema(contact, [{ name: 'name', type: 'number' }])).toThrow('core')
  })
})

describe('util', () => {
  it('stableStringify sorts keys', () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}')
  })
  it('globMatch', () => {
    expect(globMatch('mcp.linear.*', 'mcp.linear.create_issue')).toBe(true)
    expect(globMatch('mcp.*', 'mcp.linear.create_issue')).toBe(false)
    expect(globMatch('mcp.**', 'mcp.linear.create_issue')).toBe(true)
    expect(globMatch('sessions.fork', 'sessions.fork')).toBe(true)
  })
})
