import { describe, expect, it } from 'vitest'
import { stack } from './helpers.ts'

describe('chat', () => {
  it('post starts a thread and subscribes the session as primary; reply and read', async () => {
    const t = await stack()
    await t.chat.createChannel({ name: 'billing', createdBy: { kind: 'contact', id: t.ana.id } })
    const p = await t.out('chat.post', { channel: '#billing', text: '@ana is invoice 9 a duplicate?' })
    expect(p).toMatchObject({ channel: 'billing', messageId: expect.stringMatching(/^msg_/), threadId: p.messageId })
    const msg = await t.chat.getMessage(p.messageId)
    expect(msg!.data.author).toEqual({ kind: 'session', id: t.session.id })
    expect(msg!.data.tags).toEqual([{ raw: '@ana', type: 'person', contactId: t.ana.id }])
    const subs = await t.events.subscriptions.forSession(t.session.id)
    expect(subs.map((s) => ({ subject: s.data.subject, primary: s.data.primary }))).toEqual([
      { subject: { system: 'mp', id: p.messageId }, primary: true },
    ])
    const r = await t.out('chat.reply', { threadId: p.messageId, text: 'Also invoice 10.' })
    expect(r.threadId).toBe(p.messageId)
    // A reply posted with a threadId doesn't add subscriptions.
    await t.out('chat.post', { channel: 'billing', text: 'more', threadId: r.messageId })
    expect(await t.events.subscriptions.forSession(t.session.id)).toHaveLength(1)

    const thread = await t.out('chat.read', { threadId: r.messageId })
    expect(thread.messages.map((m: any) => m.text)).toEqual(['@ana is invoice 9 a duplicate?', 'Also invoice 10.', 'more'])
    const channel = await t.out('chat.read', { channel: 'billing' })
    expect(channel.messages).toHaveLength(1)
    expect((await t.out('chat.search', { text: 'invoice 10' })).messages.map((m: any) => m.id)).toEqual([r.messageId])
    expect((await t.out('chat.search', { text: 'invoice', channel: 'billing' })).messages).toHaveLength(2)
  })

  it('post is idempotent per call, and refuses unknown channels', async () => {
    const t = await stack()
    await t.chat.createChannel({ name: 'ops', createdBy: { kind: 'contact', id: t.ana.id } })
    const c = t.ctx()
    const a = await t.out('chat.post', { channel: 'ops', text: 'hello' }, c)
    const b = await t.out('chat.post', { channel: 'ops', text: 'hello' }, c)
    expect(b).toEqual(a)
    expect(await t.chat.messages((await t.chat.channelByName('ops'))!.id)).toHaveLength(1)
    expect((await t.call('chat.post', { channel: 'nope', text: 'x' })).isError).toBe(true)
    expect((await t.call('chat.read', {})).isError).toBe(true)
  })

  it('create_channel resolves members; only its creator manages it', async () => {
    const t = await stack()
    const other = await t.directory.employees.create({ name: 'Ops Bot' })
    const intake = await t.newSession('Intake')
    const o = await t.out('chat.create_channel', {
      name: 'incident-42',
      topic: 'Payments down',
      members: ['ops-bot', t.ana.id, `@billing-bot#${intake.data.slug}`],
    })
    const ch = await t.chat.getChannel(o.channelId)
    expect(ch!.data).toMatchObject({
      name: 'incident-42',
      contextSessionId: t.session.id,
      createdBy: { kind: 'session', id: t.session.id },
    })
    const members = (await t.chat.members(o.channelId)).map((m) => `${m.kind}:${m.id}`)
    expect(members).toEqual([`session:${t.session.id}`, `employee:${other.id}`, `contact:${t.ana.id}`, `session:${intake.id}`])

    await t.out('chat.remove_member', { channel: 'incident-42', member: 'ops-bot' })
    await t.out('chat.add_member', { channel: 'incident-42', member: '@ana' })
    expect((await t.chat.members(o.channelId)).map((m) => m.id)).not.toContain(other.id)

    // Another employee's session can't manage it.
    const s2 = await t.sessions.create({ employeeId: other.id, title: 'ops', toolset: [] })
    const r2 = await t.startRun(s2.id)
    await expect(
      t.call('chat.archive', { channel: 'incident-42' }, t.ctxFor(s2.id, r2.id, { employeeId: other.id })),
    ).rejects.toThrow(/only the employee that created/)

    await t.out('chat.archive', { channel: 'incident-42' })
    expect((await t.chat.getChannel(o.channelId))!.data.archived).toBe(true)
    expect((await t.call('chat.post', { channel: 'incident-42', text: 'x' })).isError).toBe(true)
    expect((await t.call('chat.create_channel', { name: 'x', members: ['nobody-at-all'] })).isError).toBe(true)
  })

  it('invite tags people and employees in the thread', async () => {
    const t = await stack()
    await t.directory.employees.create({ name: 'Ops Bot' })
    await t.chat.createChannel({ name: 'general', createdBy: { kind: 'contact', id: t.ana.id } })
    const p = await t.out('chat.post', { channel: 'general', text: 'Deploy question' })
    const o = await t.out('chat.invite', { threadId: p.threadId, who: [t.ana.id, 'ops-bot'], text: 'Can we deploy today?' })
    expect(o.invited).toEqual(['@ana', '@ops-bot'])
    const m = await t.chat.getMessage(o.messageId)
    expect(m!.data.text).toBe('@ana @ops-bot Can we deploy today?')
    expect(m!.data.tags.map((x) => x.type)).toEqual(['person', 'employee'])
    expect(m!.data.threadId).toBe(p.threadId)
  })
})

describe('subscriptions', () => {
  it('subscribe, list, unsubscribe', async () => {
    const t = await stack()
    const subject = { system: 'linear', id: 'PAY-123' }
    const o = await t.out('subscriptions.subscribe', { subject, types: ['comment.*'], filter: { 'payload.x': 1 }, primary: true })
    expect(o).toMatchObject({ subject, primary: true })
    const list = await t.out('subscriptions.list', {})
    expect(list.subscriptions).toEqual([
      { id: o.subscriptionId, subject, primary: true, types: ['comment.*'], filter: { 'payload.x': 1 } },
    ])
    await t.out('subscriptions.unsubscribe', { subject })
    expect((await t.out('subscriptions.list', {})).subscriptions).toEqual([])
    expect((await t.call('subscriptions.subscribe', { subject: { system: 'x' } })).isError).toBe(true)
  })
})

describe('triggers', () => {
  it('create, list, update and disable only for the calling employee', async () => {
    const t = await stack()
    const tr = await t.out('triggers.create', { name: 'new tasks', match: { source: 'mcp:linear', type: 'task.*' } })
    expect(tr).toMatchObject({
      name: 'new tasks',
      enabled: true,
      target: { type: 'session', sessionId: t.session.id },
      mode: 'ephemeral',
    })
    const stored = await t.events.triggers.get(tr.id)
    expect(stored!.data.employeeId).toBe(t.employee.id)
    const u = await t.out('triggers.update', { triggerId: tr.id, priority: 5, fork: true })
    expect(u).toMatchObject({ priority: 5, fork: true })
    const d = await t.out('triggers.disable', { triggerId: tr.id })
    expect(d.enabled).toBe(false)
    expect((await t.out('triggers.list', {})).triggers.map((x: any) => x.id)).toEqual([tr.id])
    expect((await t.out('triggers.list', { enabled: true })).triggers).toEqual([])

    const other = await t.directory.employees.create({ name: 'Other Bot' })
    const foreign = await t.events.triggers.create({
      name: 'theirs',
      employeeId: other.id,
      match: {},
      target: { type: 'router' },
    })
    expect((await t.call('triggers.update', { triggerId: foreign.id, enabled: false })).isError).toBe(true)
    expect((await t.call('triggers.disable', { triggerId: foreign.id })).isError).toBe(true)
    expect((await t.out('triggers.list', {})).triggers).toHaveLength(1)
    // Targets must be own sessions; bad filters are refused.
    const s = await t.newSession('theirs', other.id)
    expect(
      (await t.call('triggers.create', { name: 'x', match: {}, target: { type: 'session', sessionId: s.id } })).isError,
    ).toBe(true)
    expect((await t.call('triggers.create', { name: 'x', match: { filter: { $bogus: 1 } } })).isError).toBe(true)
    expect((await t.call('triggers.update', { triggerId: tr.id })).isError).toBe(true)
  })

  it('reacts, edits and deletes its own messages, and searches with filters', async () => {
    const t = await stack()
    await t.chat.createChannel({ name: 'ops', createdBy: { kind: 'contact', id: t.ana.id } })
    const p = await t.out('chat.post', { channel: 'ops', text: 'Deploying @ana' })
    expect(await t.out('chat.react', { messageId: p.messageId, emoji: '👀' })).toMatchObject({ reactions: { '👀': 1 } })
    expect((await t.out('chat.edit', { messageId: `mp:${p.messageId}`, text: 'Deployed @ana' })).editedAt).toBeTruthy()
    expect((await t.chat.getMessage(p.messageId))!.data.text).toBe('Deployed @ana')
    const byAuthor = await t.out('chat.search', { author: t.session.id })
    expect(byAuthor.messages.map((m: any) => m.id)).toEqual([p.messageId])
    expect((await t.out('chat.search', { tagged: t.ana.id })).messages).toHaveLength(1)
    expect((await t.call('chat.search', {})).isError).toBe(true)
    // Someone else's message can't be edited or deleted.
    const theirs = await t.chat.post({
      channelId: (await t.chat.channelByName('ops'))!.id,
      author: { kind: 'contact', id: t.ana.id },
      text: 'mine',
    })
    // Denials surface as errors, which the runner shows the model as a failed call.
    await expect(t.call('chat.edit', { messageId: theirs.id, text: 'hacked' })).rejects.toThrow('only the author')
    await expect(t.call('chat.delete', { messageId: theirs.id })).rejects.toThrow('only the author')
    expect(await t.out('chat.delete', { messageId: p.messageId })).toMatchObject({ deleted: true })
    expect((await t.out('chat.search', { text: 'Deployed' })).messages).toEqual([])
  })
})
