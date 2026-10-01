import { isMpError } from '@mp/core'
import type { ChatMessage, ToolSpec } from '@mp/model'
import type { RunContextSize } from '@mp/sessions'
import type { Entry } from '@mp/store'
import { answeredCall } from './context.ts'

/**
 * Context-window bookkeeping for the runner: how big the next request will be, when to tell the model,
 * where an automatic compaction may cut, and previews of oversized tool results. Pure functions.
 */

/** Characters per token assumed before a run has measured one (a model call reports the real ratio). */
export const DEFAULT_CHARS_PER_TOKEN = 3.5

/** Characters of a request: what the provider tokenizes (images are counted by their reference only). */
export function requestChars(messages: ChatMessage[], tools: ToolSpec[]): number {
  return JSON.stringify(messages).length + (tools.length ? JSON.stringify(tools).length : 0)
}

/** Tokens per character, measured at the run's latest model call, else the default. */
export function tokensPerChar(last: RunContextSize | undefined): number {
  if (last && last.chars > 0 && last.tokens > 0) return last.tokens / last.chars
  return 1 / DEFAULT_CHARS_PER_TOKEN
}

/** The estimated prompt tokens of a request of `chars` characters. */
export function estimateTokens(chars: number, last: RunContextSize | undefined): number {
  return Math.ceil(chars * tokensPerChar(last))
}

/** `101k`, `1.2k`, `850`. */
export function kTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const k = n / 1000
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`
}

/** The highest threshold a history's context notes mention since its latest summary (a rewind or compaction resets them). */
export function notedInHistory(history: Entry[]): number {
  let noted = 0
  for (const e of history) {
    if (e.kind === 'summary') noted = 0
    const n = e.meta.contextNote
    if (typeof n === 'number' && n > noted) noted = n
  }
  return noted
}

/**
 * Whether to tell the model about its context size now. `noted` is the highest threshold it was told
 * about; a threshold it fell back below is armed again. Returns the threshold to note (or undefined)
 * and the new `noted`.
 */
export function contextNoteDecision(
  percent: number,
  noted: number,
  thresholds: readonly number[],
): { note?: number; noted: number } {
  const crossed = thresholds.filter((t) => percent >= t)
  const top = crossed.length ? Math.max(...crossed) : 0
  // Fell back below a threshold it was told about (a rewind, offload or compaction): arm it again.
  const armed = Math.min(noted, top)
  if (top > armed) return { note: top, noted: top }
  return { noted: armed }
}

/** The text of a context note. */
export function contextNoteText(tokens: number, window: number, compactAt: number | undefined): string {
  const pct = Math.round((tokens / window) * 100)
  const auto = compactAt ? ` At ${compactAt}% the harness compacts automatically.` : ''
  return (
    `[context: about ${kTokens(tokens)} of ${kTokens(window)} tokens (${pct}%)] Keep it lean: sessions.rewind with from and to ` +
    'collapses a stretch you are done with (e.g. from your first read call to your last) into a summary of what you learned, ' +
    'keeping everything after it; sessions.offload drops one big tool result you no longer need verbatim; sessions.compact is the last resort.' +
    auto
  )
}

/** Estimated tokens of one entry on its own. */
function entryTokens(e: Entry, perChar: number): number {
  return Math.ceil(JSON.stringify(e.content).length * perChar)
}

/**
 * Where an automatic compaction cuts a history: the index of the first entry kept verbatim. The kept
 * tail fits in `budget` tokens, never starts with a tool result (a result whose call is summarised is
 * summarised with it), and never includes the first entry. Returns `history.length` to keep nothing.
 */
export function compactionCut(history: Entry[], budget: number, perChar: number): number {
  let cut = history.length
  let used = 0
  for (let i = history.length - 1; i >= 1; i--) {
    const t = entryTokens(history[i]!, perChar)
    if (used + t > budget) break
    used += t
    cut = i
  }
  // Results answer the assistant entry before them: keep them together with it, or summarise them with it.
  while (cut < history.length && answeredCall(history[cut]!)) cut++
  return Math.max(1, cut)
}

/** The instruction for the summary call of an automatic compaction. */
export const COMPACTION_PROMPT = `[harness] Your context is nearly full, so the harness is compacting it. Write a summary of the work in this conversation so far that lets you carry on without the earlier messages. Don't call tools; reply with the summary only.

Include:
- The goal, and who asked for it (names and where: thread, ticket, session).
- Decisions made, and why.
- The current state: what is done, what was tried and didn't work.
- Open items and the next steps.
- Every id, path, branch, link, ticket, thread or message id, and number you still need, exactly.

Be concise and factual: at most about 1,500 words. The most recent messages are kept verbatim after your summary, so focus on what came before them.`

/** A string longer than `max` characters as its head and tail, with a marker between them. */
export function headAndTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text
  return `${text.slice(0, head)}\n\n[… ${(text.length - head - tail).toLocaleString('en-US')} characters left out …]\n\n${text.slice(-tail)}`
}

/** The pointer text standing for an oversized tool result. */
export function oversizedPointerText(o: {
  name: string
  text: string
  originalId: string
  isError: boolean
  head: number
  tail: number
}): string {
  const total = o.text.length.toLocaleString('en-US')
  return (
    `${o.name} returned ${total} characters${o.isError ? ' (an error)' : ''}, too many to keep in the context. The full result is stored. ` +
    `Below are its first ${o.head.toLocaleString('en-US')} and last ${o.tail.toLocaleString('en-US')} characters. ` +
    `To read more of it, call sessions.restore with entryId "${o.originalId}" and offset/length to get one piece at a time, ` +
    `or without them to put the whole result back (it costs context). Or ask the tool for less.\n\n${headAndTail(o.text, o.head, o.tail)}`
  )
}

/** Whether a model call failed because the request is longer than the model's context window. */
export function isContextOverflow(err: unknown): boolean {
  if (!isMpError(err)) return false
  if (err.code !== 'model_request') return false
  const status = (err.details as { status?: unknown } | undefined)?.status
  if (status !== undefined && status !== 400 && status !== 413 && status !== 422) return false
  return /context[ _-]?(length|window|size)|maximum context|too many tokens|prompt is too long|input is too long|exceeds? the (max|maximum|model)|token limit|context_length_exceeded/i.test(
    err.message,
  )
}
