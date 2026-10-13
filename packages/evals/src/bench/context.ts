import type { Json } from '@mp/core'
import { startEvalApp } from '../app.ts'
import type { ModelEnv } from '../env.ts'
import {
  buildArchive,
  followUpIncidents,
  followUpsText,
  scoreAnswer,
  scoreFollowUps,
  classifyFollowUps,
  classifyFuzzy,
  fuzzyIncidents,
  fuzzyText,
  type Archive,
  type Score,
} from './archive.ts'

/**
 * The context benchmark: one long task (audit a paged incident archive much bigger than the context window,
 * and report exact details from all of it) run under different context strategies, with the same model,
 * archive and window. See CONTEXT.md.
 */

export interface Arm {
  name: string
  description: string
  /** App settings for this arm. */
  env: Record<string, string>
  /** Whether the session gets the context tools (rewind, offload, restore, compact, contents). */
  contextTools: boolean
}

export const CONTEXT_TOOLS = [
  'sessions.rewind',
  'sessions.offload',
  'sessions.restore',
  'sessions.compact',
  'sessions.contents',
  'sessions.search',
]

export const ARMS: Arm[] = [
  {
    name: 'classic',
    description: 'classic compaction: at 85% the whole history is summarised, nothing else',
    env: { CONTEXT_NOTES: 'off', CONTEXT_NEAR_AT: '0', CONTEXT_COMPACT_KEEP: '0', TOOL_RESULT_MAX_CHARS: '0' },
    contextTools: false,
  },
  {
    name: 'safety-net',
    description: 'our automatic compaction alone: at 85%, keeping the latest 15% verbatim',
    env: { CONTEXT_NOTES: 'off', CONTEXT_NEAR_AT: '0', TOOL_RESULT_MAX_CHARS: '0' },
    contextTools: false,
  },
  {
    name: 'managed-early',
    description: 'everything, with notes at 50% and 75% (the default before the benchmark): more, smaller collapses',
    env: { CONTEXT_NOTES: '50,75' },
    contextTools: true,
  },
  {
    name: 'managed',
    description: 'everything, as deployed: a note at 70%, the free-space turn at 80%, the context tools, compaction at 85%',
    env: {},
    contextTools: true,
  },
]

export interface BenchOptions {
  modelEnv: ModelEnv
  /** The context window the harness enforces (the model's real one is bigger). */
  window: number
  pages: number
  seed: number
  maxSteps: number
  timeoutMs: number
  /** Ask a follow-up question about a detail nobody asked for, after the report (default true). */
  followUp?: boolean
  /**
   * `archive`: pages can be read again (default). `feed`: each page can be read once, like events that arrive and
   * are gone, so a later question can only be answered from the session's own history.
   */
  source?: 'archive' | 'feed'
  /** Incidents the follow-up asks about, on pages spread across the archive (default 1: one on page 3). */
  followUps?: number
  /** Incidents a second follow-up describes in other words, without their ids (default 0: none). */
  fuzzyFollowUps?: number
}

/** What one phase of a run cost and did. */
export interface PhaseStats {
  /** Model calls, including the summary calls of automatic compactions. */
  calls: number
  promptTokens: number
  cachedTokens: number
  completionTokens: number
  /** The biggest prompt sent, in tokens. */
  peakPrompt: number
  /** Automatic compactions plus sessions.compact calls. */
  compactions: number
  compactionsFailed: number
  collapses: number
  offloads: number
  restores: number
  notes: number
  /** archive.read_page calls that returned a page. */
  reads: number
  /** Model calls the client retried (overload, 5xx, a broken stream): a retried stream may still be billed. */
  retries: number
  durationMs: number
}

/** A follow-up question (or several in one message) and how it was answered. */
export interface FollowUp {
  state: string
  /** Every asked detail right. */
  correct: boolean
  /** Incidents answered with both details right, of how many asked. */
  right: number
  of: number
  /** Wrong answers that gave a ticket or deploy id that isn't the incident's own. */
  invented: number
  /** Wrong answers that said the details weren't available. */
  abstained: number
  answer: string
  stats: PhaseStats
  error?: string
}

export interface BenchRun {
  arm: string
  repeat: number
  state: string
  score: Score
  answer: string
  report: PhaseStats
  /** The follow-up question about a detail from an early page, asked in the same session after the report. */
  followUp?: FollowUp
  /** The same question asked of a new session that starts from zero (archive source only): the cost of not asking. */
  fresh?: FollowUp
  /** Follow-ups that describe incidents instead of naming them, asked after the others in the same session. */
  fuzzy?: FollowUp
  trace: string[]
  error?: string
}

export function taskText(pages: number, source: 'archive' | 'feed' = 'archive'): string {
  return [
    `Audit the incident archive. Read it with archive.read_page, starting at { "page": 1, "cursor": "start" }; each page ends with the call for the next one. There are ${pages} pages, read them all.`,
    ...(source === 'feed' ? ['It is a one-time feed: each page can be read only once, and is gone after that.'] : []),
    'Then reply with the audit report and nothing else:',
    '- first line: the audit reference given on page 1;',
    '- then one line per incident whose final severity is SEV1 (a CORRECTION on a later page supersedes the original record), exactly in the form',
    '  INC-12345 | path/to/file.ts:123 | First Last',
    '  with the root-cause location and the on-call engineer from its record.',
  ].join('\n')
}

const emptyStats = (): PhaseStats => ({
  calls: 0,
  promptTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  peakPrompt: 0,
  compactions: 0,
  compactionsFailed: 0,
  collapses: 0,
  offloads: 0,
  restores: 0,
  notes: 0,
  reads: 0,
  retries: 0,
  durationMs: 0,
})

/** Runs one arm once: a fresh app, a session with the archive tool, the task, the follow-up, and the measurements. */
export async function runArm(arm: Arm, repeat: number, o: BenchOptions, archive: Archive): Promise<BenchRun> {
  /** Pages read so far, in a feed. */
  const consumed = new Set<number>()
  const app = await startEvalApp({
    modelEnv: o.modelEnv,
    maxSteps: o.maxSteps,
    timeoutMs: o.timeoutMs,
    env: { MODEL_CONTEXT_TOKENS: String(o.window), ...arm.env },
    setup: (s) => {
      s.tools.register(
        {
          name: 'archive.read_page',
          description:
            'Read one page of the incident archive. Pages are read in order: each page ends with the cursor of the next.',
          parameters: {
            type: 'object',
            properties: { page: { type: 'number' }, cursor: { type: 'string' } },
            required: ['page', 'cursor'],
          },
          effect: 'read',
          source: 'stdlib',
        },
        async (args) => {
          const a = args as { page?: number; cursor?: string }
          const i = Number(a.page) - 1
          if (!Number.isInteger(i) || i < 0 || i >= archive.pages.length)
            return { output: { error: `no page ${a.page}: the archive has ${archive.pages.length}` }, isError: true }
          if (o.source === 'feed' && consumed.has(i))
            return { output: { error: `page ${a.page} was already read: the feed keeps no copy` }, isError: true }
          if (a.cursor !== archive.cursors[i])
            return {
              output: { error: `wrong cursor for page ${a.page}: it is at the end of page ${i} (the start cursor is "start")` },
              isError: true,
            }
          consumed.add(i)
          return { output: archive.pages[i]! }
        },
      )
    },
  })
  const { ctx, logs } = app
  let logsSeen = 0
  /** Warnings and errors the app logged since the last call, into the trace. */
  const traceLogs = () => {
    for (const l of logs.slice(logsSeen)) {
      if (l.msg === 'model call failed, retrying') stats.retries++
      if (l.level === 'warn' || l.level === 'error')
        trace.push(`[${l.level}] ${l.msg}${l.fields.err !== undefined ? `: ${String(l.fields.err)}` : ''}`)
    }
    logsSeen = logs.length
  }
  const s = ctx.services
  // Counted from live events: a later collapse folds earlier tool calls (rewinds included) out of the history.
  let stats = emptyStats()
  /** What happened, in order: each model call's prompt size and tool calls, and the context events between them. */
  const trace: string[] = []
  const k = (n: number | undefined) => `${Math.round((n ?? 0) / 100) / 10}k`
  const subs = [
    s.bus.subscribe<{ tokensBefore?: number; tokensAfter?: number }>('context.compacted', (m) => {
      stats.compactions++
      trace.push(`auto-compaction ${k(m.payload.tokensBefore)} → ${k(m.payload.tokensAfter)}`)
    }),
    s.bus.subscribe<{ error?: string }>('context.compact_failed', (m) => {
      stats.compactionsFailed++
      trace.push(`auto-compaction failed: ${m.payload.error}`)
    }),
    s.bus.subscribe('context.result_offloaded', () => {
      stats.offloads++
      trace.push('auto-offload')
    }),
    s.bus.subscribe<{ percent?: number; near?: boolean; suggestions?: number }>('context.noted', (m) => {
      stats.notes++
      trace.push(`note ${m.payload.percent}%${m.payload.near ? ' (free space now)' : ''}, ${m.payload.suggestions} suggestions`)
    }),
    s.bus.subscribe<{
      usage?: { promptTokens?: number; cachedTokens?: number; completionTokens?: number }
      purpose?: string
      employeeId?: string
    }>('usage.recorded', (m) => {
      // The usage service publishes the same topic again once it has recorded the call: count the runner's only.
      if (m.payload.employeeId !== undefined) return
      const u = m.payload.usage ?? {}
      stats.calls++
      stats.promptTokens += u.promptTokens ?? 0
      stats.cachedTokens += u.cachedTokens ?? 0
      stats.completionTokens += u.completionTokens ?? 0
      stats.peakPrompt = Math.max(stats.peakPrompt, u.promptTokens ?? 0)
      trace.push(`${m.payload.purpose === 'compaction' ? 'summary call' : 'model call'} ${k(u.promptTokens)}`)
    }),
    s.bus.subscribe<{ name?: string; isError?: boolean }>('tool.result', (m) => {
      trace.push(`  ${m.payload.name}${m.payload.isError ? ' (error)' : ''}`)
      if (m.payload.isError) return
      if (m.payload.name === 'archive.read_page') stats.reads++
      if (m.payload.name === 'sessions.rewind') stats.collapses++
      if (m.payload.name === 'sessions.offload') stats.offloads++
      if (m.payload.name === 'sessions.restore') stats.restores++
      if (m.payload.name === 'sessions.compact') stats.compactions++
    }),
  ]
  /** Runs one instruction in the session until everything settles; its stats and the run's outcome. */
  const phase = async (sessionId: string, text: string) => {
    stats = emptyStats()
    const started = Date.now()
    const run = await s.sessions.createRun({
      sessionId,
      cause: { type: 'manual' },
      input: [{ kind: 'user', content: { text } as Json }],
    })
    await s.runner.enqueue(run.id)
    await ctx.settle(o.timeoutMs)
    const done = await s.sessions.requireRun(run.id)
    stats.durationMs = Date.now() - started
    traceLogs()
    return {
      state: done.data.state,
      answer: typeof done.data.result?.output === 'string' ? done.data.result.output : '',
      stats,
      error: done.data.state !== 'completed' ? (done.data.pauseReason ?? done.data.result?.error ?? done.data.state) : undefined,
    }
  }
  try {
    const employee = await s.directory.employees.byHandle('meatless')
    if (!employee) throw new Error('the default employee is missing')
    const contact = await s.directory.employees.contact(employee.id)
    let prompt = s.stdlib ? s.stdlib.employeePrompt({ employee, contact, now: s.clock.iso() }) : 'You are an employee.'
    // Without the context tools, the prompt's guidance about them would only confuse the model.
    if (!arm.contextTools) prompt = prompt.replace(/^- Context: .*$/m, '')
    const newSession = (title: string) =>
      s.sessions.create({
        employeeId: employee.id,
        title,
        toolset: ['archive.read_page', ...(arm.contextTools ? CONTEXT_TOOLS : [])],
        entries: [{ kind: 'system', content: { text: prompt } }],
      })
    const session = await newSession('Incident archive audit')
    const report = await phase(session.id, taskText(archive.pages.length, o.source))
    trace.push('— follow-up —')
    const xs = followUpIncidents(archive, o.followUps ?? 1)
    const asking = o.followUp !== false && report.state === 'completed'
    const follow = asking ? await phase(session.id, followUpsText(xs)) : undefined
    let fresh: Awaited<ReturnType<typeof phase>> | undefined
    if (asking && o.source !== 'feed') {
      trace.push('— fresh session —')
      const other = await newSession('A question about the incident archive')
      fresh = await phase(
        other.id,
        `The incident archive is read with archive.read_page, starting at { "page": 1, "cursor": "start" }; each page ends with the call for the next one. ${followUpsText(xs)}`,
      )
    }
    let fuzzy: FollowUp | undefined
    const fz = asking && (o.fuzzyFollowUps ?? 0) > 0 ? fuzzyIncidents(archive, o.fuzzyFollowUps!, xs) : []
    if (fz.length) {
      trace.push('— fuzzy follow-up —')
      const p = await phase(session.id, fuzzyText(fz))
      const c = classifyFuzzy(fz, p.answer)
      fuzzy = {
        state: p.state,
        correct: c.right === fz.length,
        ...c,
        of: fz.length,
        ...(p.error ? { error: p.error } : {}),
        answer: p.answer,
        stats: p.stats,
      }
    }
    const graded = (p: Awaited<ReturnType<typeof phase>>) => ({
      state: p.state,
      correct: scoreFollowUps(xs, p.answer) === xs.length,
      ...classifyFollowUps(xs, p.answer),
      of: xs.length,
      ...(p.error ? { error: p.error } : {}),
      answer: p.answer,
      stats: p.stats,
    })
    return {
      arm: arm.name,
      repeat,
      state: report.state,
      score: scoreAnswer(archive, report.answer),
      answer: report.answer,
      report: report.stats,
      ...(follow ? { followUp: graded(follow) } : {}),
      ...(fresh ? { fresh: graded(fresh) } : {}),
      ...(fuzzy ? { fuzzy } : {}),
      trace,
      ...(report.error ? { error: report.error } : {}),
    }
  } catch (err) {
    return {
      arm: arm.name,
      repeat,
      state: 'error',
      score: scoreAnswer(archive, ''),
      answer: '',
      report: stats,
      trace,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    for (const u of subs) u()
    await app.close()
  }
}

export { buildArchive }
