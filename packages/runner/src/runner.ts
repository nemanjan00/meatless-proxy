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
import type { ChatMessage, ImageRef, ModelClient, ModelResponse, ToolSpec } from '@mp/model'
import type { Queue } from '@mp/queue'
import { createRedactor, type SecretStore } from '@mp/secrets'
import type { AssistantContent, Run, RunResult, Session, Sessions, ToolResultContent, WaitCondition } from '@mp/sessions'
import type { Entry } from '@mp/store'
import type { ControlSignal, ToolContext, ToolDefinition, ToolLists, ToolRegistry, ToolResult } from '@mp/tools'
import { lastAssistantText, renderMessages } from './context.ts'
import { createImageResolver, VISION_TAG, type LoadedImage } from './images.ts'

export const RUNS_QUEUE = 'runs'

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
      ...(run.data.requesterId ? { requesterId: run.data.requesterId } : {}),
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

  const toolSpecsFor = async (session: Session): Promise<{ specs: ToolSpec[]; names: string[] }> => {
    const lists = await opts.toolListsFor(session.data.employeeId)
    const names = session.data.toolset.filter((n) => {
      const t = tools.get(n)
      return t && !blind(t.def) && tools.isAllowed(n, lists)
    })
    return { specs: names.length ? tools.specs(names) : [], names }
  }

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
          await sessions.rewind(run.id, c.toEntry, c.summary)
          break
        case 'offload':
          await sessions.offload(run.id, c.entryId, c.pointer)
          break
        case 'restore':
          await sessions.restore(run.id, c.pointerEntryId)
          break
        case 'compact':
          await sessions.compact(run.id, c.summary)
          break
        case 'end':
          out.end = { status: c.status, ...(c.output !== undefined ? { output: c.output } : {}) }
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
    const done = new Set(
      history
        .slice(lastAssistant + 1)
        .filter((e) => e.kind === 'tool_result')
        .map((e) => (e.content as any).toolCallId as string),
    )
    return (a.toolCalls ?? []).filter((t) => !done.has(t.id))
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
      ...(run.data.requesterId ? { requesterId: run.data.requesterId } : {}),
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

    const session = await sessions.require(run.data.sessionId)
    let finishBlocks = 0

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
            await sessions.append(runId, { kind: 'tool_result', content: r.content as unknown as Json })
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

        const messages = renderMessages(history)
        const pause = await hooks.decide(beforeModelCall, { run, session, messages, step: run.data.steps })
        if (pause) {
          await sessions.transition(runId, 'running', 'paused', { pauseReason: pause.pause, activeMs: activeMs(run) })
          emit('run.paused', { runId, reason: pause.pause })
          return { status: 'paused', runId, reason: pause.pause }
        }

        const { specs } = await toolSpecsFor(session)
        const modelName = session.data.model ?? model.defaultModel
        const response = await model.complete({
          model: modelName,
          messages: await resolveImages(messages),
          ...(specs.length ? { tools: specs } : {}),
          ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
          onDelta: (d) => emit('model.delta', { runId, sessionId: session.id, ...d }),
        })
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
        await sessions.updateRun(runId, { steps: step + 1 })

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
