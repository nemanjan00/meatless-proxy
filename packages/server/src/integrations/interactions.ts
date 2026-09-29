import { ConflictError, errorMessage, type Hooks, isMpError, type Json, type KindSchema, type Logger } from '@mp/core'
import type { Events, Subject } from '@mp/events'
import type { AskButton, AskField, SlackInteraction, SlackInteractionAnswer, SlackInteractionStore } from '@mp/integration-slack'
import type { Records } from '@mp/records'
import { afterToolCall } from '@mp/runner'
import type { Actor } from '@mp/store'
import { subscribeOnce } from './policies.ts'

/**
 * Questions with inputs an employee asked in Slack (`mcp.slack.ask`), as records, and the answers
 * to them (docs/spec.md, "Interactive questions"). The Slack integration reads them through
 * `SlackInteractionStore` when an answer comes in.
 */

export const INTERACTION_KIND = 'interaction'
const ATTEMPTS = 5

export const interactionSchema: KindSchema = {
  kind: INTERACTION_KIND,
  prefix: 'itr',
  description:
    "A question with inputs posted in an external chat (Slack), and its answers. The key is '<system>:<channel>/<ts>'.",
  titleField: 'text',
  core: [
    { name: 'system', type: 'string', required: true, description: 'slack' },
    { name: 'employeeId', type: 'ref', ref: 'employee', required: true },
    { name: 'sessionId', type: 'ref', ref: 'session', description: 'The session that asked: the answer goes to it.' },
    { name: 'runId', type: 'ref', ref: 'run' },
    { name: 'channel', type: 'string', required: true },
    { name: 'ts', type: 'string', required: true, description: "The question message's ts." },
    { name: 'threadTs', type: 'string' },
    { name: 'text', type: 'text', required: true },
    { name: 'fields', type: 'json', required: true },
    { name: 'buttons', type: 'json', required: true },
    { name: 'allowMultiple', type: 'boolean' },
    { name: 'status', type: 'enum', values: ['open', 'answered'], required: true },
    { name: 'answers', type: 'json', description: 'Every answer: { values, button, answeredBy, at, contactId?, eventId? }.' },
    { name: 'answeredBy', type: 'string', description: 'Who answered first: their id in the system.' },
    { name: 'answeredByContactId', type: 'ref', ref: 'contact' },
    { name: 'answeredAt', type: 'timestamp' },
    { name: 'eventId', type: 'ref', ref: 'event', description: 'The interaction.answered event of the first answer.' },
  ],
}

export interface InteractionData extends Record<string, unknown> {
  system: string
  employeeId: string
  sessionId?: string
  runId?: string
  channel: string
  ts: string
  threadTs?: string
  text: string
  fields: AskField[]
  buttons: AskButton[]
  allowMultiple?: boolean
  status: 'open' | 'answered'
  answers?: (SlackInteractionAnswer & { contactId?: string; eventId?: string })[]
  answeredBy?: string
  answeredByContactId?: string
  answeredAt?: string
  eventId?: string
}

const SYSTEM: Actor = { type: 'system', id: 'integration:slack' }
export const interactionKey = (channel: string, ts: string) => `slack:${channel}/${ts}`

export function defineInteractionKind(records: Records) {
  if (!records.kinds.has(INTERACTION_KIND)) records.kinds.define(interactionSchema)
}

/** Reads and updates a record with compare-and-swap, retrying when someone else changed it first. */
async function casUpdate(
  records: Records,
  id: string,
  change: (d: InteractionData) => Partial<InteractionData> | null,
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    const rec = await records.get<InteractionData>(INTERACTION_KIND, id)
    if (!rec) return false
    const patch = change(rec.data)
    if (!patch) return false
    try {
      await records.update<InteractionData>(INTERACTION_KIND, id, patch, { expectedVersion: rec.version, actor: SYSTEM })
      return true
    } catch (err) {
      if (!(err instanceof ConflictError || isMpError(err, 'conflict')) || attempt >= ATTEMPTS) throw err
    }
  }
}

/**
 * The store an instance of the Slack integration reads: questions its employee asked (any
 * employee's, for the deployment-wide app). First answer wins, by compare-and-swap on the record.
 */
export function interactionStore(records: Records, employeeId: string | undefined): SlackInteractionStore {
  return {
    async find(channel, ts) {
      const rec = await records.getByKey<InteractionData>(INTERACTION_KIND, interactionKey(channel, ts))
      if (!rec || (employeeId && rec.data.employeeId !== employeeId)) return null
      const d = rec.data
      const out: SlackInteraction = {
        id: rec.id,
        channel: d.channel,
        ts: d.ts,
        employeeId: d.employeeId,
        text: d.text,
        fields: d.fields,
        buttons: d.buttons,
        status: d.status,
        ...(d.threadTs ? { threadTs: d.threadTs } : {}),
        ...(d.sessionId ? { sessionId: d.sessionId } : {}),
        ...(d.allowMultiple ? { allowMultiple: true } : {}),
      }
      return out
    },
    answer: (id, answer) =>
      casUpdate(records, id, (d) => {
        if (d.status === 'answered' && !d.allowMultiple) return null
        return {
          status: 'answered',
          answers: [...(d.answers ?? []), answer],
          ...(d.answeredBy ? {} : { answeredBy: answer.answeredBy, answeredAt: answer.at }),
        }
      }),
  }
}

/** After an `interaction.answered` event was ingested: who answered, as a contact, and the event. */
export async function noteAnswerEvent(
  records: Records,
  payload: Json,
  eventId: string,
  contactId: string | undefined,
  logger: Logger,
): Promise<void> {
  const p = (payload ?? {}) as { interactionId?: unknown; answeredBy?: unknown; answeredAt?: unknown }
  if (typeof p.interactionId !== 'string') return
  try {
    await casUpdate(records, p.interactionId, (d) => {
      const answers = (d.answers ?? []).map((a) =>
        a.answeredBy === p.answeredBy && a.at === p.answeredAt && !a.eventId
          ? { ...a, eventId, ...(contactId ? { contactId } : {}) }
          : a,
      )
      const first = d.answeredBy === p.answeredBy && d.answeredAt === p.answeredAt
      return {
        answers,
        ...(first && !d.eventId ? { eventId, ...(contactId ? { answeredByContactId: contactId } : {}) } : {}),
      }
    })
  } catch (err) {
    logger.warn('interaction: could not note the answer event', { interactionId: p.interactionId, err: errorMessage(err) })
  }
}

interface AskOutput {
  channel?: string
  ts?: string
  thread_ts?: string
  ask?: { text?: string; fields?: AskField[]; buttons?: AskButton[]; allowMultiple?: boolean }
}

/**
 * `mcp.slack.ask` (afterToolCall): stores the interaction for the question just posted, subscribes
 * the asking session to its thread, and gives the model `{ channel, ts, thread_ts?, interactionId,
 * subject }` instead of the question it sent. A router context holds no conversation, so its
 * answers go through routing like any Slack event.
 */
export function registerAskPolicy(deps: {
  hooks: Hooks
  records: Records
  events: Events
  logger: Logger
  toolName: string
}): () => void {
  const { records, events, logger } = deps
  return deps.hooks.onTransform(afterToolCall, async (p) => {
    if (p.tool.name !== deps.toolName || p.result.isError) return p
    const out = p.result.output as AskOutput
    if (!out || typeof out !== 'object' || !out.channel || !out.ts || !out.ask) return p
    const { channel, ts, ask } = out
    const threadTs = out.thread_ts
    const isRouter = p.session.data.meta?.role === 'router'
    const subject: Subject = { system: 'slack', id: `${channel}/${threadTs ?? ts}` }
    const view: Record<string, Json> = {
      channel,
      ts,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      subject: `slack:${subject.id}`,
    }
    try {
      const rec = await records.create<InteractionData>(
        INTERACTION_KIND,
        {
          system: 'slack',
          employeeId: p.run.data.employeeId,
          ...(isRouter ? {} : { sessionId: p.session.id }),
          runId: p.run.id,
          channel,
          ts,
          ...(threadTs ? { threadTs } : {}),
          text: ask.text ?? '',
          fields: ask.fields ?? [],
          buttons: ask.buttons ?? [],
          ...(ask.allowMultiple ? { allowMultiple: true } : {}),
          status: 'open',
        },
        { key: interactionKey(channel, ts), actor: { type: 'session', id: p.session.id } },
      )
      view.interactionId = rec.id
      view.waiting =
        'The answer comes to this session as an interaction.answered event. Wait for it with sessions.wait { delivery: true, timeoutSeconds }, or end your turn.'
    } catch (err) {
      logger.warn('slack ask: could not store the interaction', { runId: p.run.id, err: errorMessage(err) })
      view.warning = 'The question was posted, but its answer cannot be tracked: the harness could not store it.'
    }
    try {
      await subscribeOnce(events, p.session, subject, false)
    } catch (err) {
      logger.warn('slack ask: could not subscribe to the thread', { sessionId: p.session.id, err: errorMessage(err) })
    }
    return { ...p, result: { ...p.result, output: view } }
  })
}
