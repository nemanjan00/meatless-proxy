import {
  ConflictError,
  defineHook,
  errorMessage,
  isMpError,
  silentLogger,
  systemClock,
  type Clock,
  type EventBus,
  type Hooks,
  type Json,
  type Logger,
} from '@mp/core'
import { contextWindowOf, type ChatMessage, type ImageRef, type ModelClient, type ModelResponse, type ToolSpec } from '@mp/model'
import type { Queue } from '@mp/queue'
import { createRedactor, type SecretStore } from '@mp/secrets'
import {
  currentRequester,
  type AssistantContent,
  type Run,
  type RunContextSize,
  type RunResult,
  type Session,
  type Sessions,
  type ToolResultContent,
  type WaitCondition,
} from '@mp/sessions'
import type { Entry } from '@mp/store'
import {
  LOADED_TOOLS_META,
  loadedToolsOf,
  type ControlSignal,
  type ToolContext,
  type ToolDefinition,
  type ToolLists,
  type ToolRegistry,
  type ToolResult,
} from '@mp/tools'
import { answeredCall, lastAssistantText, renderMessages } from './context.ts'
import {
  COMPACTION_PROMPT,
  compactionCut,
  contextNearText,
  contextNoteDecision,
  contextNoteText,
  contextSuggestions,
  estimateTokens,
  isContextOverflow,
  kTokens,
  notedInHistory,
  oversizedPointerText,
  requestChars,
  tokensPerChar,
  withCompactionLine,
} from './context-window.ts'
import { createImageResolver, VISION_TAG, type LoadedImage } from './images.ts'

export const RUNS_QUEUE = 'runs'

/** Bus topics the runner publishes about context management. */
export const ContextTopics = {
  /** `{ runId, sessionId, automatic, tokensBefore, tokensAfter, window, keptEntries }` */
  compacted: 'context.compacted',
  /** `{ runId, sessionId, error }`: the summary call of an automatic compaction failed; the run carries on. */
  compactFailed: 'context.compact_failed',
  /**
   * `{ runId, sessionId, tokens, window, percent, near, suggestions }`: the model was told how full its context is
   * (`near`: asked to free space in its next turn), with `suggestions` concrete things to free.
   */
  noted: 'context.noted',
  /** `{ runId, sessionId, callId, name, chars, entryId }`: an oversized tool result was kept as a preview. */
  resultOffloaded: 'context.result_offloaded',
} as const

// ─── Hook points (declared here, registered by higher layers) ──────────────

export interface RunContext {
  run: Run
  session: Session
}

/** Before each model call. `{ pause }` pauses the run (e.g. over budget). */
export const beforeModelCall = defineHook<RunContext & { messages: ChatMessage[]; step: number }, { pause: string }>(
  'runner.beforeModelCall',
)

/** After each model call, e.g. to record usage. Decisions are ignored. */
export const afterModelCall = defineHook<RunContext & { response: ModelResponse; step: number; model: string }, never>(
  'runner.afterModelCall',
)

/** Before each tool call. `{ deny }` refuses the call; the model sees the reason. */
export const beforeToolCall = defineHook<RunContext & { tool: ToolDefinition; args: unknown; callId: string }, { deny: string }>(
  'runner.beforeToolCall',
)

/** After each tool call: transform the result (redaction, trimming). */
export const afterToolCall = defineHook<RunContext & { tool: ToolDefinition; result: ToolResult }, never>('runner.afterToolCall')

/**
 * Before a run finishes. `{ block }` sends the message back to the model and
 * keeps the run going (docs maintenance, checklist gate…). Like a Stop hook.
 */
export const beforeFinish = defineHook<RunContext & { status: 'completed' | 'failed'; output?: string }, { block: string }>(
  'runner.beforeFinish',
)

/** After a run reached a terminal state. Decisions are ignored. */
export const afterRun = defineHook<RunContext & { result: RunResult }, never>('runner.afterRun')

// ─── Options ───────────────────────────────────────────────────────────────

export interface RunnerOptions {
  sessions: Sessions
  tools: ToolRegistry
  model: ModelClient
  queue: Queue
  hooks: Hooks
  secrets?: SecretStore
  bus?: EventBus
  clock?: Clock
  logger?: Logger
  /** Allow and deny lists of an employee. */
  toolListsFor: (employeeId: string) => Promise<ToolLists>
  /** The project a session works on, for secret scoping. */
  projectOf?: (session: Session) => Promise<string | undefined>
  /** Model calls per run before it pauses. Default 60. */
  maxSteps?: number
  /** Wall-clock time a run may work before it pauses, when `limitsFor` doesn't say. Default: none. */
  maxWallMs?: number
  /**
   * The limits of a run, read before it starts and before every model call (e.g. from `@mp/usage`):
   * its step and wall-clock limits, and how many runs its employee may have working at once.
   */
  limitsFor?: (run: Run, session: Session) => Promise<RunLimits>
  /** How long a run held back by its employee's concurrency cap waits before it is tried again. Default 3000. */
  concurrencyRetryMs?: number
  /** Times `beforeFinish` may block before the run pauses for a person. Default 3. */
  maxFinishBlocks?: number
  maxTokens?: number
  /**
   * Whether the model can see images (`MODEL_VISION`). Off: tools tagged `vision` (image.view) are
   * neither offered nor run, and images in a history are replaced by a short note. Default false.
   */
  vision?: boolean
  /**
   * Loads the bytes of an image a history refers to, when a request is built. Null when it is gone
   * or its bytes changed (the model then sees "[image no longer available]").
   */
  loadImage?: (ref: ImageRef) => Promise<LoadedImage | null>
  /**
   * The tool names a session should have now, read when a run starts; undefined keeps its toolset as it
   * is (a deliberately narrowed one). A session's toolset is fixed when it is created, so tools added
   * since would never reach it: the runner brings it up to date and tells the model what changed, since
   * its history may say a tool is missing.
   */
  currentToolset?: (session: Session) => Promise<string[] | undefined>
  /**
   * Tools on demand (`TOOLS_ON_DEMAND`): for a session, which tools of its toolset are offered only once
   * loaded; undefined (or no option) offers every tool of the toolset. A session is offered the others,
   * the tools listed in its meta (`LOADED_TOOLS_META`), and the tools its history has called (a fork's
   * inherited calls). A call to an on-demand tool that isn't loaded, but is in the toolset and allowed,
   * loads it and runs: the call is valid, and the tool stays loaded.
   */
  onDemand?: (session: Session) => ((name: string) => boolean) | undefined
  /**
   * The current text of a session's first entry (the employee prompt it was created with), read when a
   * run starts; undefined keeps it. The model sees the current text in place of the stored one.
   */
  currentPrompt?: (session: Session, stored: string) => Promise<string | undefined>
  /** The context window of a model, in tokens. Default: `contextWindowOf` (the known table, else 128k). */
  contextWindow?: (model: string) => number
  /**
   * Context sizes (percent of the window) at which the model gets a note about it, naming the biggest finished
   * parts it could free. Each fires once, and again only after the context fell well below it. Default [50, 75].
   */
  contextNotes?: number[]
  /**
   * Percent of the window at which the model is asked, in its next turn, to free space before it goes on
   * (`CONTEXT_NEAR_AT`): collapse finished work or compact with its own summary. Only below `compactAt`, which
   * stays the safety net. Default 80; 0 turns it off.
   */
  contextNearAt?: number
  /**
   * Percent of the window at which the runner compacts the context by itself before the next model call
   * (`CONTEXT_COMPACT_AT`). Default 85; 0 turns it off.
   */
  compactAt?: number
  /** Share of the window kept verbatim after an automatic compaction (the latest entries). Default 0.15. */
  compactKeep?: number
  /** max_tokens of the summary call of an automatic compaction (reasoning included). Default 8000. */
  compactSummaryMaxTokens?: number
  /**
   * Tool results whose text is longer than this many characters are stored in full and kept in the history as
   * a preview (head and tail) with a pointer (`TOOL_RESULT_MAX_CHARS`). Default 20000; 0 turns it off.
   */
  toolResultMaxChars?: number
}

/** Limits of one run. Missing fields fall back to the runner's options. */
export interface RunLimits {
  maxSteps?: number
  maxWallMs?: number
  /** Runs of the same employee working (`running`) at once; a run over it stays queued and is tried again. */
  maxConcurrentRuns?: number
}

export type ExecuteOutcome =
  | { status: 'completed' | 'failed' | 'cancelled'; runId: string }
  | { status: 'suspended' | 'paused'; runId: string; reason?: string }
  | { status: 'skipped'; runId: string; reason: string }

export interface Runner {
  /**
   * Executes (or resumes) a run until it finishes, suspends or pauses. Safe to
   * call for a run another worker already finished: it's skipped. Throws only
   * for errors worth retrying (e.g. the model provider is unavailable): the
   * run stays `running` and the next attempt resumes from its journal.
   */
  execute(runId: string): Promise<ExecuteOutcome>
  /** Re-queues suspended runs whose wait is satisfied. Called when runs end and by timers. */
  wake(runId: string): Promise<boolean>
  /** Adds a run to the queue. */
  enqueue(runId: string, opts?: { delayMs?: number; priority?: number }): Promise<void>
}

const WAKE_PREFIX = 'wake:'

export function createRunner(opts: RunnerOptions): Runner {
  const { sessions, tools, model, queue, hooks } = opts
  const clock = opts.clock ?? systemClock
  const baseLogger = opts.logger ?? silentLogger
  const maxSteps = opts.maxSteps ?? 60
  const maxFinishBlocks = opts.maxFinishBlocks ?? 3
  const noLimits: RunLimits = {}
  const limitsOf = async (run: Run, session: Session): Promise<RunLimits> =>
    opts.limitsFor ? await opts.limitsFor(run, session) : noLimits
  /** How long the run has been working: earlier work plus the time since it last started. */
  const activeMs = (run: Run) => {
    const since = run.data.runningSince ?? run.data.startedAt
    return (run.data.activeMs ?? 0) + (since ? Math.max(0, clock.now() - Date.parse(since)) : 0)
  }
  const minutes = (ms: number) => {
    const m = Math.round(ms / 60_000)
    return m < 1 ? `${Math.round(ms / 1000)} seconds` : m === 1 ? '1 minute' : `${m} minutes`
  }
  const emit = (topic: string, payload: unknown) => opts.bus?.publish(topic, payload)
  const windowOf = (m: string) => opts.contextWindow?.(m) ?? contextWindowOf(m)
  const noteAt = [...(opts.contextNotes ?? [50, 75])].filter((t) => t > 0).sort((a, b) => a - b)
  const compactAt = opts.compactAt ?? 85
  const nearAt = opts.contextNearAt ?? 80
  /** Every threshold the model is told about: the notes, and the near-limit instruction when it comes before compaction. */
  const nearOn = nearAt > 0 && (!compactAt || nearAt < compactAt)
  const thresholds = [...new Set([...noteAt, ...(nearOn ? [nearAt] : [])])].sort((a, b) => a - b)
  const compactKeep = opts.compactKeep ?? 0.15
  const summaryMaxTokens = opts.compactSummaryMaxTokens ?? 8000
  const resultMaxChars = opts.toolResultMaxChars ?? 20_000

  const enqueue: Runner['enqueue'] = async (runId, o = {}) => {
    await queue.add(
      RUNS_QUEUE,
      { runId },
      { jobId: o.delayMs ? `${WAKE_PREFIX}${runId}:${clock.now() + o.delayMs}` : runId, ...o },
    )
  }
  let wakeSeq = 0
  /**
   * Re-queues a woken run under a fresh job id: its previous job may still be
   * active (it suspended moments ago), and a queue drops jobs whose id is still
   * in use. Running twice is safe: only one `queued -> running` transition wins.
   */
  const requeue = (runId: string, priority: number) =>
    queue.add(RUNS_QUEUE, { runId }, { jobId: `${WAKE_PREFIX}${runId}:${clock.now()}:${++wakeSeq}`, priority })

  const wake: Runner['wake'] = async (runId) => {
    const run = await sessions.getRun(runId)
    if (run?.data.state !== 'suspended') return false
    if (!(await sessions.isWaitSatisfied(run))) return false
    try {
      await sessions.transition(runId, 'suspended', 'queued')
    } catch (err) {
      if (isMpError(err, 'conflict')) return false
      throw err
    }
    await requeue(runId, run.data.priority)
    return true
  }

  const scheduleTimers = async (run: Run, wait: WaitCondition) => {
    const at = wait.type === 'timer' ? wait.until : wait.timeoutAt
    if (!at) return
    const delayMs = Math.max(0, Date.parse(at) - clock.now())
    await enqueue(run.id, { delayMs })
  }

  const wakeWaiters = async (runId: string) => {
    for (const w of await sessions.waitersOf(runId)) await wake(w.id)
  }

  const finish = async (run: Run, session: Session, result: RunResult): Promise<ExecuteOutcome> => {
    let current = await sessions.requireRun(run.id)
    if (result.status === 'completed') {
      const wantCommit = current.data.mode === 'continuing' ? current.data.commit !== false : current.data.commit === true
      if (wantCommit) {
        try {
          if (current.data.commitSummary) await sessions.commitSummary(run.id, current.data.commitSummary)
          else await sessions.commit(run.id)
        } catch (err) {
          if (!isMpError(err, 'conflict')) throw err
          // The head moved while this run worked: keep a summary on top of the new head instead.
          const history = await sessions.runHistory(run.id)
          const summary = current.data.commitSummary ?? lastAssistantText(history) ?? 'Run completed.'
          await sessions.commitSummary(run.id, summary)
        }
      }
    }
    current = await sessions.transition(run.id, 'running', result.status, { result, endedAt: clock.iso() })
    await hooks.decide(afterRun, { run: current, session, result })
    await wakeWaiters(run.id)
    await followUpInbox(current, session)
    return { status: result.status, runId: run.id }
  }

  /**
   * A delivery that reached a continuing run's inbox during its last step is still unread when the run
   * ends. If any of it asks the session to act, a new run picks it up; otherwise it waits for next time.
   */
  const followUpInbox = async (run: Run, session: Session) => {
    if (run.data.mode !== 'continuing' || run.data.state !== 'completed') return
    const left = (await sessions.inbox(session.id)).filter((i) => i.data.expectedToAct)
    if (!left.length) return
    if (await sessions.activeContinuingRun(session.id)) return
    const next = await sessions.createRun({
      sessionId: session.id,
      mode: 'continuing',
      cause: { type: 'event', eventId: left[0]!.data.eventId, note: 'inbox' },
      // Whoever sent the delivery it picks up, else whoever the last run worked for.
      ...((left[0]!.data.requesterId ?? currentRequester(run))
        ? { requesterId: left[0]!.data.requesterId ?? currentRequester(run) }
        : {}),
      priority: run.data.priority,
    })
    await enqueue(next.id, { priority: run.data.priority })
    baseLogger.info('run started for deliveries that arrived as the last one ended', {
      sessionId: session.id,
      runId: next.id,
      items: left.length,
    })
  }

  const vision = opts.vision === true
  const resolveImages = createImageResolver({ vision, ...(opts.loadImage ? { load: opts.loadImage } : {}), logger: baseLogger })
  /** A vision tool (image.view) when the model can't see images. */
  const blind = (def: ToolDefinition) => !vision && !!def.tags?.includes(VISION_TAG)

  /** Tool names called in a history: a fork inherits its parent's calls, so it keeps being offered those tools. */
  const calledIn = (history: Entry[]) => {
    const out = new Set<string>()
    for (const e of history) {
      if (e.kind !== 'assistant') continue
      for (const c of (e.content as unknown as AssistantContent).toolCalls ?? [])
        out.add(tools.resolveProviderName(c.name) ?? c.name)
    }
    return out
  }

  /**
   * The tools offered at a model call: the session's toolset, registered, allowed and visible to the model,
   * minus on-demand tools it hasn't loaded. The session is read again for what it loaded (tools.load).
   */
  const toolSpecsFor = async (session: Session, history: Entry[] = []): Promise<{ specs: ToolSpec[]; names: string[] }> => {
    const lists = await opts.toolListsFor(session.data.employeeId)
    let names = session.data.toolset.filter((n) => {
      const t = tools.get(n)
      return t && !blind(t.def) && tools.isAllowed(n, lists)
    })
    const onDemand = opts.onDemand?.(session)
    if (onDemand) {
      const current = (await sessions.get(session.id)) ?? session
      const loaded = new Set([...loadedToolsOf(current.data.meta), ...calledIn(history)])
      names = names.filter((n) => !onDemand(n) || loaded.has(n))
    }
    return { specs: names.length ? tools.specs(names) : [], names }
  }

  /**
   * Loads an on-demand tool the model called before loading it (it is in the toolset and allowed, so the
   * call is valid): it stays offered for the rest of the session. A failure to record it is logged; the call runs anyway.
   */
  const loadOnCall = async (session: Session, name: string, logger: Logger) => {
    const onDemand = opts.onDemand?.(session)
    if (!onDemand?.(name)) return
    try {
      const current = await sessions.require(session.id)
      const loaded = loadedToolsOf(current.data.meta)
      if (loaded.includes(name)) return
      await sessions.update(session.id, {
        meta: { ...(current.data.meta ?? {}), [LOADED_TOOLS_META]: [...loaded, name].sort() },
      })
      emit('tools.loaded', { sessionId: session.id, names: [name], by: 'call' })
      logger.info('on-demand tool loaded by calling it', { tool: name })
    } catch (err) {
      logger.warn('could not record a tool as loaded', { tool: name, err: errorMessage(err) })
    }
  }

  /**
   * Brings a session up to date as a run starts: tools added or taken away since its toolset was fixed
   * (with a note to the model, since its history may say otherwise), and the current employee prompt.
   * Not while tool calls are open: a note between a call and its result would break the history.
   */
  const refreshSession = async (run: Run, session: Session, logger: Logger): Promise<{ session: Session; prompt?: string }> => {
    if (!opts.currentToolset && !opts.currentPrompt) return { session }
    try {
      const history = await sessions.runHistory(run.id)
      let out: { session: Session; prompt?: string } = { session }
      const first = history[0]
      if (opts.currentPrompt && first?.kind === 'system') {
        const stored = String((first.content as { text?: unknown } | null)?.text ?? '')
        const current = await opts.currentPrompt(session, stored)
        if (current !== undefined && current !== stored) out = { ...out, prompt: current }
      }
      if (!opts.currentToolset || pendingCalls(history).length) return out
      const want = await opts.currentToolset(session)
      if (!want) return out
      const known = (n: string) => {
        const t = tools.get(n)
        return !!t && !blind(t.def)
      }
      const have = new Set(session.data.toolset)
      const wanted = new Set(want)
      const added = want.filter((n) => !have.has(n) && known(n))
      // Only tools the model was offered before count as taken away (not ones it never saw).
      const removed = session.data.toolset.filter((n) => !wanted.has(n) && known(n))
      if (!added.length && !removed.length) return out
      const updated = await sessions.update(session.id, { toolset: [...want] })
      const lines = ['[tools changed since earlier in this conversation]']
      if (added.length)
        lines.push(
          `Now available, in addition to the tools you already had: ${added.join(', ')}. Anything said earlier about these tools not existing is out of date; use them.`,
        )
      if (removed.length) lines.push(`No longer available: ${removed.join(', ')}.`)
      await sessions.append(run.id, { kind: 'system', content: { text: lines.join('\n') }, meta: { toolsetChanged: true } })
      logger.info('session toolset brought up to date', { sessionId: session.id, added, removed })
      return { ...out, session: updated }
    } catch (err) {
      logger.warn('could not bring the session up to date', { sessionId: session.id, err: errorMessage(err) })
      return { session }
    }
  }

  /**
   * A change to the history asked for by a tool. The tool checked it, but the history may have changed since
   * (another call of the same turn): a change that no longer applies leaves the history as it is and tells
   * the model, instead of failing the run.
   */
  const historyOp = async (run: Run, tool: string, op: () => Promise<unknown>) => {
    try {
      await op()
    } catch (err) {
      if (!isMpError(err, 'validation')) throw err
      await sessions.append(run.id, {
        kind: 'system',
        content: { text: `[harness] ${tool} was not applied: ${errorMessage(err)}. The history is unchanged.` },
        meta: { historyOpFailed: tool },
      })
    }
  }

  /** What a summary records about the context notes so far, so the next run doesn't note the same thresholds again. */
  const notedMeta = (run: Run): Record<string, Json> => ({ contextNoted: run.data.context?.noted ?? 0 })

  const applyControl = async (run: Run, signals: ControlSignal[]): Promise<{ suspend?: WaitCondition; end?: RunResult }> => {
    const out: { suspend?: WaitCondition; end?: RunResult } = {}
    for (const c of signals) {
      switch (c.type) {
        case 'suspend':
          out.suspend = c.wait
          break
        case 'commit':
          await sessions.updateRun(run.id, { commit: true, ...(c.summary ? { commitSummary: c.summary } : {}) })
          break
        case 'discard':
          await sessions.updateRun(run.id, { commit: false })
          break
        case 'rewind':
          await historyOp(run, 'sessions.rewind', () =>
            sessions.rewind(run.id, c.toEntry, c.summary, {
              ...(c.keepAfter ? { keepAfter: c.keepAfter } : {}),
              meta: notedMeta(run),
            }),
          )
          break
        case 'offload':
          await historyOp(run, 'sessions.offload', () => sessions.offload(run.id, c.entryId, c.pointer))
          break
        case 'restore':
          await historyOp(run, 'sessions.restore', () => sessions.restore(run.id, c.pointerEntryId))
          break
        case 'compact':
          await historyOp(run, 'sessions.compact', () => sessions.compact(run.id, c.summary, { meta: notedMeta(run) }))
          break
        case 'end':
          out.end = {
            status: c.status,
            ...(c.output !== undefined ? { output: c.output } : {}),
            ...(c.result !== undefined ? { result: c.result } : {}),
          }
          break
      }
    }
    return out
  }

  /** Tool calls of the last assistant entry that have no result yet (after a crash, or a suspend). */
  const pendingCalls = (history: Entry[]) => {
    let lastAssistant = -1
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]!.kind === 'assistant') {
        lastAssistant = i
        break
      }
    }
    if (lastAssistant < 0) return []
    const a = history[lastAssistant]!.content as unknown as AssistantContent
    // A pointer standing for an offloaded result answers its call too.
    const done = new Set(
      history
        .slice(lastAssistant + 1)
        .map(answeredCall)
        .filter(Boolean),
    )
    return (a.toolCalls ?? []).filter((t) => !done.has(t.id))
  }

  /**
   * A tool result too long to keep in the context: the entry just appended keeps it in full, and the history
   * gets a pointer in its place with a preview (head and tail) and how to read the rest. Images are left alone.
   */
  const offloadOversized = async (run: Run, entry: Entry, content: ToolResultContent, logger: Logger) => {
    if (!resultMaxChars || content.images?.length) return
    const body = typeof content.output === 'string' ? content.output : JSON.stringify(content.output)
    if (body.length <= resultMaxChars) return
    const head = Math.min(3000, Math.floor(resultMaxChars / 2))
    const tail = Math.min(1500, Math.floor(resultMaxChars / 4))
    const text = oversizedPointerText({
      name: content.name,
      text: body,
      originalId: entry.id,
      isError: !!content.isError,
      head,
      tail,
    })
    try {
      await sessions.offload(run.id, entry.id, { text }, { meta: { automatic: true, chars: body.length } })
      emit(ContextTopics.resultOffloaded, {
        runId: run.id,
        sessionId: run.data.sessionId,
        callId: content.toolCallId,
        name: content.name,
        chars: body.length,
        entryId: entry.id,
      })
      logger.info('oversized tool result kept as a preview', { tool: content.name, chars: body.length, entryId: entry.id })
    } catch (err) {
      logger.warn('could not offload an oversized tool result', { tool: content.name, err: errorMessage(err) })
    }
  }

  /**
   * Automatic compaction, the safety net near the end of the context window: a model call (no tools) writes a
   * summary of the work so far, and the history becomes the first entry, that summary, and the latest entries
   * verbatim (about `compactKeep` of the window, never splitting a call from its results). A failure is
   * reported, never thrown: the run carries on and the caller decides what to do.
   */
  const autoCompact = async (a: {
    run: Run
    session: Session
    history: Entry[]
    prompt: string | undefined
    specs: ToolSpec[]
    modelName: string
    window: number
    tokens: number
    logger: Logger
  }): Promise<{ ok: true; kept: number } | { ok: false; error: string }> => {
    const { run, session, history, logger } = a
    // The kept tail is a share of the window, or of the request when it's smaller (the provider may have said
    // a request too long for a window the table overestimates).
    const budget = Math.floor(compactKeep * Math.min(a.window, a.tokens))
    const cut = compactionCut(history, budget, tokensPerChar(run.data.context))
    if (cut <= 1) return { ok: false, error: 'nothing to summarise: the latest entries alone fill the context' }
    const messages = renderMessages(history.slice(0, cut))
    if (a.prompt !== undefined && history[0]?.kind === 'system' && messages[0]?.role === 'system')
      messages[0] = { ...messages[0], content: a.prompt }
    messages.push({ role: 'user', content: COMPACTION_PROMPT })
    const ask = (withTools: boolean) =>
      model.complete({
        model: a.modelName,
        messages,
        ...(withTools && a.specs.length ? { tools: a.specs } : {}),
        maxTokens: summaryMaxTokens,
      })
    let response: ModelResponse
    try {
      try {
        response = await ask(false)
      } catch (err) {
        // Some providers want the tool definitions whenever the history has tool calls: try once more with them.
        if (!isMpError(err, 'model_request') || isContextOverflow(err) || !a.specs.length) throw err
        logger.warn('summary call without tools was refused; trying with them', { err: errorMessage(err) })
        response = await ask(true)
      }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
    await hooks.decide(afterModelCall, {
      run,
      session,
      response,
      step: run.data.steps,
      model: response.model || a.modelName,
    })
    emit('usage.recorded', { runId: run.id, sessionId: session.id, usage: response.usage, purpose: 'compaction' })
    const text = (response.message.content ?? '').trim()
    if (!text) return { ok: false, error: `the summary call returned no text (finish reason ${response.finishReason})` }
    const summary = text.length > 40_000 ? `${text.slice(0, 40_000)}\n[summary cut at 40,000 characters]` : text
    const kept = history.length - cut
    try {
      await sessions.compact(run.id, summary, {
        ...(kept ? { keepFrom: history[cut]!.id } : {}),
        meta: {
          automatic: true,
          tokensBefore: a.tokens,
          window: a.window,
          contextNoted: run.data.context?.noted ?? notedInHistory(history),
        },
      })
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
    await recordCompaction(run, session.id, { tokens: a.tokens, window: a.window, summary }, logger)
    return { ok: true, kept }
  }

  /**
   * A line in the session document saying the context was compacted, with the summary (or its start), so a
   * long-lived session keeps a trace outside the conversation. Only for runs whose history the session keeps.
   */
  const recordCompaction = async (
    run: Run,
    sessionId: string,
    c: { tokens: number; window: number; summary: string },
    logger: Logger,
  ) => {
    if (run.data.mode !== 'continuing' && run.data.commit !== true) return
    try {
      const current = await sessions.require(sessionId)
      await sessions.update(sessionId, { document: withCompactionLine(current.data.document ?? '', { at: clock.iso(), ...c }) })
    } catch (err) {
      logger.warn('could not note the compaction in the session document', { err: errorMessage(err) })
    }
  }

  const callTool = async (
    run: Run,
    session: Session,
    call: { id: string; name: string; arguments: string },
    step: number,
    resumed: boolean,
    logger: Logger,
  ): Promise<{ content: ToolResultContent; control: ControlSignal[] }> => {
    const name = tools.resolveProviderName(call.name) ?? call.name
    const registered = tools.get(name)
    const base = { toolCallId: call.id, name }
    if (!registered) return { content: { ...base, output: { error: `unknown tool ${call.name}` }, isError: true }, control: [] }
    const def = registered.def
    if (blind(def)) return { content: { ...base, output: { error: "this model can't see images" }, isError: true }, control: [] }
    const lists = await opts.toolListsFor(session.data.employeeId)
    if (!session.data.toolset.includes(name) || !tools.isAllowed(name, lists)) {
      return {
        content: { ...base, output: { error: `tool ${name} is not available in this session` }, isError: true },
        control: [],
      }
    }
    await loadOnCall(session, name, logger)
    // Crash recovery: a non-idempotent call whose outcome we don't know is never retried blindly.
    if (resumed && def.effect === 'non_idempotent') {
      return {
        content: {
          ...base,
          output: {
            uncertain: true,
            note: 'The harness restarted during this call. It may or may not have happened. Check (e.g. read the thread or search for the ticket) before trying again.',
          },
          isError: true,
        },
        control: [],
      }
    }
    let args: unknown
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {}
    } catch {
      return { content: { ...base, output: { error: 'arguments are not valid JSON' }, isError: true }, control: [] }
    }
    const decision = await hooks.decide(beforeToolCall, { run, session, tool: def, args, callId: call.id })
    if (decision) return { content: { ...base, output: { error: `denied: ${decision.deny}` }, isError: true }, control: [] }

    const secretValues: Record<string, string> = {}
    if (def.secrets?.length && opts.secrets) {
      const projectId = opts.projectOf ? await opts.projectOf(session) : undefined
      Object.assign(
        secretValues,
        await opts.secrets.resolve(def.secrets, {
          employeeId: session.data.employeeId,
          tool: name,
          ...(projectId ? { projectId } : {}),
        }),
      )
    }
    const redact = createRedactor(Object.values(secretValues))
    const ac = new AbortController()
    const ctx: ToolContext = {
      employeeId: session.data.employeeId,
      sessionId: session.id,
      runId: run.id,
      callId: call.id,
      idempotencyKey: `${run.id}:${step}:${call.id}`,
      ...(currentRequester(run) ? { requesterId: currentRequester(run) } : {}),
      secrets: secretValues,
      signal: ac.signal,
      logger: logger.child({ tool: name }),
      clock,
      emit,
    }
    emit('tool.called', { runId: run.id, sessionId: session.id, callId: call.id, step, name, args: redact(args as Json) })
    let result: ToolResult
    try {
      result = await tools.execute(name, args, ctx)
    } catch (err) {
      if (isMpError(err, 'unavailable')) throw err
      result = { output: { error: errorMessage(err), ...(isMpError(err) ? { code: err.code } : {}) }, isError: true }
    }
    result = await hooks.transform(afterToolCall, { run, session, tool: def, result }).then((x) => x.result)
    const output = redact(result.output)
    emit('tool.result', { runId: run.id, sessionId: session.id, callId: call.id, step, name, isError: !!result.isError })
    return {
      content: {
        ...base,
        output,
        ...(result.isError ? { isError: true } : {}),
        ...(result.images?.length ? { images: result.images as unknown as Json[] } : {}),
      },
      control: result.control ?? [],
    }
  }

  const execute: Runner['execute'] = async (runId) => {
    let run = await sessions.getRun(runId)
    if (!run) return { status: 'skipped', runId, reason: 'run not found' }
    const logger = baseLogger.child({ runId, sessionId: run.data.sessionId })

    // Wake-up jobs for suspended runs (timers and timeouts).
    if (run.data.state === 'suspended') {
      const woke = await wake(runId)
      return woke
        ? { status: 'skipped', runId, reason: 'woken; queued again' }
        : { status: 'skipped', runId, reason: 'still waiting' }
    }
    let resumed = false
    if (run.data.state === 'queued') {
      // An employee over its concurrency cap: the run waits in the queue and is tried again.
      const cap = opts.limitsFor ? (await limitsOf(run, await sessions.require(run.data.sessionId))).maxConcurrentRuns : undefined
      if (cap !== undefined) {
        const working = await sessions.runs({ employeeId: run.data.employeeId, state: 'running', limit: cap + 1 })
        if (working.length >= cap) {
          await enqueue(runId, { delayMs: opts.concurrencyRetryMs ?? 3000, priority: run.data.priority })
          emit('run.deferred', { runId, employeeId: run.data.employeeId, working: working.length, max: cap })
          return { status: 'skipped', runId, reason: `${working.length} runs of this employee are working (limit ${cap})` }
        }
      }
      const limitPaused = run.data.limitPaused
      try {
        run = await sessions.transition(runId, 'queued', 'running', {
          ...(run.data.startedAt ? {} : { startedAt: clock.iso() }),
          runningSince: clock.iso(),
          // Resumed after a step or wall-clock pause: a fresh allowance.
          ...(limitPaused === 'wall' ? { activeMs: 0 } : {}),
          ...(limitPaused === 'steps' ? { stepsFrom: run.data.steps } : {}),
          ...(limitPaused ? { limitPaused: undefined } : {}),
        })
      } catch (err) {
        if (isMpError(err, 'conflict')) return { status: 'skipped', runId, reason: 'claimed by another worker' }
        throw err
      }
    } else if (run.data.state === 'running') {
      // A retried or recovered job: resume from the journal.
      resumed = true
    } else {
      return { status: 'skipped', runId, reason: `run is ${run.data.state}` }
    }

    let session = await sessions.require(run.data.sessionId)
    let finishBlocks = 0
    /** The step at which automatic compaction was last tried, and the step at which the provider said the request is too long. */
    let compactTried = -1
    let overflowAt = -1
    const fresh = await refreshSession(run, session, logger)
    session = fresh.session
    const prompt = fresh.prompt

    // Resuming after a wait: tell the model what it was waiting for.
    if (run.data.wait && !resumed) {
      const wait = run.data.wait
      let text = '[wait finished]'
      if (wait.type === 'runs') {
        const results = await sessions.waitResults(run)
        text += `\n${JSON.stringify(
          results.map((r) => ({
            runId: r.runId,
            sessionId: r.sessionId,
            done: r.done,
            state: r.state,
            output: r.result?.output,
            error: r.result?.error,
            ...(r.result?.result !== undefined ? { result: r.result.result } : {}),
          })),
          null,
          2,
        )}`
      } else if (wait.type === 'timer') text += ` (timer until ${wait.until})`
      await sessions.append(runId, { kind: 'user', content: { text }, meta: { wake: true } })
      await sessions.updateRun(runId, { wait: undefined } as any)
    }

    try {
      for (;;) {
        run = await sessions.requireRun(runId)
        if (run.data.state !== 'running') {
          // Paused from outside (a person, the kill switch): keep the time it worked.
          if (run.data.state === 'paused') await sessions.updateRun(runId, { activeMs: activeMs(run) }).catch(() => {})
          return { status: 'paused', runId, reason: `run is ${run.data.state}` }
        }

        // Finish tool calls left open by a crash or by a suspend in the middle of several calls.
        let history = await sessions.runHistory(runId)
        const pending = pendingCalls(history)
        if (pending.length) {
          const step = run.data.steps
          let control: ControlSignal[] = []
          for (const call of pending) {
            const r = await callTool(run, session, call, step, resumed, logger)
            const entry = await sessions.append(runId, { kind: 'tool_result', content: r.content as unknown as Json })
            await offloadOversized(run, entry, r.content, logger)
            control = control.concat(r.control)
          }
          resumed = false
          const c = await applyControl(run, control)
          if (c.end) {
            const o = await finishWithPolicies(run, session, c.end, () => finishBlocks++)
            if (o) return o
            continue
          }
          if (c.suspend) {
            await sessions.updateRun(runId, { activeMs: activeMs(run) })
            const suspended = await sessions.suspend(runId, c.suspend)
            await scheduleTimers(suspended, c.suspend)
            // The wait may already be satisfied (children finished very fast).
            await wake(runId)
            return { status: 'suspended', runId }
          }
          continue
        }
        resumed = false

        // New deliveries for a continuing run are seen at the next step.
        if (run.data.mode === 'continuing') {
          const items = await sessions.takeInbox(session.id, runId)
          for (const item of items) {
            await sessions.append(runId, {
              kind: 'event',
              content: {
                eventId: item.data.eventId,
                source: item.data.source,
                type: item.data.type,
                text: item.data.text,
                trusted: item.data.trusted,
                expectedToAct: item.data.expectedToAct,
              },
              meta: { inboxId: item.id },
            })
          }
          // A later request (someone else in the thread, say) is who the run works for from now on.
          const asked = items.filter((i) => i.data.expectedToAct && i.data.requesterId)
          if (asked.length)
            run = await sessions.updateRun(runId, {
              requests: [
                ...(run.data.requests ?? []),
                ...asked.map((i) => ({ eventId: i.data.eventId, requesterId: i.data.requesterId!, at: clock.iso() })),
              ],
            })
          if (items.length) history = await sessions.runHistory(runId)
        }

        const limits = await limitsOf(run, session)
        const stepLimit = limits.maxSteps ?? maxSteps
        if (run.data.steps - (run.data.stepsFrom ?? 0) >= stepLimit) {
          await sessions.transition(runId, 'running', 'paused', {
            pauseReason: `reached ${stepLimit} model calls in one run. Resuming gives it another ${stepLimit}.`,
            limitPaused: 'steps',
            activeMs: activeMs(run),
          })
          emit('run.paused', { runId, reason: 'max steps' })
          return { status: 'paused', runId, reason: 'max steps' }
        }
        // Wall clock: checked between steps, so a tool call in progress is never cut off.
        const wallLimit = limits.maxWallMs ?? opts.maxWallMs
        const worked = activeMs(run)
        if (wallLimit !== undefined && worked >= wallLimit) {
          const reason = `worked for ${minutes(worked)}, over the limit of ${minutes(wallLimit)} per run. Resuming gives it another ${minutes(wallLimit)}.`
          await sessions.transition(runId, 'running', 'paused', { pauseReason: reason, limitPaused: 'wall', activeMs: worked })
          emit('run.paused', { runId, reason })
          return { status: 'paused', runId, reason: 'wall clock' }
        }

        const { specs } = await toolSpecsFor(session, history)
        const modelName = session.data.model ?? model.defaultModel
        const window = windowOf(modelName)
        const render = (h: Entry[]) => {
          const m = renderMessages(h)
          if (prompt !== undefined && h[0]?.kind === 'system' && m[0]?.role === 'system') m[0] = { ...m[0], content: prompt }
          return m
        }
        const stepNow = run.data.steps
        let messages = render(history)
        let chars = requestChars(messages, specs)
        let tokens = estimateTokens(chars, run.data.context)

        // The safety net: compact near the end of the window, or when the provider said the request is too long.
        let compactError: string | undefined
        if (compactAt > 0 && compactTried !== stepNow && (overflowAt === stepNow || tokens >= (window * compactAt) / 100)) {
          compactTried = stepNow
          const before = tokens
          const r = await autoCompact({ run, session, history, prompt, specs, modelName, window, tokens, logger })
          if (r.ok) {
            history = await sessions.runHistory(runId)
            messages = render(history)
            chars = requestChars(messages, specs)
            tokens = estimateTokens(chars, run.data.context)
            emit(ContextTopics.compacted, {
              runId,
              sessionId: session.id,
              automatic: true,
              tokensBefore: before,
              tokensAfter: tokens,
              window,
              keptEntries: r.kept,
            })
            logger.info('context compacted automatically', { before, after: tokens, window, keptEntries: r.kept })
          } else {
            compactError = r.error
            emit(ContextTopics.compactFailed, { runId, sessionId: session.id, error: r.error })
            logger.warn('automatic compaction failed; carrying on', { err: r.error, tokens, window })
          }
        }
        if (compactError !== undefined && (overflowAt === stepNow || tokens >= window))
          return pauseForContext(run, tokens, window, `, and automatic compaction failed: ${compactError}`)

        // Tell the model how full its context is and what is big, once per threshold. Never between a call and its result.
        let noted = run.data.context?.noted ?? notedInHistory(history)
        if (thresholds.length && !pendingCalls(history).length) {
          const d = contextNoteDecision((tokens / window) * 100, noted, thresholds)
          noted = d.noted
          if (d.note !== undefined) {
            const near = nearOn && d.note === nearAt
            const suggestions = contextSuggestions(history, tokensPerChar(run.data.context), {
              minTokens: Math.max(200, Math.round(window * 0.02)),
            })
            const text = near
              ? contextNearText(tokens, window, compactAt || undefined, suggestions)
              : contextNoteText(tokens, window, compactAt || undefined, suggestions)
            await sessions.append(runId, {
              // Near the limit it is an instruction for the model's next turn, not an aside.
              kind: near ? 'user' : 'system',
              content: { text },
              meta: {
                contextNote: d.note,
                contextTokens: tokens,
                contextWindow: window,
                transient: true,
                ...(near ? { contextNear: true } : {}),
              },
            })
            history = await sessions.runHistory(runId)
            messages = render(history)
            chars = requestChars(messages, specs)
            emit(ContextTopics.noted, {
              runId,
              sessionId: session.id,
              tokens,
              window,
              percent: d.note,
              near,
              suggestions: suggestions.length,
            })
            logger.info('model told about its context size', { tokens, window, threshold: d.note, near })
          }
        }

        const pause = await hooks.decide(beforeModelCall, { run, session, messages, step: run.data.steps })
        if (pause) {
          await sessions.transition(runId, 'running', 'paused', { pauseReason: pause.pause, activeMs: activeMs(run) })
          emit('run.paused', { runId, reason: pause.pause })
          return { status: 'paused', runId, reason: pause.pause }
        }

        let response: ModelResponse
        try {
          response = await model.complete({
            model: modelName,
            messages: await resolveImages(messages),
            ...(specs.length ? { tools: specs } : {}),
            ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
            onDelta: (d) => emit('model.delta', { runId, sessionId: session.id, ...d }),
          })
        } catch (err) {
          if (!isContextOverflow(err)) throw err
          logger.warn('the request is longer than the context window', { tokens, window, err: errorMessage(err) })
          if (compactAt > 0 && compactTried !== stepNow) {
            overflowAt = stepNow
            continue
          }
          return pauseForContext(
            run,
            tokens,
            window,
            compactAt > 0 ? ', even after automatic compaction' : ' (automatic compaction is off)',
          )
        }
        const step = run.data.steps
        await hooks.decide(afterModelCall, { run, session, response, step, model: response.model || modelName })
        emit('usage.recorded', { runId, sessionId: session.id, usage: response.usage })

        const calls = (response.message.tool_calls ?? []).map((t) => ({
          id: t.id,
          name: t.function.name,
          arguments: t.function.arguments,
        }))
        const content: AssistantContent = {
          text: response.message.content ?? null,
          ...(response.message.reasoning_content ? { reasoning: response.message.reasoning_content } : {}),
          ...(calls.length ? { toolCalls: calls } : {}),
        }
        await sessions.append(runId, {
          kind: 'assistant',
          content: content as unknown as Json,
          meta: { step, model: response.model || modelName, finishReason: response.finishReason },
        })
        const context: RunContextSize = {
          tokens: response.usage?.promptTokens || tokens,
          window,
          chars,
          model: response.model || modelName,
          at: clock.iso(),
          noted,
        }
        await sessions.updateRun(runId, { steps: step + 1, context })

        if (calls.length) continue // executed at the top of the loop, so a crash between here and there is recoverable

        const output = response.message.content ?? undefined
        const outcome = await finishWithPolicies(
          run,
          session,
          { status: 'completed', ...(output ? { output } : {}) },
          () => finishBlocks++,
        )
        if (outcome) return outcome
      }
    } catch (err) {
      if (isMpError(err, 'unavailable')) {
        logger.warn('run hit an unavailable dependency; will retry', { err: errorMessage(err) })
        throw err
      }
      logger.error('run failed', { err: errorMessage(err) })
      const current = await sessions.getRun(runId)
      if (current?.data.state === 'running') {
        try {
          await sessions.transition(runId, 'running', 'failed', {
            result: { status: 'failed', error: errorMessage(err) },
            endedAt: clock.iso(),
          })
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e
        }
        await wakeWaiters(runId)
      }
      return { status: 'failed', runId }
    }

    /** Pauses a run whose context no longer fits the model's window, saying so plainly. */
    async function pauseForContext(r: Run, tokens: number, window: number, why: string): Promise<ExecuteOutcome> {
      const reason =
        `context full: about ${kTokens(tokens)} tokens for a ${kTokens(window)}-token context window${why}. ` +
        'Resuming tries to compact again; or fork the session from an earlier point.'
      await sessions.transition(runId, 'running', 'paused', { pauseReason: reason, activeMs: activeMs(r) })
      emit('run.paused', { runId, reason })
      return { status: 'paused', runId, reason }
    }

    async function finishWithPolicies(
      r: Run,
      s: Session,
      result: RunResult,
      countBlock?: () => number,
    ): Promise<ExecuteOutcome | undefined> {
      if (result.status !== 'cancelled') {
        const block = await hooks.decide(beforeFinish, {
          run: r,
          session: s,
          status: result.status,
          ...(result.output !== undefined ? { output: result.output } : {}),
        })
        if (block) {
          const n = countBlock ? countBlock() + 1 : maxFinishBlocks + 1
          if (n > maxFinishBlocks) {
            await sessions.transition(runId, 'running', 'paused', {
              pauseReason: `could not finish: ${block.block}`,
              activeMs: activeMs(r),
            })
            return { status: 'paused', runId, reason: block.block }
          }
          await sessions.append(runId, {
            kind: 'user',
            content: { text: `[harness] Not finished yet: ${block.block}` },
            meta: { policy: true },
          })
          return undefined
        }
      }
      return finish(r, s, result)
    }
  }

  return { execute, wake, enqueue }
}
