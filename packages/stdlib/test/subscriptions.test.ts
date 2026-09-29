import { describe, expect, it } from 'vitest'
import { DEFAULT_SUBSCRIPTION_TYPES, SUBSCRIPTION_PRESETS, subscriptionScope } from '../src/index.ts'
import { stack } from './helpers.ts'

describe('subscription scope', () => {
  it('defaults to the usual event types for the kind of subject, never everything by accident', () => {
    expect(subscriptionScope('gitlab')).toEqual({ types: DEFAULT_SUBSCRIPTION_TYPES.gitlab })
    expect(subscriptionScope('mp').types).toContain('message.replied')
    expect(subscriptionScope('mp').types).not.toContain('message.posted')
    // Unknown systems have no defaults: the caller decides.
    expect(subscriptionScope('custom')).toEqual({})
  })

  it('explicit types win, then a preset, then the defaults; all is an explicit choice', () => {
    expect(subscriptionScope('gitlab', { types: ['pipeline.failed'] })).toEqual({ types: ['pipeline.failed'] })
    expect(subscriptionScope('gitlab', { preset: 'failures' })).toEqual({ types: SUBSCRIPTION_PRESETS.failures!.types })
    expect(subscriptionScope('mp', { preset: 'people_only' })).toMatchObject({
      types: DEFAULT_SUBSCRIPTION_TYPES.mp,
      filter: SUBSCRIPTION_PRESETS.people_only!.filter,
    })
    expect(subscriptionScope('gitlab', { all: true })).toEqual({ types: null, filter: null })
    expect(() => subscriptionScope('mp', { preset: 'nope' })).toThrow(/unknown subscription preset/)
  })
})

describe('subscriptions.subscribe tool', () => {
  it('applies defaults, presets and all', async () => {
    const t = await stack()
    const mr = { system: 'gitlab', id: 'acme/billing!12' }
    const d = await t.out('subscriptions.subscribe', { subject: mr })
    expect(d.types).toEqual(DEFAULT_SUBSCRIPTION_TYPES.gitlab)
    const p = await t.out('subscriptions.subscribe', { subject: mr, preset: 'failures' })
    expect(p.types).toEqual(['pipeline.failed', 'job.failed'])
    const all = await t.out('subscriptions.subscribe', { subject: mr, all: true })
    expect(all.types).toBe('all')
    expect((await t.call('subscriptions.subscribe', { subject: mr, preset: 'nope' })).isError).toBe(true)
  })

  it('chat.post subscribes the session to its thread with the chat defaults', async () => {
    const t = await stack()
    await t.chat.createChannel({ name: 'ops', createdBy: { kind: 'contact', id: t.ana.id } })
    const p = await t.out('chat.post', { channel: 'ops', text: 'Deploying' })
    const [sub] = await t.events.subscriptions.forSession(t.session.id)
    expect(sub!.data).toMatchObject({ subject: { system: 'mp', id: p.threadId }, types: DEFAULT_SUBSCRIPTION_TYPES.mp })
  })
})

describe('router toolset', async () => {
  const { ROUTER_EXCLUDED_TOOLS, DEFAULT_TOOLSET } = await import('../src/index.ts')
  const { globMatch } = await import('@mp/core')
  it('leaves out git, env, files, doc writing and chat administration, and keeps routing tools', () => {
    const kept = DEFAULT_TOOLSET.filter((n) => !ROUTER_EXCLUDED_TOOLS.some((p) => globMatch(p, n)))
    expect(kept.some((n) => /^(git|env|fs)\./.test(n))).toBe(false)
    expect(kept).toEqual(
      expect.arrayContaining([
        'sessions.commit',
        'sessions.create',
        'sessions.message',
        'sessions.wait',
        'procedures.run',
        'chat.reply',
      ]),
    )
    expect(kept.length).toBeLessThan(DEFAULT_TOOLSET.length * 0.75)
  })
})
