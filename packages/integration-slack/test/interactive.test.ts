import { ManualClock } from '@mp/core'
import type { Integration, WebhookRequest } from '@mp/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AskField,
  answeredMessage,
  buildAskBlocks,
  createSlackIntegration,
  fieldBlockId,
  MAX_FIELDS,
  memoryInteractionStore,
  parseBlocks,
  readAnswer,
  type SlackInteraction,
  signSlackRequest,
  validateAsk,
} from '../src/index.ts'
import { type FakeSlack, startFakeSlack, TOKEN } from './fake-slack.ts'

const SECRET = 'signing-secret-test'
let slack: FakeSlack
let clock: ManualClock
let store: ReturnType<typeof memoryInteractionStore>
let integration: Integration

beforeEach(async () => {
  slack = await startFakeSlack()
  clock = new ManualClock(Date.UTC(2026, 8, 29, 12))
  store = memoryInteractionStore()
  integration = createSlackIntegration({
    secrets: { botToken: TOKEN, signingSecret: SECRET },
    baseUrl: slack.url,
    clock,
    sleep: async () => {},
    interactions: store,
  })
})
afterEach(async () => {
  await slack.close()
})

const ALL_FIELDS: AskField[] = [
  { id: 'name', label: 'Name', type: 'text', placeholder: 'Your name', initial: 'Ana' },
  { id: 'why', label: 'Why', type: 'multiline', optional: true },
  {
    id: 'env',
    label: 'Environment',
    type: 'select',
    options: [
      { value: 'prod', label: 'Production' },
      { value: 'stg', label: 'Staging' },
    ],
    initial: 'stg',
  },
  {
    id: 'teams',
    label: 'Teams',
    type: 'multiselect',
    options: [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ],
    optional: true,
  },
  {
    id: 'checks',
    label: 'Checks',
    type: 'checkboxes',
    options: [
      { value: 'tests', label: 'Tests pass' },
      { value: 'docs', label: 'Docs updated' },
    ],
    initial: ['tests'],
    optional: true,
  },
  {
    id: 'size',
    label: 'Size',
    type: 'radio',
    options: [
      { value: 's', label: 'Small' },
      { value: 'l', label: 'Large' },
    ],
  },
  { id: 'when', label: 'When', type: 'date', initial: '2026-10-01' },
  { id: 'count', label: 'Count', type: 'number', initial: 3 },
]

describe('blocks for a question', () => {
  it('builds a section, one input block per field type, and the buttons', () => {
    const spec = validateAsk({ text: 'Deploy?', fields: ALL_FIELDS })
    const blocks = buildAskBlocks(spec) as any[]
    expect(blocks).toHaveLength(ALL_FIELDS.length + 2)
    expect(blocks[0]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: 'Deploy?' } })
    const inputs = blocks.slice(1, -1)
    for (const b of inputs) {
      expect(b.type).toBe('input')
      expect(b.dispatch_action).toBe(false)
    }
    const el = (id: string) => inputs.find((b) => b.block_id === fieldBlockId(id)).element
    expect(el('name')).toMatchObject({ type: 'plain_text_input', action_id: 'name', initial_value: 'Ana' })
    expect(el('name').placeholder.text).toBe('Your name')
    expect(el('why')).toMatchObject({ type: 'plain_text_input', multiline: true })
    expect(el('env')).toMatchObject({ type: 'static_select', initial_option: { value: 'stg' } })
    expect(el('env').options).toHaveLength(2)
    expect(el('teams').type).toBe('multi_static_select')
    expect(el('checks')).toMatchObject({ type: 'checkboxes', initial_options: [{ value: 'tests' }] })
    expect(el('size').type).toBe('radio_buttons')
    expect(el('when')).toEqual({ type: 'datepicker', action_id: 'when', initial_date: '2026-10-01' })
    expect(el('count')).toMatchObject({ type: 'number_input', is_decimal_allowed: true, initial_value: '3' })
    expect(inputs.find((b) => b.block_id === fieldBlockId('why')).optional).toBe(true)
    expect(inputs.find((b) => b.block_id === fieldBlockId('name')).optional).toBe(false)
    const actions = blocks.at(-1)
    expect(actions).toMatchObject({ type: 'actions', block_id: 'mp_actions' })
    expect(actions.elements).toEqual([
      {
        type: 'button',
        action_id: 'mp_button:submit',
        text: { type: 'plain_text', text: 'Submit', emoji: true },
        value: 'submit',
        style: 'primary',
      },
    ])
  })

  it('takes custom buttons', () => {
    const spec = validateAsk({
      text: 'Approve?',
      fields: [{ id: 'note', label: 'Note', type: 'text', optional: true }],
      buttons: [
        { id: 'approve', label: 'Approve', style: 'primary' },
        { id: 'reject', label: 'Reject', style: 'danger' },
      ],
    })
    const actions = buildAskBlocks(spec).at(-1) as any
    expect(actions.elements.map((e: any) => [e.action_id, e.style])).toEqual([
      ['mp_button:approve', 'primary'],
      ['mp_button:reject', 'danger'],
    ])
  })

  it("enforces Slack's limits with clear messages", () => {
    const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }))
    const bad = (input: Parameters<typeof validateAsk>[0], msg: RegExp) => expect(() => validateAsk(input)).toThrow(msg)
    const f = (x: Partial<AskField>): AskField => ({ id: 'f', label: 'F', type: 'text', ...x }) as AskField
    bad({ text: '', fields: [f({})] }, /text is empty/)
    bad({ text: 'x'.repeat(3001), fields: [f({})] }, /at most 3000/)
    bad({ text: 'q', fields: [] }, /fields is empty/)
    bad({ text: 'q', fields: Array.from({ length: MAX_FIELDS + 1 }, (_, i) => f({ id: `f${i}` })) }, /at most 48/)
    bad({ text: 'q', fields: [f({}), f({})] }, /duplicate id/)
    bad({ text: 'q', fields: [f({ id: 'has space' })] }, /id must be/)
    bad({ text: 'q', fields: [f({ label: 'x'.repeat(2001) })] }, /label is 2001 characters; at most 2000/)
    bad({ text: 'q', fields: [f({ placeholder: 'x'.repeat(151) })] }, /at most 150/)
    bad({ text: 'q', fields: [f({ type: 'select' })] }, /needs options/)
    bad({ text: 'q', fields: [f({ type: 'select', options: opts(101) })] }, /101 options; a select takes at most 100/)
    bad({ text: 'q', fields: [f({ type: 'checkboxes', options: opts(11) })] }, /at most 10/)
    bad({ text: 'q', fields: [f({ type: 'radio', options: opts(11) })] }, /at most 10/)
    bad({ text: 'q', fields: [f({ type: 'select', options: [{ value: 'a', label: 'x'.repeat(76) }] })] }, /at most 75/)
    bad({ text: 'q', fields: [f({ type: 'select', options: [{ value: 'x'.repeat(151), label: 'a' }] })] }, /at most 150/)
    bad(
      {
        text: 'q',
        fields: [
          f({
            type: 'select',
            options: [
              { value: 'a', label: 'A' },
              { value: 'a', label: 'B' },
            ],
          }),
        ],
      },
      /duplicate value/,
    )
    bad({ text: 'q', fields: [f({ options: opts(2) })] }, /takes no options/)
    bad({ text: 'q', fields: [f({ type: 'select', options: opts(2), initial: 'nope' })] }, /initial must be the value/)
    bad({ text: 'q', fields: [f({ type: 'checkboxes', options: opts(2), initial: 'v0' })] }, /list of option values/)
    bad({ text: 'q', fields: [f({ type: 'date', initial: '01/10/2026' })] }, /YYYY-MM-DD/)
    bad({ text: 'q', fields: [f({ type: 'number', initial: 'many' })] }, /must be a number/)
    bad({ text: 'q', fields: [f({ type: 'radio', options: opts(2), placeholder: 'pick' })] }, /no placeholder/)
    bad(
      { text: 'q', fields: [f({})], buttons: Array.from({ length: 26 }, (_, i) => ({ id: `b${i}`, label: 'B' })) },
      /at most 25/,
    )
    bad({ text: 'q', fields: [f({})], buttons: [{ id: 'b', label: 'x'.repeat(76) }] }, /at most 75/)
    bad({ text: 'q', fields: [f({})], buttons: [{ id: 'b', label: 'B', style: 'loud' as never }] }, /primary or danger/)
    // Every problem at once.
    expect(() => validateAsk({ text: '', fields: [f({ id: '' })] })).toThrow(/text is empty.*id must be/)
    // 48 fields fit in a message of 50 blocks.
    expect(
      buildAskBlocks(validateAsk({ text: 'q', fields: Array.from({ length: MAX_FIELDS }, (_, i) => f({ id: `f${i}` })) })),
    ).toHaveLength(50)
  })

  it('validates arbitrary blocks as JSON', () => {
    expect(parseBlocks([{ type: 'divider' }])).toEqual([{ type: 'divider' }])
    expect(parseBlocks('[{"type":"divider"}]')).toEqual([{ type: 'divider' }])
    expect(() => parseBlocks('[{')).toThrow(/not valid JSON/)
    expect(() => parseBlocks({ type: 'divider' })).toThrow(/JSON array/)
    expect(() => parseBlocks([])).toThrow(/empty/)
    expect(() => parseBlocks([{ text: 'x' }, 3])).toThrow(/blocks\[0\] has no type.*blocks\[1\] is not an object/)
    expect(() => parseBlocks(Array.from({ length: 51 }, () => ({ type: 'divider' })))).toThrow(/at most 50/)
  })
})

/** Slack's state.values for the answer to ALL_FIELDS. */
const fullState = () => ({
  values: {
    [fieldBlockId('name')]: { name: { type: 'plain_text_input', value: 'Bo' } },
    [fieldBlockId('why')]: { why: { type: 'plain_text_input', value: null } },
    [fieldBlockId('env')]: {
      env: { type: 'static_select', selected_option: { text: { type: 'plain_text', text: 'Production' }, value: 'prod' } },
    },
    [fieldBlockId('teams')]: { teams: { type: 'multi_static_select', selected_options: [{ value: 'a' }, { value: 'b' }] } },
    [fieldBlockId('checks')]: { checks: { type: 'checkboxes', selected_options: [] } },
    [fieldBlockId('size')]: { size: { type: 'radio_buttons', selected_option: { value: 'l' } } },
    [fieldBlockId('when')]: { when: { type: 'datepicker', selected_date: '2026-10-02' } },
    [fieldBlockId('count')]: { count: { type: 'number_input', value: '4.5' } },
  },
})

describe('reading the answer', () => {
  it('reads every element type', () => {
    const { values, missing } = readAnswer(ALL_FIELDS, fullState())
    expect(values).toEqual({
      name: 'Bo',
      why: null,
      env: 'prod',
      teams: ['a', 'b'],
      checks: [],
      size: 'l',
      when: '2026-10-02',
      count: 4.5,
    })
    expect(missing).toEqual([])
  })

  it('lists required fields left empty (Slack does not enforce them in messages)', () => {
    const { missing } = readAnswer(ALL_FIELDS, { values: {} })
    expect(missing.map((f) => f.id)).toEqual(['name', 'env', 'size', 'when', 'count'])
    const blank = readAnswer([{ id: 't', label: 'T', type: 'text' }], { values: { [fieldBlockId('t')]: { t: { value: '  ' } } } })
    expect(blank.missing).toHaveLength(1)
  })

  it('renders the answered message read-only, with labels and escaped values', () => {
    const spec = validateAsk({ text: 'Deploy?', fields: ALL_FIELDS })
    const { values } = readAnswer(ALL_FIELDS, fullState())
    values.name = '<!channel> & co'
    const m = answeredMessage(spec, { values, button: 'submit', answeredBy: 'U2' })
    expect(m.blocks.some((b) => b.type === 'input' || b.type === 'actions')).toBe(false)
    const body = (m.blocks[1] as any).text.text as string
    expect(body).toContain('*Environment*: Production')
    expect(body).toContain('*Teams*: Alpha, Beta')
    expect(body).toContain('*Why*: (empty)')
    expect(body).toContain('&lt;!channel&gt; &amp; co')
    expect((m.blocks[2] as any).elements[0].text).toBe('Answered by <@U2>')
    expect(m.text).toMatch(/^Answered by <@U2>: Name: <!channel> & co; /)
  })
})

describe('the ask tool', () => {
  let client: Client
  beforeEach(async () => {
    const server = integration.createMcpServer()
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(b)
    client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(a)
  })
  afterEach(async () => {
    await client.close()
  })
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    return { isError: r.isError === true, value: JSON.parse(r.content[0]!.text) }
  }

  it('posts the blocks with the text as fallback, and returns what the harness stores', async () => {
    const r = await call('ask', {
      channel: 'C1',
      text: 'Which environment?',
      fields: [{ id: 'env', label: 'Env', type: 'radio', options: [{ value: 'prod', label: 'Production' }] }],
      allow_multiple: true,
    })
    expect(r.isError).toBe(false)
    const [posted] = slack.callsTo('chat.postMessage')
    expect(posted!.contentType).toMatch(/^application\/json/)
    expect(posted!.params.text).toBe('Which environment?')
    expect((posted!.params.blocks as any[]).map((b) => b.type)).toEqual(['section', 'input', 'actions'])
    expect(r.value).toMatchObject({
      channel: 'C1',
      ts: expect.any(String),
      ask: { text: 'Which environment?', buttons: [{ id: 'submit' }], allowMultiple: true },
    })
    expect(r.value.ask.fields[0]).toMatchObject({ id: 'env', type: 'radio' })
  })

  it('refuses a question over the limits without posting', async () => {
    const r = await call('ask', {
      channel: 'C1',
      text: 'q',
      fields: [
        {
          id: 'x',
          label: 'X',
          type: 'checkboxes',
          options: Array.from({ length: 11 }, (_, i) => ({ value: `${i}`, label: `${i}` })),
        },
      ],
    })
    expect(r.isError).toBe(true)
    expect(r.value.error).toBe('validation')
    expect(r.value.message).toMatch(/11 options; a checkboxes takes at most 10/)
    expect(slack.callsTo('chat.postMessage')).toHaveLength(0)
  })

  it('post_blocks posts validated blocks, and explains invalid ones', async () => {
    const ok = await call('post_blocks', { channel: 'C1', text: 'hi', blocks: '[{"type":"divider"}]' })
    expect(ok.isError).toBe(false)
    expect(slack.callsTo('chat.postMessage')[0]!.params.blocks).toEqual([{ type: 'divider' }])
    const bad = await call('post_blocks', { channel: 'C1', text: 'hi', blocks: '{' })
    expect(bad.isError).toBe(true)
    expect(bad.value.message).toMatch(/not valid JSON/)
    slack.failWith('chat.postMessage', 'invalid_blocks', 1)
    const rejected = await call('post_blocks', { channel: 'C1', text: 'hi', blocks: [{ type: 'nonsense' }] })
    expect(rejected.value).toMatchObject({ error: 'invalid_blocks', hint: expect.stringContaining('Block Kit') })
  })

  it("post_blocks and ask errors carry Slack's explanation of which block failed", async () => {
    const why = ['[ERROR] must be more than 0 characters [json-pointer:/blocks/1/text/text]']
    slack.failWith('chat.postMessage', 'invalid_blocks', 1, { errors: why, response_metadata: { messages: why } })
    const r = await call('post_blocks', { channel: 'C1', text: 'hi', blocks: [{ type: 'divider' }, { type: 'section' }] })
    expect(r.isError).toBe(true)
    expect(r.value).toMatchObject({ error: 'invalid_blocks', slack_messages: why })
    slack.failWith('chat.postMessage', 'invalid_blocks', 1, { response_metadata: { messages: ['[ERROR] bad button'] } })
    const asked = await call('ask', { channel: 'C1', text: 'q', fields: [{ id: 'x', label: 'X', type: 'text' }] })
    expect(asked.value).toMatchObject({ error: 'invalid_blocks', slack_messages: ['[ERROR] bad button'] })
    // Without an explanation there's no empty list.
    slack.failWith('chat.postMessage', 'invalid_blocks', 1)
    const bare = await call('post_blocks', { channel: 'C1', text: 'hi', blocks: [{ type: 'divider' }] })
    expect(bare.value.slack_messages).toBeUndefined()
  })
})

// ── The interactive webhook ────────────────────────────────────────────────

const nowSec = () => Math.floor(clock.now() / 1000)
const formRequest = (payload: unknown, opts: { secret?: string; ts?: number } = {}): WebhookRequest => {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`
  const ts = String(opts.ts ?? nowSec())
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': signSlackRequest(opts.secret ?? SECRET, ts, body),
    },
    body,
    query: {},
  }
}

/** Posts a question through the fake and adds its interaction to the store, like the harness does. */
async function asked(fields: AskField[], extra: Partial<SlackInteraction> = {}): Promise<SlackInteraction> {
  const channel = slack.channels.get('C1')!
  const ts = `17123456${String(channel.messages.length).padStart(2, '0')}.000100`
  channel.messages.unshift({ ts, user: 'UBOT', bot_id: 'BBOT', text: 'question' })
  const spec = validateAsk({ text: 'Deploy?', fields, ...(extra.buttons ? { buttons: extra.buttons } : {}) })
  const i: SlackInteraction = {
    id: `int_${ts}`,
    channel: 'C1',
    ts,
    sessionId: 'ses_1',
    employeeId: 'emp_1',
    status: 'open',
    ...spec,
    ...extra,
  }
  store.add(i)
  return i
}

const click = (i: Pick<SlackInteraction, 'channel' | 'ts'>, state: unknown, opts: { user?: string; button?: string } = {}) => ({
  type: 'block_actions',
  api_app_id: 'AAPP',
  user: { id: opts.user ?? 'U1', username: 'ana' },
  team: { id: 'T1' },
  container: { type: 'message', message_ts: i.ts, channel_id: i.channel, is_ephemeral: false },
  channel: { id: i.channel, name: 'general' },
  message: { ts: i.ts, text: 'question' },
  state,
  response_url: 'https://hooks.slack.com/actions/T1/1/test',
  actions: [
    {
      action_id: `mp_button:${opts.button ?? 'submit'}`,
      block_id: 'mp_actions',
      type: 'button',
      value: opts.button ?? 'submit',
      action_ts: `${nowSec()}.0001`,
    },
  ],
})

const run = async (req: WebhookRequest) => {
  const r = await integration.handleWebhook(req)
  const events = r.after ? await r.after() : []
  return { r, events }
}

describe('interactive webhook', () => {
  it('acknowledges with an empty 200 at once, and does the work after', async () => {
    const i = await asked(ALL_FIELDS)
    const r = await integration.handleWebhook(formRequest(click(i, fullState())))
    expect(r).toMatchObject({ status: 200, body: '', events: [] })
    expect(slack.callsTo('chat.update')).toHaveLength(0)
    expect(typeof r.after).toBe('function')
    const events = await r.after!()
    expect(events).toHaveLength(1)
  })

  it('records the answer, updates the message read-only and returns interaction.answered', async () => {
    const i = await asked(ALL_FIELDS)
    const { events } = await run(formRequest(click(i, fullState(), { user: 'U2' })))
    expect(store.get(i.id)!.status).toBe('answered')
    expect(store.answers(i.id)).toEqual([
      {
        values: { name: 'Bo', why: null, env: 'prod', teams: ['a', 'b'], checks: [], size: 'l', when: '2026-10-02', count: 4.5 },
        button: 'submit',
        answeredBy: 'U2',
        at: new Date(clock.now()).toISOString(),
      },
    ])
    const [update] = slack.callsTo('chat.update')
    expect(update!.params).toMatchObject({ channel: 'C1', ts: i.ts })
    expect((update!.params.blocks as any[]).map((b) => b.type)).toEqual(['section', 'section', 'context'])
    expect(slack.channels.get('C1')!.messages.find((m) => m.ts === i.ts)!.text).toMatch(/^Answered by <@U2>/)
    const e = events[0]!
    expect(e).toMatchObject({
      source: 'integration:slack',
      type: 'interaction.answered',
      dedupeKey: `slack:interaction:${i.id}`,
      subject: { system: 'slack', id: `C1/${i.ts}` },
      actor: { system: 'slack', id: 'U2' },
      payload: {
        interactionId: i.id,
        channel: 'C1',
        channel_name: 'general',
        ts: i.ts,
        button: 'submit',
        answeredBy: 'U2',
        values: { env: 'prod', count: 4.5 },
        tags: [{ type: 'session', sessionId: 'ses_1' }],
      },
    })
    expect(e.text).toContain('Slack #general U2 answered your question')
    expect(e.text).toContain('- Environment: Production [prod]')
    expect(e.text).toContain('- Teams: Alpha, Beta [a, b]')
    expect(e.text).toContain('- Why: (empty)')
  })

  it('uses the thread as the subject when the question was asked in one', async () => {
    const i = await asked([{ id: 'n', label: 'N', type: 'text' }], { threadTs: '1712000002.000100' })
    const { events } = await run(formRequest(click(i, { values: { [fieldBlockId('n')]: { n: { value: 'x' } } } })))
    expect(events[0]!.subject).toEqual({ system: 'slack', id: 'C1/1712000002.000100' })
    expect(events[0]!.payload).toMatchObject({ thread_ts: '1712000002.000100' })
  })

  it('reports which button was pressed', async () => {
    const i = await asked([{ id: 'note', label: 'Note', type: 'text', optional: true }], {
      buttons: [
        { id: 'approve', label: 'Approve', style: 'primary' },
        { id: 'reject', label: 'Reject', style: 'danger' },
      ],
    })
    const { events } = await run(formRequest(click(i, { values: {} }, { button: 'reject' })))
    expect(events[0]!.payload).toMatchObject({ button: 'reject', button_label: 'Reject', values: { note: null } })
    expect(events[0]!.text).toContain('with "Reject"')
    expect(JSON.stringify(slack.callsTo('chat.update')[0]!.params.blocks)).toContain('Answered by <@U1> (Reject)')
  })

  it('the first answer wins, also when two arrive at once', async () => {
    const i = await asked([{ id: 'n', label: 'N', type: 'text' }])
    const state = { values: { [fieldBlockId('n')]: { n: { value: 'x' } } } }
    const [a, b] = await Promise.all([
      run(formRequest(click(i, state, { user: 'U1' }))),
      run(formRequest(click(i, state, { user: 'U2' }))),
    ])
    expect(a.events.length + b.events.length).toBe(1)
    expect(store.answers(i.id)).toHaveLength(1)
    expect(slack.callsTo('chat.update')).toHaveLength(1)
    // A late click (e.g. a stale client) is told so and changes nothing.
    const late = await run(formRequest(click(i, state, { user: 'U2' })))
    expect(late.events).toEqual([])
    expect(slack.callsTo('chat.postEphemeral').at(-1)!.params).toMatchObject({
      user: 'U2',
      text: expect.stringContaining('answered already'),
    })
    expect(slack.callsTo('chat.update')).toHaveLength(1)
  })

  it('with allowMultiple, everyone can answer and the form stays', async () => {
    const i = await asked([{ id: 'n', label: 'N', type: 'text' }], { allowMultiple: true })
    const state = { values: { [fieldBlockId('n')]: { n: { value: 'x' } } } }
    const a = await run(formRequest(click(i, state, { user: 'U1' })))
    const b = await run(formRequest(click(i, state, { user: 'U2' })))
    expect([...a.events, ...b.events]).toHaveLength(2)
    expect(a.events[0]!.dedupeKey).not.toBe(b.events[0]!.dedupeKey)
    expect(slack.callsTo('chat.update')).toHaveLength(0)
    expect(store.answers(i.id)).toHaveLength(2)
  })

  it('refuses an answer with required inputs empty, and tells the person privately', async () => {
    const i = await asked(ALL_FIELDS)
    const { events } = await run(formRequest(click(i, { values: {} })))
    expect(events).toEqual([])
    expect(store.get(i.id)!.status).toBe('open')
    const [note] = slack.callsTo('chat.postEphemeral')
    expect(note!.params).toMatchObject({ channel: 'C1', user: 'U1' })
    expect(note!.params.text).toMatch(/Please fill in \*Name\*, \*Environment\*, \*Size\*, \*When\*, \*Count\*/)
  })

  it('still returns the event when chat.update fails', async () => {
    const i = await asked([{ id: 'n', label: 'N', type: 'text' }])
    slack.failWith('chat.update', 'cant_update_message', 1)
    const { events } = await run(formRequest(click(i, { values: { [fieldBlockId('n')]: { n: { value: 'x' } } } })))
    expect(events).toHaveLength(1)
  })

  it('ignores clicks on messages the harness did not ask with, and other payloads', async () => {
    const { r, events } = await run(formRequest(click({ channel: 'C1', ts: '1712000003.000100' }, { values: {} })))
    expect(r.status).toBe(200)
    expect(events).toEqual([])
    const i = await asked([{ id: 'n', label: 'N', type: 'text' }])
    // Not one of our buttons.
    const other = click(i, { values: {} }) as any
    other.actions = [{ action_id: 'something', block_id: 'b', type: 'button' }]
    expect((await run(formRequest(other))).events).toEqual([])
    // An unknown button id on our block.
    expect((await run(formRequest(click(i, { values: {} }, { button: 'nope' })))).events).toEqual([])
    // Other interactivity types are acknowledged without work.
    const shortcut = await integration.handleWebhook(formRequest({ type: 'shortcut', callback_id: 'x' }))
    expect(shortcut).toMatchObject({ status: 200, body: '', events: [] })
    expect(shortcut.after).toBeUndefined()
    expect(slack.callsTo('chat.update')).toHaveLength(0)
  })

  it('rejects a wrong or stale signature with 401, and a body without a payload with 400', async () => {
    const i = await asked([{ id: 'n', label: 'N', type: 'text' }])
    const wrong = await integration.handleWebhook(formRequest(click(i, { values: {} }), { secret: 'other-secret' }))
    expect(wrong.status).toBe(401)
    expect(wrong.after).toBeUndefined()
    const stale = await integration.handleWebhook(formRequest(click(i, { values: {} }), { ts: nowSec() - 301 }))
    expect(stale.status).toBe(401)
    const ts = String(nowSec())
    const body = 'foo=bar'
    const empty = await integration.handleWebhook({
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': signSlackRequest(SECRET, ts, body),
      },
      body,
      query: {},
    })
    expect(empty.status).toBe(400)
  })

  it('without an interaction store, interactivity is acknowledged and ignored', async () => {
    const plain = createSlackIntegration({ secrets: { botToken: TOKEN, signingSecret: SECRET }, baseUrl: slack.url, clock })
    const i = await asked([{ id: 'n', label: 'N', type: 'text' }])
    const r = await plain.handleWebhook(formRequest(click(i, { values: {} })))
    expect(r).toMatchObject({ status: 200, body: '', events: [] })
    expect(r.after).toBeUndefined()
  })
})
