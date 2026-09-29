import { errorMessage, type Json, type Logger } from '@mp/core'
import type { IntegrationEvent } from '@mp/mcp'
import {
  ACTIONS_BLOCK_ID,
  type AnswerValue,
  type AskButton,
  type AskField,
  answeredMessage,
  buttonActionId,
  displayValue,
  readAnswer,
} from './blocks.ts'
import type { SlackClient } from './client.ts'
import { SLACK_SOURCE, SLACK_SYSTEM, subjectFor } from './events.ts'

/**
 * Questions with inputs the harness posted (`mcp.slack.ask`), and the answers that come back
 * through Slack's interactivity (`block_actions`).
 *
 * - Interactivity payloads: https://docs.slack.dev/interactivity/handling-user-interaction/
 * - block_actions: https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/
 * - chat.update: https://docs.slack.dev/reference/methods/chat.update/
 * - chat.postEphemeral: https://docs.slack.dev/reference/methods/chat.postEphemeral/
 */

/** A question posted with inputs, as the store keeps it. */
export interface SlackInteraction {
  id: string
  channel: string
  /** The question message's ts. */
  ts: string
  /** The thread it was posted in, if any. */
  threadTs?: string
  employeeId?: string
  /** The session that asked: the answer is delivered to it. */
  sessionId?: string
  text: string
  fields: AskField[]
  buttons: AskButton[]
  /** Every answer counts (and the form stays), instead of the first one only. */
  allowMultiple?: boolean
  status: 'open' | 'answered'
}

export interface SlackInteractionAnswer {
  values: Record<string, AnswerValue>
  /** The button's id. */
  button?: string
  /** The Slack user id of who answered. */
  answeredBy: string
  at: string
}

/**
 * Where interactions are kept: the harness implements it over its records. The integration only
 * reads them and records answers; the harness creates them after `ask` posted the question.
 */
export interface SlackInteractionStore {
  /** The interaction whose question is the message `ts` in `channel`, or null (not a message the harness asked with). */
  find(channel: string, ts: string): Promise<SlackInteraction | null>
  /**
   * Records an answer. The first answer wins: false when the interaction was answered already
   * (unless it allows multiple answers). Must be atomic, since two people can click at once.
   */
  answer(id: string, answer: SlackInteractionAnswer): Promise<boolean>
}

/** An in-memory store (tests, and a harness without records). */
export function memoryInteractionStore(): SlackInteractionStore & {
  add(i: SlackInteraction): void
  get(id: string): SlackInteraction | undefined
  answers(id: string): SlackInteractionAnswer[]
} {
  const byId = new Map<string, SlackInteraction>()
  const answers = new Map<string, SlackInteractionAnswer[]>()
  return {
    add: (i) => void byId.set(i.id, { ...i }),
    get: (id) => byId.get(id),
    answers: (id) => answers.get(id) ?? [],
    async find(channel, ts) {
      for (const i of byId.values()) if (i.channel === channel && i.ts === ts) return { ...i }
      return null
    },
    async answer(id, answer) {
      const i = byId.get(id)
      if (!i || (i.status === 'answered' && !i.allowMultiple)) return false
      i.status = 'answered'
      answers.set(id, [...(answers.get(id) ?? []), answer])
      return true
    },
  }
}

/** The parts of a `block_actions` payload the harness reads. */
export interface BlockActionsPayload {
  type: 'block_actions'
  api_app_id?: string
  user?: { id?: string; username?: string; name?: string }
  team?: { id?: string }
  container?: { type?: string; message_ts?: string; channel_id?: string; is_ephemeral?: boolean; thread_ts?: string }
  channel?: { id?: string; name?: string }
  message?: { ts?: string; thread_ts?: string; text?: string }
  state?: { values?: Record<string, Record<string, Record<string, unknown>>> }
  actions?: { action_id?: string; block_id?: string; type?: string; value?: string; action_ts?: string }[]
  response_url?: string
}

export interface BlockActionsDeps {
  store: SlackInteractionStore
  client: SlackClient
  channelName(id: string): Promise<string | undefined>
  logger: Logger
  now(): string
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
/** Longest answer value in the event text; the payload has them whole. */
const VALUE_TEXT_MAX = 1500

/**
 * Handles a `block_actions` payload, after Slack got its 200: a button click on an open question
 * the harness asked records the answer (first one wins), turns the message read-only with
 * `chat.update`, and returns one `interaction.answered` event. Clicks on other messages, and on
 * questions answered already, return no events. A click that leaves required inputs empty gets an
 * ephemeral note to that person instead.
 */
export async function handleBlockActions(p: BlockActionsPayload, deps: BlockActionsDeps): Promise<IntegrationEvent[]> {
  const { logger } = deps
  const channel = p.container?.channel_id ?? p.channel?.id
  const ts = p.container?.message_ts ?? p.message?.ts
  const user = p.user?.id
  if (!channel || !ts || !user || p.container?.is_ephemeral) return []
  const action = (p.actions ?? []).find((a) => a.block_id === ACTIONS_BLOCK_ID && a.action_id?.startsWith('mp_button:'))
  if (!action) return []
  const interaction = await deps.store.find(channel, ts)
  if (!interaction) {
    logger.debug('slack: click on a message the harness did not ask with, ignored', { channel, ts })
    return []
  }
  const button = interaction.buttons.find((b) => buttonActionId(b.id) === action.action_id)
  if (!button) return []
  const threadTs = interaction.threadTs ?? p.message?.thread_ts ?? p.container?.thread_ts
  const ephemeral = async (text: string) => {
    try {
      await deps.client.call(
        'chat.postEphemeral',
        { channel, user, text, ...(threadTs ? { thread_ts: threadTs } : {}) },
        { write: true, json: true },
      )
    } catch (err) {
      logger.debug('slack: ephemeral note failed', { channel, err: errorMessage(err) })
    }
  }
  if (interaction.status === 'answered' && !interaction.allowMultiple) {
    await ephemeral('This question was answered already.')
    return []
  }
  const { values, missing } = readAnswer(interaction.fields, p.state)
  if (missing.length) {
    await ephemeral(`Please fill in ${missing.map((f) => `*${f.label}*`).join(', ')}, then press ${button.label} again.`)
    return []
  }
  const at = deps.now()
  const won = await deps.store.answer(interaction.id, { values, button: button.id, answeredBy: user, at })
  if (!won) {
    await ephemeral('This question was answered already.')
    return []
  }

  if (interaction.allowMultiple) await ephemeral('Thanks, your answer was recorded.')
  else {
    const msg = answeredMessage(interaction, { values, button: button.id, answeredBy: user })
    try {
      await deps.client.call('chat.update', { channel, ts, text: msg.text, blocks: msg.blocks }, { write: true, json: true })
    } catch (err) {
      logger.warn('slack: could not mark the question answered', { channel, ts, err: errorMessage(err) })
    }
  }

  const isDm = channel.startsWith('D')
  const name = isDm ? undefined : await deps.channelName(channel)
  const where = isDm ? 'DM' : `#${name ?? channel}`
  const lines = interaction.fields.map(
    (f) =>
      `- ${f.label}: ${clip(displayValue(f, values[f.id] ?? null), VALUE_TEXT_MAX)}${f.options && fmt(values[f.id]) ? ` [${fmt(values[f.id])}]` : ''}`,
  )
  const text = [
    `Slack ${where} ${user} answered your question${interaction.buttons.length > 1 ? ` with "${button.label}"` : ''} (interaction ${interaction.id}):`,
    `Question: ${clip(interaction.text, 300)}`,
    ...lines,
  ].join('\n')
  const payload: Record<string, Json> = {
    interactionId: interaction.id,
    channel,
    ts,
    values: values as Json,
    button: button.id,
    button_label: button.label,
    answeredBy: user,
    answeredAt: at,
  }
  if (name) payload.channel_name = name
  if (threadTs) payload.thread_ts = threadTs
  // A session tag: the router delivers the answer to the session that asked, expected to act on it.
  if (interaction.sessionId) payload.tags = [{ type: 'session', sessionId: interaction.sessionId }]
  return [
    {
      source: SLACK_SOURCE,
      type: 'interaction.answered',
      dedupeKey: interaction.allowMultiple
        ? `slack:interaction:${interaction.id}:${user}:${action.action_ts ?? at}`
        : `slack:interaction:${interaction.id}`,
      subject: subjectFor(channel, threadTs ?? ts),
      actor: { system: SLACK_SYSTEM, id: user },
      text,
      payload,
    },
  ]
}

/** Option values as the model reads them next to the labels. */
const fmt = (v: AnswerValue | undefined) => (Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '' : String(v))
