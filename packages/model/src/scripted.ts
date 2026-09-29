import { MpError } from '@mp/core'
import { estimateTokens, type PartialModelResponse } from './helpers.ts'
import type { ChatMessage, ModelClient, ModelRequest, ModelResponse, Usage } from './types.ts'

/** What a script step may produce: a full or partial response, plain text (a reply), or an error to throw. */
export type ScriptResult = ModelResponse | PartialModelResponse | string | Error

/** Computes a step's result from the request and the 0-based index of the call. */
export type ScriptResponder = (req: ModelRequest, callIndex: number) => ScriptResult | Promise<ScriptResult>

/** A list of steps, one per call, or one function answering every call. */
export type Script = Array<ScriptResult | ScriptResponder> | ScriptResponder

export interface ScriptedModelOptions {
  /** Reported as `defaultModel` and used when a response doesn't name one. Default `scripted`. */
  model?: string
  /** Characters per streamed chunk passed to `onDelta`. Default 8. */
  chunkSize?: number
  /** Wait this long between streamed chunks (ms). Default 0 (a microtask yield). */
  chunkDelayMs?: number
}

/** A request as recorded by the scripted model: messages and tools are copies, `signal`/`onDelta` are kept. */
export type RecordedRequest = ModelRequest

export interface ScriptedModel extends ModelClient {
  /** Every request received, in order (including ones that failed). */
  readonly calls: RecordedRequest[]
  /** Steps left in an array script (Infinity for a function script). */
  remaining(): number
  /** Appends steps to an array script. */
  push(...steps: Array<ScriptResult | ScriptResponder>): void
}

/**
 * A model for tests that answers from a script. It records every request,
 * streams text and reasoning to `onDelta` in chunks, honours `signal`, and
 * estimates usage from message lengths when a step doesn't give it.
 */
export function scriptedModel(script: Script, opts: ScriptedModelOptions = {}): ScriptedModel {
  const defaultModel = opts.model ?? 'scripted'
  const chunkSize = Math.max(1, opts.chunkSize ?? 8)
  const steps = typeof script === 'function' ? null : [...script]
  const responder = typeof script === 'function' ? script : null
  const calls: RecordedRequest[] = []
  let index = 0

  async function complete(req: ModelRequest): Promise<ModelResponse> {
    const callIndex = index++
    calls.push(record(req))
    throwIfAborted(req.signal)

    let step: ScriptResult | ScriptResponder
    if (responder) step = responder
    else {
      if (callIndex >= steps!.length) {
        const last = lastUserText(req.messages)
        throw new MpError(
          'script_exhausted',
          `scripted model: no step for call #${callIndex + 1} (script has ${steps!.length} steps)` +
            (last ? `; last message: ${JSON.stringify(last.slice(0, 200))}` : ''),
          { callIndex, steps: steps!.length },
        )
      }
      step = steps![callIndex]!
    }
    let result = typeof step === 'function' ? await step(req, callIndex) : step
    throwIfAborted(req.signal)
    if (result instanceof Error) throw result
    if (typeof result === 'string') result = { message: { role: 'assistant', content: result }, finishReason: 'stop' }

    const response = normalize(result, req, defaultModel)
    if (req.onDelta) await stream(response.message, req, chunkSize, opts.chunkDelayMs ?? 0)
    return response
  }

  return {
    defaultModel,
    calls,
    complete,
    remaining: () => (steps ? Math.max(0, steps.length - index) : Number.POSITIVE_INFINITY),
    push: (...more) => {
      if (!steps) throw new MpError('invalid', 'scripted model: cannot push to a function script')
      steps.push(...more)
    },
  }
}

function record(req: ModelRequest): RecordedRequest {
  return {
    ...req,
    messages: structuredClone(req.messages),
    ...(req.tools ? { tools: structuredClone(req.tools) } : {}),
  }
}

function normalize(result: ModelResponse | PartialModelResponse, req: ModelRequest, defaultModel: string): ModelResponse {
  const message: ChatMessage = { ...result.message, role: 'assistant', content: result.message.content ?? null }
  if (message.tool_calls) message.tool_calls = structuredClone(message.tool_calls)
  const finishReason = result.finishReason ?? (message.tool_calls?.length ? 'tool_calls' : 'stop')
  return {
    message,
    finishReason,
    usage: completeUsage(result.usage, req, message),
    model: result.model || req.model || defaultModel,
  }
}

/** Fills in usage fields the step didn't give, estimated from lengths. */
function completeUsage(given: Partial<Usage> | undefined, req: ModelRequest, message: ChatMessage): Usage {
  const promptTokens =
    given?.promptTokens ?? estimateTokens(JSON.stringify(req.messages) + (req.tools ? JSON.stringify(req.tools) : ''))
  const reasoningTokens = given?.reasoningTokens ?? estimateTokens(message.reasoning_content ?? '')
  const completionTokens =
    given?.completionTokens ??
    reasoningTokens + estimateTokens((message.content ?? '') + (message.tool_calls ? JSON.stringify(message.tool_calls) : ''))
  return {
    promptTokens,
    completionTokens,
    cachedTokens: given?.cachedTokens ?? 0,
    reasoningTokens,
    totalTokens: given?.totalTokens ?? promptTokens + completionTokens,
  }
}

async function stream(message: ChatMessage, req: ModelRequest, size: number, delayMs: number) {
  const pause = () => new Promise<void>((r) => (delayMs > 0 ? setTimeout(r, delayMs) : queueMicrotask(r)))
  for (const [key, text] of [
    ['reasoning', message.reasoning_content ?? ''],
    ['content', message.content ?? ''],
  ] as const) {
    for (let i = 0; i < text.length; i += size) {
      throwIfAborted(req.signal)
      req.onDelta!({ [key]: text.slice(i, i + size) })
      await pause()
    }
  }
  throwIfAborted(req.signal)
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError')
}

function lastUserText(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user' || m.role === 'tool') return m.content ?? undefined
  }
  return undefined
}
