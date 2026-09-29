import { type Clock, type Logger, MpError, silentLogger, systemClock, UnavailableError } from '@mp/core'
import {
  type ChatMessage,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ToolCall,
  type Usage,
  emptyUsage,
} from '@mp/model'

export interface OpenAiModelOptions {
  /** e.g. `https://api.example.com/v1`; requests go to `{baseUrl}/chat/completions`. */
  baseUrl: string
  apiKey: string
  /** Default model, used when a request doesn't name one. */
  model: string
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Per attempt, covering the whole response including a stream. Default 300 000 ms. */
  timeoutMs?: number
  /** Retries after the first attempt on 429, 5xx, network errors and timeouts. Default 3. */
  maxRetries?: number
  /** First backoff delay; doubles per retry, with jitter. Default 500 ms. */
  retryBaseMs?: number
  /** Cap for a single backoff delay, including Retry-After. Default 30 000 ms. */
  retryMaxMs?: number
  logger?: Logger
  /**
   * `true` always streams, `false` never does, `'auto'` (default) streams when
   * the request has an `onDelta` callback.
   */
  stream?: boolean | 'auto'
  /** Extra request headers (never secrets other than the API key, which is set here). */
  headers?: Record<string, string>
  /** Used for Retry-After dates. */
  clock?: Clock
  /** For tests: source of jitter in [0, 1). */
  random?: () => number
}

const RETRYABLE = (status: number) => status === 408 || status === 429 || status >= 500

/** A ModelClient for any OpenAI-compatible Chat Completions endpoint. */
export function openAiModel(opts: OpenAiModelOptions): ModelClient {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const doFetch = opts.fetch ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 300_000
  const maxRetries = Math.max(0, opts.maxRetries ?? 3)
  const baseMs = opts.retryBaseMs ?? 500
  const maxMs = opts.retryMaxMs ?? 30_000
  const log = (opts.logger ?? silentLogger).child({ component: 'model-openai' })
  const clock = opts.clock ?? systemClock
  const random = opts.random ?? Math.random
  const redact = (s: string) => (opts.apiKey ? s.split(opts.apiKey).join('[redacted]') : s)

  async function complete(req: ModelRequest): Promise<ModelResponse> {
    const model = req.model ?? opts.model
    const stream = opts.stream === 'auto' || opts.stream === undefined ? !!req.onDelta : opts.stream
    const body = JSON.stringify(buildBody(req, model, stream))
    const started = clock.now()

    for (let attempt = 0; ; attempt++) {
      throwIfAborted(req.signal)
      const outcome = await attemptOnce(req, model, body, stream)
      if (outcome.ok) {
        log.debug('model call done', {
          model,
          attempt,
          ms: clock.now() - started,
          finishReason: outcome.response.finishReason,
          usage: outcome.response.usage,
        })
        return outcome.response
      }
      const { failure } = outcome
      if (!failure.retryable) throw failure.error
      if (attempt >= maxRetries) {
        throw new UnavailableError(`model provider unavailable after ${attempt + 1} attempts: ${failure.reason}`, {
          model,
          attempts: attempt + 1,
          ...(failure.status ? { status: failure.status } : {}),
        })
      }
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt) * (0.5 + random() / 2)
      const delay = Math.min(maxMs, Math.max(backoff, failure.retryAfterMs ?? 0))
      log.warn('model call failed, retrying', { model, attempt: attempt + 1, reason: failure.reason, delayMs: Math.round(delay) })
      await sleep(delay, req.signal)
    }
  }

  type Failure = { retryable: boolean; reason: string; error?: unknown; status?: number; retryAfterMs?: number }
  type Outcome = { ok: true; response: ModelResponse } | { ok: false; failure: Failure }

  async function attemptOnce(req: ModelRequest, model: string, body: string, stream: boolean): Promise<Outcome> {
    const ctrl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctrl.abort(new DOMException('model request timed out', 'TimeoutError'))
    }, timeoutMs)
    const onAbort = () => ctrl.abort(req.signal!.reason)
    req.signal?.addEventListener('abort', onAbort, { once: true })
    const streamed = { any: false }
    try {
      let res: Response
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: stream ? 'text/event-stream' : 'application/json',
            ...opts.headers,
            authorization: `Bearer ${opts.apiKey}`,
          },
          body,
          signal: ctrl.signal,
        })
      } catch (e) {
        return { ok: false, failure: transportFailure(e, req, timedOut) }
      }

      if (!res.ok) {
        const text = redact(await res.text().catch(() => ''))
        const reason = `HTTP ${res.status}${providerMessage(text) ? `: ${providerMessage(text)}` : ''}`
        if (RETRYABLE(res.status)) {
          const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), clock.now())
          return {
            ok: false,
            failure: { retryable: true, reason, status: res.status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
          }
        }
        const error = new MpError('model_request', `model request failed: ${reason}`, {
          status: res.status,
          model,
          body: text.slice(0, 2000),
        })
        return { ok: false, failure: { retryable: false, reason, status: res.status, error } }
      }

      try {
        const response = stream ? await readStream(res, req, model, streamed) : parseResponse(await res.json(), model)
        return { ok: true, response }
      } catch (e) {
        if (e instanceof MpError) return { ok: false, failure: { retryable: false, reason: e.message, error: e } }
        const failure = transportFailure(e, req, timedOut)
        // Once deltas reached the caller a retry would repeat them: fail instead.
        if (failure.retryable && streamed.any) {
          return {
            ok: false,
            failure: {
              retryable: false,
              reason: failure.reason,
              error: new UnavailableError(`model stream broke: ${failure.reason}`, { model }),
            },
          }
        }
        return { ok: false, failure }
      }
    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onAbort)
    }
  }

  function transportFailure(e: unknown, req: ModelRequest, timedOut: boolean): Failure {
    if (req.signal?.aborted) return { retryable: false, reason: 'aborted', error: abortError(req.signal) }
    if (timedOut) return { retryable: true, reason: `timed out after ${timeoutMs} ms` }
    const msg = redact(e instanceof Error ? `${e.message}${causeMessage(e)}` : String(e))
    return { retryable: true, reason: `network error: ${msg}` }
  }

  return { defaultModel: opts.model, complete }
}

function buildBody(req: ModelRequest, model: string, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages: req.messages.map(serializeMessage) }
  if (req.tools?.length) body.tools = req.tools
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (stream) {
    body.stream = true
    body.stream_options = { include_usage: true }
  }
  return body
}

function serializeMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content }
  if (m.name !== undefined) out.name = m.name
  if (m.tool_calls?.length) out.tool_calls = m.tool_calls
  if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id
  if (m.reasoning_content !== undefined) out.reasoning_content = m.reasoning_content
  return out
}

function parseResponse(data: any, model: string): ModelResponse {
  const choice = data?.choices?.[0]
  if (!choice?.message) throw new MpError('model_response', 'model response has no choices', { model })
  const m = choice.message
  const message: ChatMessage = { role: 'assistant', content: typeof m.content === 'string' ? m.content : null }
  const reasoning = m.reasoning_content ?? m.reasoning
  if (typeof reasoning === 'string' && reasoning) message.reasoning_content = reasoning
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    message.tool_calls = m.tool_calls.map(
      (c: any, i: number): ToolCall => ({
        id: String(c.id ?? `call_${i}`),
        type: 'function',
        function: { name: String(c.function?.name ?? ''), arguments: stringArgs(c.function?.arguments) },
      }),
    )
  }
  return {
    message,
    finishReason: choice.finish_reason ?? (message.tool_calls ? 'tool_calls' : 'stop'),
    usage: mapUsage(data.usage ?? choice.usage),
    model: data.model ?? model,
  }
}

function stringArgs(a: unknown): string {
  if (typeof a === 'string') return a
  if (a === undefined || a === null) return ''
  return JSON.stringify(a)
}

/** Maps a provider's `usage` object (OpenAI or Kimi flavour) to ours. */
export function mapUsage(u: any): Usage {
  if (!u || typeof u !== 'object') return emptyUsage()
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const promptTokens = num(u.prompt_tokens)
  const completionTokens = num(u.completion_tokens)
  return {
    promptTokens,
    completionTokens,
    cachedTokens: num(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens),
    reasoningTokens: num(u.completion_tokens_details?.reasoning_tokens),
    totalTokens: num(u.total_tokens) || promptTokens + completionTokens,
  }
}

async function readStream(res: Response, req: ModelRequest, model: string, streamed: { any: boolean }): Promise<ModelResponse> {
  if (!res.body) throw new MpError('model_response', 'model stream has no body', { model })
  let content = ''
  let reasoning = ''
  let finishReason: string | undefined
  let usage: Usage | undefined
  let respModel: string | undefined
  const calls: Array<{ id: string; name: string; arguments: string }> = []

  const handle = (data: string) => {
    let chunk: any
    try {
      chunk = JSON.parse(data)
    } catch {
      throw new MpError('model_response', 'invalid JSON in model stream', { model, data: data.slice(0, 200) })
    }
    if (chunk?.error) {
      throw new MpError('model_request', `model stream error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`, { model })
    }
    if (chunk.model) respModel = chunk.model
    if (chunk.usage) usage = mapUsage(chunk.usage)
    for (const choice of chunk.choices ?? []) {
      if ((choice.index ?? 0) !== 0) continue
      if (choice.usage) usage = mapUsage(choice.usage)
      if (choice.finish_reason) finishReason = choice.finish_reason
      const d = choice.delta ?? {}
      const r = d.reasoning_content ?? d.reasoning
      if (typeof r === 'string' && r) {
        reasoning += r
        streamed.any = true
        req.onDelta?.({ reasoning: r })
      }
      if (typeof d.content === 'string' && d.content) {
        content += d.content
        streamed.any = true
        req.onDelta?.({ content: d.content })
      }
      for (const tc of d.tool_calls ?? []) {
        const i = typeof tc.index === 'number' ? tc.index : calls.length
        const slot = (calls[i] ??= { id: '', name: '', arguments: '' })
        if (tc.id) slot.id = tc.id
        const name = tc.function?.name
        if (name && slot.name !== name) slot.name += name
        const args = tc.function?.arguments
        if (args !== undefined && args !== null) slot.arguments += stringArgs(args)
      }
    }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let dataLines: string[] = []
  let done = false
  const flushEvent = () => {
    if (!dataLines.length) return
    const data = dataLines.join('\n')
    dataLines = []
    if (data.trim() === '[DONE]') done = true
    else if (data.trim()) handle(data)
  }
  const onLine = (line: string) => {
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line === '') return flushEvent()
    if (line.startsWith(':')) return
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  while (!done) {
    const { value, done: eof } = await reader.read()
    if (eof) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while (!done && (nl = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  }
  if (!done) {
    buf += decoder.decode()
    if (buf) onLine(buf)
    flushEvent()
  }
  await reader.cancel().catch(() => {})
  if (!done && !finishReason) throw new Error('model stream ended before completion')

  const toolCalls = calls.filter(Boolean)
  const message: ChatMessage = { role: 'assistant', content: content || (toolCalls.length ? null : '') }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((c, i) => ({
      id: c.id || `call_${i}`,
      type: 'function',
      function: { name: c.name, arguments: c.arguments },
    }))
  }
  return {
    message,
    finishReason: finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'),
    usage: usage ?? emptyUsage(),
    model: respModel ?? model,
  }
}

function providerMessage(text: string): string {
  if (!text) return ''
  try {
    const j = JSON.parse(text)
    const m = j?.error?.message ?? j?.message ?? j?.error
    if (typeof m === 'string') return m.slice(0, 500)
  } catch {}
  return text.slice(0, 200)
}

/** Retry-After in ms: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined
  const s = Number(value)
  if (Number.isFinite(s)) return Math.max(0, s * 1000)
  const t = Date.parse(value)
  return Number.isNaN(t) ? undefined : Math.max(0, t - nowMs)
}

function causeMessage(e: Error): string {
  const c = (e as { cause?: unknown }).cause
  return c instanceof Error ? ` (${c.message})` : ''
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw abortError(signal)
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal))
    const onAbort = () => {
      clearTimeout(t)
      reject(abortError(signal!))
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
