import { isMpError } from '@mp/core'
import type { ChatMessage, ToolSpec } from '@mp/model'
import type { AssistantContent, RunContextSize, ToolResultContent } from '@mp/sessions'
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

/**
 * Percentage points the context must fall below a threshold before that threshold can be noted again. Small
 * dips (an offload, a short collapse) don't re-arm it; a compaction or a big collapse does.
 */
export const NOTE_REARM_MARGIN = 15

/**
 * The highest threshold noted in a history's current generation: the notes since its latest summary, or what
 * that summary recorded (`meta.contextNoted`, the level noted when it was written). Summaries written before
 * that was recorded reset it.
 */
export function notedInHistory(history: Entry[]): number {
  let noted = 0
  for (const e of history) {
    if (e.kind === 'summary') noted = typeof e.meta.contextNoted === 'number' ? e.meta.contextNoted : 0
    const n = e.meta.contextNote
    if (typeof n === 'number' && n > noted) noted = n
  }
  return noted
}

/**
 * Whether to tell the model about its context size now. `noted` is the highest threshold it was told about. A
 * threshold is noted once; it is armed again only when the context falls well below it (`margin` percentage
 * points), so it doesn't fire again on every small dip and rise. Returns the threshold to note (or undefined)
 * and the new `noted`.
 */
export function contextNoteDecision(
  percent: number,
  noted: number,
  thresholds: readonly number[],
  margin = NOTE_REARM_MARGIN,
): { note?: number; noted: number } {
  const crossed = thresholds.filter((t) => percent >= t)
  const top = crossed.length ? Math.max(...crossed) : 0
  // The thresholds told about that the context is still near: the highest of them stays noted.
  const held = thresholds.filter((t) => t <= noted && percent >= t - margin)
  const armed = held.length ? Math.max(...held) : 0
  if (top > armed) return { note: top, noted: top }
  return { noted: armed }
}

/** Something big in the history the model could free: a finished stretch of tool calls, or one tool result. */
export type ContextSuggestion =
  | { kind: 'collapse'; from: string; to: string; calls: number; names: string; tokens: number }
  | { kind: 'offload'; callId: string; name: string; tokens: number }
  /** A finished earlier request and all its work, from the request to its last entry. */
  | { kind: 'task'; from: string; to: string; request: string; tokens: number }

/** A note from the harness about the context (its size, what to free, a new request's boundary). */
const isContextNote = (e: Entry) =>
  e.meta.transient === true || typeof e.meta.contextNote === 'number' || e.meta.contextBoundary === true

/** Whether an entry is a request made in `runId` (its input, or one delivered while it worked), not a copy of an older one. */
const isNewRequest = (e: Entry, runId: string) =>
  (e.kind === 'user' || e.kind === 'event') && e.meta.runId === runId && typeof e.meta.copiedFrom !== 'string'

/**
 * Earlier requests in a history that are done, each with all of its work (collapses and replies included): from
 * the request to the entry before the next request. The requests of the current run, and everything from the
 * first of them on, are the current work and never count. Biggest first; none under `minTokens`.
 */
export function earlierTasks(
  history: Entry[],
  runId: string,
  perChar: number,
  o: { minTokens?: number } = {},
): ContextSuggestion[] {
  const current = history.findIndex((e) => isNewRequest(e, runId))
  const end = current < 0 ? history.length : current
  const starts: number[] = []
  for (let i = 1; i < end; i++) if (history[i]!.kind === 'user' || history[i]!.kind === 'event') starts.push(i)
  const tasks: Extract<ContextSuggestion, { kind: 'task' }>[] = []
  starts.forEach((s, k) => {
    const last = (starts[k + 1] ?? end) - 1
    if (last <= s) return
    const span = history.slice(s, last + 1)
    // A task still waiting on a tool call isn't finished.
    const answered = new Set(span.map(answeredCall).filter(Boolean))
    if (span.some((e) => callsOfEntry(e).some((c) => !answered.has(c.id)))) return
    const text = ((history[s]!.content as { text?: unknown } | null)?.text ?? '') as string
    const first = String(text).trim().split('\n')[0] ?? ''
    tasks.push({
      kind: 'task',
      from: history[s]!.id,
      to: history[last]!.id,
      request: first.length > 70 ? `${first.slice(0, 70)}…` : first,
      // The harness's own notes about the context aren't the task's work.
      tokens: span.filter((e) => !isContextNote(e)).reduce((n, e) => n + entryTokens(e, perChar), 0),
    })
  })
  return tasks.filter((t) => t.tokens >= (o.minTokens ?? 0)).sort((a, b) => b.tokens - a.tokens)
}

const callsOfEntry = (e: Entry) =>
  e.kind === 'assistant' ? ((e.content as unknown as AssistantContent | null)?.toolCalls ?? []) : []

/** `projects.read_file ×12, env.exec`: the tools of a stretch, most used first. */
function toolTally(names: string[]): string {
  const counts = new Map<string, number>()
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  const sorted = [...counts].sort((a, b) => b[1] - a[1])
  const shown = sorted.slice(0, 3).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
  return sorted.length > 3 ? `${shown.join(', ')} and ${sorted.length - 3} more` : shown.join(', ')
}

/**
 * The biggest things in a history the model could free now, biggest first, at most `max` (default 3): finished
 * stretches of consecutive tool-call turns (to collapse with sessions.rewind from/to) and single tool results
 * (to offload). Only finished work counts: never the latest turn (the model hasn't seen its results yet), never
 * a turn with a call still waiting for its result, never the first entry. Things under `minTokens` are left out.
 */
export function contextSuggestions(
  history: Entry[],
  perChar: number,
  o: { max?: number; minTokens?: number } = {},
): ContextSuggestion[] {
  const max = o.max ?? 3
  const minTokens = o.minTokens ?? 0
  const answered = new Set(history.map(answeredCall).filter(Boolean))
  // The latest turn with tool calls, and everything after it, is still the model's current work.
  let end = history.length
  for (let i = history.length - 1; i >= 1; i--) {
    if (history[i]!.kind === 'assistant') {
      if (callsOfEntry(history[i]!).length) end = i
      break
    }
  }
  const stretches: Extract<ContextSuggestion, { kind: 'collapse' }>[] = []
  /** Results, with the stretch they are part of (its first call). */
  const results: (Extract<ContextSuggestion, { kind: 'offload' }> & { in?: string })[] = []
  let cur: { from: string; to: string; names: string[]; tokens: number } | undefined
  const close = () => {
    if (cur && cur.names.length >= 2)
      stretches.push({
        kind: 'collapse',
        from: cur.from,
        to: cur.to,
        calls: cur.names.length,
        names: toolTally(cur.names),
        tokens: cur.tokens,
      })
    cur = undefined
  }
  for (let i = 1; i < end; i++) {
    const e = history[i]!
    const calls = callsOfEntry(e)
    if (calls.length) {
      // A turn with a call that never got its result can't be collapsed.
      if (!calls.every((c) => answered.has(c.id))) {
        close()
        continue
      }
      cur ??= { from: calls[0]!.id, to: calls[0]!.id, names: [], tokens: 0 }
      cur.to = calls[calls.length - 1]!.id
      cur.names.push(...calls.map((c) => c.name))
      cur.tokens += entryTokens(e, perChar)
      continue
    }
    if (answeredCall(e) !== undefined) {
      const t = entryTokens(e, perChar)
      if (cur) cur.tokens += t
      if (e.kind === 'tool_result') {
        const r = e.content as unknown as ToolResultContent
        results.push({ kind: 'offload', callId: r.toolCallId, name: r.name, tokens: t, ...(cur ? { in: cur.from } : {}) })
      }
      continue
    }
    // Notes between turns don't break a stretch; anything else (a message, a reply, a summary) does.
    if (e.kind === 'system') continue
    close()
  }
  close()
  const big = <T extends { tokens: number }>(xs: T[]) =>
    xs.filter((x) => x.tokens >= minTokens).sort((a, b) => b.tokens - a.tokens)
  const s = big(stretches)
  const shown = s.slice(0, max - 1)
  // A result inside a suggested stretch is worth its own line only when it is a big part of it.
  const r = big(results)
    .filter((x) => {
      const st = shown.find((y) => y.from === x.in)
      return !st || x.tokens * 3 >= st.tokens
    })
    .map(({ in: _in, ...x }) => x)
  // Mostly stretches (collapsing finished work is the main move), and the biggest single result.
  const pick: ContextSuggestion[] = [...shown, ...r.slice(0, 1)]
  for (const x of [...s.slice(max - 1), ...r.slice(1)]) if (pick.length < max) pick.push(x)
  return pick.slice(0, max).sort((a, b) => b.tokens - a.tokens)
}

/** One suggestion as a line of a note, with the call to make. */
export function suggestionLine(x: ContextSuggestion): string {
  if (x.kind === 'task')
    return (
      `- the earlier request "${x.request}" and all its work, ${x.from} … ${x.to}, ≈ ${kTokens(x.tokens)} tokens: ` +
      `sessions.rewind { from: "${x.from}", to: "${x.to}", summary } keeping only what the current work still needs`
    )
  if (x.kind === 'collapse')
    return (
      `- ${x.from} … ${x.to} (${x.names}) ≈ ${kTokens(x.tokens)} tokens: once you've noted what you need from them, ` +
      `sessions.rewind { from: "${x.from}", to: "${x.to}", summary }`
    )
  return `- ${x.callId} (${x.name}) ≈ ${kTokens(x.tokens)} tokens: if you no longer need it verbatim, sessions.offload { entryId: "${x.callId}", text }`
}

/** The text of an advisory context note, naming the biggest finished parts to free. */
export function contextNoteText(
  tokens: number,
  window: number,
  compactAt: number | undefined,
  suggestions: ContextSuggestion[] = [],
): string {
  const pct = Math.round((tokens / window) * 100)
  const auto = compactAt ? ` At ${compactAt}% the harness compacts automatically.` : ''
  const head = `[context: about ${kTokens(tokens)} of ${kTokens(window)} tokens (${pct}%)]`
  if (!suggestions.length)
    return (
      `${head} Nothing big is finished yet. When you finish a part, note what the rest needs, then collapse it with ` +
      `sessions.rewind { from: its first tool call, to: its last, summary }.${auto}`
    )
  return (
    `${head} The biggest finished parts:\n${suggestions.map(suggestionLine).join('\n')}\n` +
    `Collapse a part when it is done, keeping in the summary what the rest of the work needs verbatim (line numbers, quotes, ids).${auto}`
  )
}

/** The instruction near the limit: the model's next turn should free space. */
export function contextNearText(
  tokens: number,
  window: number,
  compactAt: number | undefined,
  suggestions: ContextSuggestion[] = [],
): string {
  const pct = Math.round((tokens / window) * 100)
  const auto = compactAt ? ` At ${compactAt}% the harness compacts automatically with its own summary.` : ''
  const suggested = suggestions.length ? ` Suggested:\n${suggestions.map(suggestionLine).join('\n')}\n` : ' '
  return (
    `[harness] Context nearly full (≈${kTokens(tokens)} of ${kTokens(window)} tokens, ${pct}%). Before continuing, free space: ` +
    `collapse finished work with sessions.rewind { from, to, summary } or compact with your own summary (sessions.compact { summary }).${suggested}` +
    "Keep in any summary everything the remaining work needs verbatim (exact line numbers, quotes, numbers, ids, paths) and what's still to do, " +
    `and put decisions and the current state in the session document (sessions.save_metadata { document }).${auto}`
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
- The goal and the deliverable, and who asked for it (names and where: thread, ticket, session).
- Decisions made, and why.
- The current state: what is done, what was tried and didn't work.
- What is still to do: the remaining steps, in order.
- Verbatim, everything the remaining work or the deliverable needs: exact line numbers, file paths, quotes, figures, ids, branches, links, ticket, thread and message ids. Copy them exactly; the earlier messages will be gone, so a paraphrase or "see above" loses them.

- Last, a line "Keywords: …": the words a later question about this material might use, synonyms and everyday words included, so a search in other words finds it.

Be concise and factual about everything else: at most about 2,000 words. The most recent messages are kept verbatim after your summary, so focus on what came before them.`

/** The heading of the session document's section that records automatic compactions. */
export const COMPACTIONS_HEADING = '## Compactions'

/**
 * A session document with one more line under its "Compactions" section (created at the end if missing): when
 * the context was compacted, and the summary (whole if short, else its start). The section keeps the latest
 * `keep` lines, so the document stays bounded.
 */
export function withCompactionLine(
  doc: string,
  c: { at: string; tokens: number; window: number; summary: string },
  keep = 5,
): string {
  const flat = c.summary.replace(/\s+/g, ' ').trim()
  const text = flat.length <= 600 ? flat : `${flat.slice(0, 400).replace(/\s\S*$/, '')} …`
  const line = `- ${c.at.slice(0, 16).replace('T', ' ')}: context compacted automatically at about ${kTokens(c.tokens)} of ${kTokens(c.window)} tokens. Summary: ${text}`
  const lines = doc ? doc.split('\n') : []
  const at = lines.findIndex((l) => l.trim() === COMPACTIONS_HEADING)
  if (at < 0) return `${doc.trimEnd()}${doc.trim() ? '\n\n' : ''}${COMPACTIONS_HEADING}\n\n${line}\n`
  let end = lines.findIndex((l, i) => i > at && /^#{1,2} /.test(l))
  if (end < 0) end = lines.length
  const items = lines.slice(at + 1, end).filter((l) => l.startsWith('- '))
  const next = [...items, line].slice(-keep)
  const after = lines.slice(end)
  return [...lines.slice(0, at + 1), '', ...next, ...(after.length ? ['', ...after] : [''])].join('\n')
}

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

/** The note at the start of a run whose history holds big finished requests: the moment to keep only what's needed. */
export function taskBoundaryText(tokens: number, window: number, tasks: ContextSuggestion[]): string {
  const total = tasks.reduce((n, t) => n + t.tokens, 0)
  return (
    `[context: about ${kTokens(tokens)} of ${kTokens(window)} tokens, ${kTokens(total)} of it earlier requests that are done] ` +
    'A new request is a good point to keep only what it needs. Unless you need their detail now, collapse them, each into a ' +
    'summary of what the current work still needs from it (decisions, results, exact ids); the detail stays findable with sessions.search. ' +
    'Left as they are, the harness collapses them at the next request, keeping each request and the final reply to it word for word:\n' +
    tasks.map(suggestionLine).join('\n')
  )
}

/** The text a model saw for an entry (a tool result's output as it is rendered). */
export function entryText(e: Entry): string {
  const c = e.content as Record<string, unknown> | null
  if (e.kind === 'tool_result') {
    const out = c?.output
    const body = typeof out === 'string' ? out : JSON.stringify(out)
    return c?.isError ? `ERROR: ${body}` : body
  }
  if (c && typeof c.text === 'string') return c.text
  return JSON.stringify(c)
}

/** Lines an index of a collapsed stretch lists at most. */
export const INDEX_MAX = 40

/**
 * The index appended to a collapse summary: each tool call the stretch replaced, with its arguments and the entry
 * holding its result, so a later question can read back the one result it needs instead of searching. Earlier
 * summaries and messages in the stretch are listed too, so a collapse of collapses (a whole finished task) still
 * leads to every part: each earlier summary carries its own index. Calls in `skip` are left out.
 */
export function collapseIndex(stretch: Entry[], skip: Set<string>, perChar: number): string {
  const results = new Map<string, Entry>()
  for (const e of stretch) {
    const id = answeredCall(e)
    if (id) results.set(id, e)
  }
  const lines: string[] = []
  const firstLine = (e: Entry, max = 80) => {
    const t =
      entryText(e)
        .replace(/\[index of what this summary replaced[\s\S]*$/, '')
        .trim()
        .split('\n')[0] ?? ''
    return t.length > max ? `${t.slice(0, max)}…` : t
  }
  for (const e of stretch) {
    if (e.kind === 'summary')
      lines.push(
        `- an earlier summary → entry ${e.id} (≈${kTokens(entryTokens(e, perChar))} tokens; its own index lists what it replaced): ${firstLine(e)}`,
      )
    else if (e.kind === 'user' || e.kind === 'event') lines.push(`- a message → entry ${e.id}: ${firstLine(e)}`)
    for (const c of callsOfEntry(e)) {
      if (skip.has(c.id)) continue
      const r = results.get(c.id)
      const args = (c.arguments ?? '').replace(/\s+/g, ' ')
      const shown = args.length > 100 ? `${args.slice(0, 100)}…` : args
      lines.push(`- ${c.name} ${shown}${r ? ` → entry ${r.id} (≈${kTokens(entryTokens(r, perChar))} tokens)` : ''}`)
    }
  }
  if (!lines.length) return ''
  const more = lines.length > INDEX_MAX ? [`- … and ${lines.length - INDEX_MAX} more (sessions.contents lists them all)`] : []
  return `\n\n[index of what this summary replaced: find a detail in it with sessions.search { text, includeThisSession: true }, or read one result back with sessions.restore { entryId, offset: 0 }]\n${[...lines.slice(0, INDEX_MAX), ...more].join('\n')}`
}

/**
 * The collapse the harness makes itself at a new request when the model left finished requests it was told about
 * (`named`, the requests of an earlier boundary note) in its context: one stretch from the first of them to the end
 * of the last, every request in it and the final reply to each kept word for word right after the summary, the work
 * in between replaced by an index. Undefined when none of the named requests is still there.
 */
export function boundaryCollapse(
  history: Entry[],
  runId: string,
  perChar: number,
  named: Set<string>,
): { toEntry: string; keepAfter: string; carry: string[]; summary: string; requests: number; tokens: number } | undefined {
  const ignored = earlierTasks(history, runId, perChar).flatMap((t) => (t.kind === 'task' && named.has(t.from) ? [t] : []))
  if (!ignored.length) return undefined
  const at = (id: string) => history.findIndex((e) => e.id === id)
  const start = Math.min(...ignored.map((t) => at(t.from)))
  const end = Math.max(...ignored.map((t) => at(t.to)))
  const stretch = history.slice(start, end + 1)
  const carry: string[] = []
  let reply: Entry | undefined
  const close = () => {
    if (reply) carry.push(reply.id)
    reply = undefined
  }
  for (const e of stretch) {
    if (isContextNote(e)) continue
    if (e.kind === 'user' || e.kind === 'event') {
      close()
      carry.push(e.id)
    } else if (e.kind === 'assistant' && !callsOfEntry(e).length && entryText(e).trim()) reply = e
  }
  close()
  const requests = stretch.filter((e) => (e.kind === 'user' || e.kind === 'event') && !isContextNote(e)).length
  const tokens = stretch.filter((e) => !isContextNote(e)).reduce((n, e) => n + entryTokens(e, perChar), 0)
  const summary =
    `[the harness collapsed ${requests === 1 ? 'an earlier request that is done' : `${requests} earlier requests that are done`} (about ${kTokens(tokens)} tokens), ` +
    'which were left in the context after a note about them. ' +
    `${requests === 1 ? 'The request and the final reply to it follow' : 'Each request and the final reply to it follow'} word for word; ` +
    'the work in between is in the index below]' +
    collapseIndex(
      stretch.filter((e) => !isContextNote(e)),
      new Set(),
      perChar,
    )
  return { toEntry: history[start - 1]!.id, keepAfter: history[end]!.id, carry, summary, requests, tokens }
}
