import { ValidationError } from '@mp/core'

/**
 * Block Kit for questions with inputs (`mcp.slack.ask`): the blocks a question is posted with,
 * the answer read back from a `block_actions` payload, and the read-only message it becomes.
 *
 * Slack references (limits below come from these pages):
 * - input block: https://docs.slack.dev/reference/block-kit/blocks/input-block/
 * - actions block: https://docs.slack.dev/reference/block-kit/blocks/actions-block/
 * - button: https://docs.slack.dev/reference/block-kit/block-elements/button-element/
 * - plain_text_input: https://docs.slack.dev/reference/block-kit/block-elements/plain-text-input-element/
 * - static_select: https://docs.slack.dev/reference/block-kit/block-elements/select-menu-element/
 * - multi_static_select: https://docs.slack.dev/reference/block-kit/block-elements/multi-select-menu-element/
 * - checkboxes: https://docs.slack.dev/reference/block-kit/block-elements/checkboxes-element/
 * - radio_buttons: https://docs.slack.dev/reference/block-kit/block-elements/radio-button-group-element/
 * - datepicker: https://docs.slack.dev/reference/block-kit/block-elements/date-picker-element/
 * - number_input: https://docs.slack.dev/reference/block-kit/block-elements/number-input-element/
 * - option object: https://docs.slack.dev/reference/block-kit/composition-objects/option-object/
 * - state.values in block_actions: https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/
 * - chat.postMessage (50 blocks): https://docs.slack.dev/reference/methods/chat.postMessage/
 */

export type AskFieldType = 'text' | 'multiline' | 'select' | 'multiselect' | 'checkboxes' | 'radio' | 'date' | 'number'
export const ASK_FIELD_TYPES: readonly AskFieldType[] = [
  'text',
  'multiline',
  'select',
  'multiselect',
  'checkboxes',
  'radio',
  'date',
  'number',
]

export interface AskOption {
  value: string
  label: string
}

/** One input of a question. */
export interface AskField {
  /** Stable id, the key of its value in the answer. Letters, digits, `_` and `-`. */
  id: string
  label: string
  type: AskFieldType
  /** For select, multiselect, checkboxes and radio. */
  options?: AskOption[]
  /** May be left empty. Default false. */
  optional?: boolean
  placeholder?: string
  /** Pre-filled value: text, an option value, option values (multiselect, checkboxes), YYYY-MM-DD, or a number. */
  initial?: string | number | string[]
}

export interface AskButton {
  id: string
  label: string
  style?: 'primary' | 'danger'
}

/** A question as posted: normalized, validated. */
export interface AskSpec {
  text: string
  fields: AskField[]
  buttons: AskButton[]
}

/** One answer value: text, an option value, option values, a date (YYYY-MM-DD), a number, or null when left empty. */
export type AnswerValue = string | number | string[] | null

// Slack's limits.
/** Blocks per message (chat.postMessage). */
export const MAX_BLOCKS = 50
/** Section text. */
export const MAX_SECTION_TEXT = 3000
/** Input block label and hint (plain_text). */
export const MAX_LABEL = 2000
/** Element placeholders. */
export const MAX_PLACEHOLDER = 150
/** Options of a static select or multi-select. */
export const MAX_SELECT_OPTIONS = 100
/** Options of a checkbox group or radio button group. */
export const MAX_CHOICE_OPTIONS = 10
/** Option text. */
export const MAX_OPTION_LABEL = 75
/** Option value. */
export const MAX_OPTION_VALUE = 150
/** plain_text_input initial value and max_length. */
export const MAX_INPUT_TEXT = 3000
/** Button text. */
export const MAX_BUTTON_LABEL = 75
/** Elements in an actions block. */
export const MAX_BUTTONS = 25
/** Fields in one question: every block but the question's section and the buttons' actions block. */
export const MAX_FIELDS = MAX_BLOCKS - 2
/** Our ids end up in block_id and action_id (max 255); kept short. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** block_id of a field's input block, and of the buttons' actions block. */
export const fieldBlockId = (id: string) => `mp_field:${id}`
export const ACTIONS_BLOCK_ID = 'mp_actions'
/** action_id of a button. */
export const buttonActionId = (id: string) => `mp_button:${id}`
export const DEFAULT_BUTTONS: AskButton[] = [{ id: 'submit', label: 'Submit', style: 'primary' }]

const hasOptions = (t: AskFieldType) => t === 'select' || t === 'multiselect' || t === 'checkboxes' || t === 'radio'

/**
 * Checks a question against Slack's limits and returns it normalized (default button, trimmed
 * strings). Throws `ValidationError` listing every problem.
 */
export function validateAsk(input: { text: string; fields: AskField[]; buttons?: AskButton[] | undefined }): AskSpec {
  const issues: string[] = []
  const text = (input.text ?? '').trim()
  if (!text) issues.push('text is empty: it is the question, and the notification fallback')
  if (text.length > MAX_SECTION_TEXT) issues.push(`text is ${text.length} characters; at most ${MAX_SECTION_TEXT}`)
  const fields = input.fields ?? []
  if (!fields.length) issues.push('fields is empty: ask for at least one input (or use post_message)')
  if (fields.length > MAX_FIELDS) issues.push(`${fields.length} fields; a message holds at most ${MAX_FIELDS}`)
  const ids = new Set<string>()
  const out: AskField[] = []
  for (const [i, f] of fields.entries()) {
    const at = `fields[${i}]${f?.id ? ` (${f.id})` : ''}`
    if (!f || typeof f !== 'object') {
      issues.push(`${at} is not an object`)
      continue
    }
    if (!ID_RE.test(f.id ?? '')) issues.push(`${at}: id must be 1-64 letters, digits, _ or -`)
    else if (ids.has(f.id)) issues.push(`${at}: duplicate id`)
    ids.add(f.id)
    if (!ASK_FIELD_TYPES.includes(f.type)) issues.push(`${at}: type must be one of ${ASK_FIELD_TYPES.join(', ')}`)
    const label = (f.label ?? '').trim()
    if (!label) issues.push(`${at}: label is empty`)
    if (label.length > MAX_LABEL) issues.push(`${at}: label is ${label.length} characters; at most ${MAX_LABEL}`)
    const placeholder = f.placeholder?.trim() || undefined
    if (placeholder && placeholder.length > MAX_PLACEHOLDER)
      issues.push(`${at}: placeholder is ${placeholder.length} characters; at most ${MAX_PLACEHOLDER}`)
    if (placeholder && (f.type === 'checkboxes' || f.type === 'radio')) issues.push(`${at}: ${f.type} have no placeholder`)
    const options = f.options ?? []
    if (hasOptions(f.type)) {
      const max = f.type === 'select' || f.type === 'multiselect' ? MAX_SELECT_OPTIONS : MAX_CHOICE_OPTIONS
      if (!options.length) issues.push(`${at}: a ${f.type} needs options`)
      if (options.length > max) issues.push(`${at}: ${options.length} options; a ${f.type} takes at most ${max}`)
      const values = new Set<string>()
      for (const [j, o] of options.entries()) {
        const oat = `${at}.options[${j}]`
        if (typeof o?.value !== 'string' || !o.value) issues.push(`${oat}: value is empty`)
        else if (o.value.length > MAX_OPTION_VALUE)
          issues.push(`${oat}: value is ${o.value.length} characters; at most ${MAX_OPTION_VALUE}`)
        else if (values.has(o.value)) issues.push(`${oat}: duplicate value ${o.value}`)
        values.add(o?.value)
        const ol = typeof o?.label === 'string' ? o.label.trim() : ''
        if (!ol) issues.push(`${oat}: label is empty`)
        if (ol.length > MAX_OPTION_LABEL) issues.push(`${oat}: label is ${ol.length} characters; at most ${MAX_OPTION_LABEL}`)
      }
    } else if (options.length) issues.push(`${at}: a ${f.type} field takes no options`)
    const initialIssue = checkInitial(f)
    if (initialIssue) issues.push(`${at}: ${initialIssue}`)
    out.push({
      id: f.id,
      label,
      type: f.type,
      ...(hasOptions(f.type) ? { options: options.map((o) => ({ value: o.value, label: String(o.label ?? '').trim() })) } : {}),
      ...(f.optional ? { optional: true } : {}),
      ...(placeholder ? { placeholder } : {}),
      ...(f.initial !== undefined && f.initial !== null && f.initial !== '' ? { initial: f.initial } : {}),
    })
  }
  const buttons = input.buttons?.length ? input.buttons : DEFAULT_BUTTONS
  if (buttons.length > MAX_BUTTONS) issues.push(`${buttons.length} buttons; at most ${MAX_BUTTONS}`)
  const bids = new Set<string>()
  const outButtons: AskButton[] = []
  for (const [i, b] of buttons.entries()) {
    const at = `buttons[${i}]${b?.id ? ` (${b.id})` : ''}`
    if (!ID_RE.test(b?.id ?? '')) issues.push(`${at}: id must be 1-64 letters, digits, _ or -`)
    else if (bids.has(b.id)) issues.push(`${at}: duplicate id`)
    bids.add(b?.id)
    const label = (b?.label ?? '').trim()
    if (!label) issues.push(`${at}: label is empty`)
    if (label.length > MAX_BUTTON_LABEL) issues.push(`${at}: label is ${label.length} characters; at most ${MAX_BUTTON_LABEL}`)
    if (b?.style !== undefined && b.style !== 'primary' && b.style !== 'danger')
      issues.push(`${at}: style must be primary or danger`)
    outButtons.push({ id: b?.id, label, ...(b?.style ? { style: b.style } : {}) })
  }
  if (issues.length) throw new ValidationError('invalid question', issues)
  return { text, fields: out, buttons: outButtons }
}

function checkInitial(f: AskField): string | undefined {
  const v = f.initial
  if (v === undefined || v === null || v === '') return undefined
  const values = new Set((f.options ?? []).map((o) => o.value))
  switch (f.type) {
    case 'text':
    case 'multiline':
      if (typeof v !== 'string') return 'initial must be a string'
      return v.length > MAX_INPUT_TEXT ? `initial is ${v.length} characters; at most ${MAX_INPUT_TEXT}` : undefined
    case 'select':
    case 'radio':
      if (typeof v !== 'string' || !values.has(v)) return 'initial must be the value of one of the options'
      return undefined
    case 'multiselect':
    case 'checkboxes':
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !values.has(x)))
        return 'initial must be a list of option values'
      return undefined
    case 'date':
      return typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(v)) ? undefined : 'initial must be YYYY-MM-DD'
    case 'number':
      return Number.isFinite(typeof v === 'number' ? v : Number(v)) && String(v).trim() !== ''
        ? undefined
        : 'initial must be a number'
  }
  return undefined
}

const plain = (text: string) => ({ type: 'plain_text', text, emoji: true })
const option = (o: AskOption) => ({ text: plain(o.label), value: o.value })

/** The Block Kit element of one field. */
function elementOf(f: AskField): Record<string, unknown> {
  const placeholder = f.placeholder ? { placeholder: plain(f.placeholder) } : {}
  const opts = f.options ?? []
  const one = (v: unknown) => opts.find((o) => o.value === v)
  const many = (v: unknown) => (Array.isArray(v) ? opts.filter((o) => v.includes(o.value)) : [])
  const base = { action_id: f.id }
  switch (f.type) {
    case 'text':
    case 'multiline':
      return {
        type: 'plain_text_input',
        ...base,
        ...(f.type === 'multiline' ? { multiline: true } : {}),
        ...(typeof f.initial === 'string' ? { initial_value: f.initial } : {}),
        ...placeholder,
      }
    case 'select':
    case 'radio': {
      const initial = one(f.initial)
      return {
        type: f.type === 'select' ? 'static_select' : 'radio_buttons',
        ...base,
        options: opts.map(option),
        ...(initial ? { initial_option: option(initial) } : {}),
        ...(f.type === 'select' ? placeholder : {}),
      }
    }
    case 'multiselect':
    case 'checkboxes': {
      const initial = many(f.initial)
      return {
        type: f.type === 'multiselect' ? 'multi_static_select' : 'checkboxes',
        ...base,
        options: opts.map(option),
        ...(initial.length ? { initial_options: initial.map(option) } : {}),
        ...(f.type === 'multiselect' ? placeholder : {}),
      }
    }
    case 'date':
      return {
        type: 'datepicker',
        ...base,
        ...(typeof f.initial === 'string' ? { initial_date: f.initial } : {}),
        ...placeholder,
      }
    case 'number':
      return {
        type: 'number_input',
        ...base,
        is_decimal_allowed: true,
        ...(f.initial !== undefined ? { initial_value: String(f.initial) } : {}),
        ...placeholder,
      }
  }
}

/**
 * The blocks of a question: the text as a section, one input block per field (with
 * `dispatch_action: false`, so only the buttons send a `block_actions` payload), and an actions
 * block with the buttons.
 */
export function buildAskBlocks(spec: AskSpec): Record<string, unknown>[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: spec.text } },
    ...spec.fields.map((f) => ({
      type: 'input',
      block_id: fieldBlockId(f.id),
      label: plain(f.label),
      element: elementOf(f),
      dispatch_action: false,
      optional: !!f.optional,
    })),
    {
      type: 'actions',
      block_id: ACTIONS_BLOCK_ID,
      elements: spec.buttons.map((b) => ({
        type: 'button',
        action_id: buttonActionId(b.id),
        text: plain(b.label),
        value: b.id,
        ...(b.style ? { style: b.style } : {}),
      })),
    },
  ]
}

type StateValue = {
  type?: string
  value?: string | null
  selected_option?: { value?: string } | null
  selected_options?: { value?: string }[] | null
  selected_date?: string | null
}

/**
 * Reads the answer out of a `block_actions` payload's `state.values` (block_id → action_id →
 * value): strings for text, select and radio; option values for multiselect and checkboxes; a
 * YYYY-MM-DD date; a number. Empty inputs are null (empty lists for multiselect and checkboxes).
 * `missing` lists the required fields left empty: Slack doesn't enforce `optional: false` in messages.
 */
export function readAnswer(
  fields: AskField[],
  state: { values?: Record<string, Record<string, unknown> | undefined> } | undefined,
): { values: Record<string, AnswerValue>; missing: AskField[] } {
  const values: Record<string, AnswerValue> = {}
  const missing: AskField[] = []
  for (const f of fields) {
    const s = state?.values?.[fieldBlockId(f.id)]?.[f.id] as StateValue | undefined
    let v: AnswerValue = null
    switch (f.type) {
      case 'text':
      case 'multiline':
        v = typeof s?.value === 'string' && s.value.trim() !== '' ? s.value : null
        break
      case 'select':
      case 'radio':
        v = typeof s?.selected_option?.value === 'string' ? s.selected_option.value : null
        break
      case 'multiselect':
      case 'checkboxes':
        v = (s?.selected_options ?? []).map((o) => o?.value).filter((x): x is string => typeof x === 'string')
        break
      case 'date':
        v = typeof s?.selected_date === 'string' && s.selected_date ? s.selected_date : null
        break
      case 'number': {
        const n = typeof s?.value === 'string' && s.value.trim() !== '' ? Number(s.value) : Number.NaN
        v = Number.isFinite(n) ? n : null
        break
      }
    }
    values[f.id] = v
    const empty = v === null || (Array.isArray(v) && v.length === 0)
    if (empty && !f.optional) missing.push(f)
  }
  return { values, missing }
}

/** A value as people read it: option labels instead of values. */
export function displayValue(f: AskField, v: AnswerValue): string {
  if (v === null || (Array.isArray(v) && !v.length)) return '(empty)'
  const label = (x: string) => f.options?.find((o) => o.value === x)?.label ?? x
  if (Array.isArray(v)) return v.map(label).join(', ')
  if (typeof v === 'number') return String(v)
  return hasOptions(f.type) ? label(v) : v
}

/** Escapes text for mrkdwn, so people's answers can't mention @channel or forge links. */
export const escapeMrkdwn = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const clipTo = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * The message a question becomes once answered: the question, the answers read-only, and who
 * answered with which button. No inputs, so it can't be answered twice.
 */
export function answeredMessage(
  spec: AskSpec,
  answer: { values: Record<string, AnswerValue>; button?: string | undefined; answeredBy: string },
): { text: string; blocks: Record<string, unknown>[] } {
  const button = spec.buttons.find((b) => b.id === answer.button)
  const lines = spec.fields.map(
    (f) => `*${escapeMrkdwn(f.label)}*: ${escapeMrkdwn(displayValue(f, answer.values[f.id] ?? null))}`,
  )
  const by = `Answered by <@${answer.answeredBy}>${button && spec.buttons.length > 1 ? ` (${escapeMrkdwn(button.label)})` : ''}`
  const summary = spec.fields.map((f) => `${f.label}: ${displayValue(f, answer.values[f.id] ?? null)}`).join('; ')
  return {
    text: clipTo(`${by}: ${summary}`, 3000),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: spec.text } },
      { type: 'section', text: { type: 'mrkdwn', text: clipTo(lines.join('\n'), MAX_SECTION_TEXT) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: by }] },
    ],
  }
}

/** Validates arbitrary Block Kit blocks for `post_blocks`: a JSON array (or its JSON text) of 1-50 objects with a `type`. */
export function parseBlocks(input: unknown): Record<string, unknown>[] {
  let blocks = input
  if (typeof blocks === 'string') {
    try {
      blocks = JSON.parse(blocks)
    } catch (err) {
      throw new ValidationError(`blocks is not valid JSON: ${(err as Error).message}`)
    }
  }
  if (!Array.isArray(blocks)) throw new ValidationError('blocks must be a JSON array of Block Kit blocks')
  const issues: string[] = []
  if (!blocks.length) issues.push('blocks is empty')
  if (blocks.length > MAX_BLOCKS) issues.push(`${blocks.length} blocks; a message holds at most ${MAX_BLOCKS}`)
  for (const [i, b] of blocks.entries()) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) issues.push(`blocks[${i}] is not an object`)
    else if (typeof (b as { type?: unknown }).type !== 'string' || !(b as { type: string }).type)
      issues.push(`blocks[${i}] has no type`)
  }
  if (issues.length) throw new ValidationError('invalid blocks', issues)
  return blocks as Record<string, unknown>[]
}
