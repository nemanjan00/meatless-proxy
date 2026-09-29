import { type Clock, errorMessage, type Logger, MpError, silentLogger, systemClock, UnavailableError } from '@mp/core'

export const DEFAULT_BASE_URL = 'https://slack.com/api'

/** How a Web API call is retried. */
export interface RetryOptions {
  /** Attempts in total, first one included. Default 3. */
  attempts?: number
  /** Longest wait honoured between attempts; a longer Retry-After fails at once with `UnavailableError`. Default 30 000 ms. */
  maxDelayMs?: number
  /** Base of the exponential backoff for 5xx and network errors. Default 500 ms. */
  baseDelayMs?: number
}

export interface SlackClientOptions {
  /** Bot token (`xoxb-…`). Sent only as the Authorization header, never logged. */
  token: string
  baseUrl?: string
  fetch?: typeof fetch
  clock?: Clock
  logger?: Logger
  retry?: RetryOptions
  /** Waits between retries. Default `setTimeout`; tests pass a fake. */
  sleep?: (ms: number) => Promise<void>
}

export interface CallOptions {
  /**
   * The call changes something (posts, reacts, updates). Writes are retried only when Slack
   * certainly didn't execute them (429, `ratelimited`), never after a 5xx or network error.
   */
  write?: boolean
  /** Send a JSON body instead of a form body. */
  json?: boolean
}

/** A Slack Web API response: `ok` plus the method's fields. */
export type SlackResponse = { ok: boolean; error?: string; [key: string]: unknown }

/** A thin Slack Web API client. */
export interface SlackClient {
  /** Calls a Web API method (`chat.postMessage`, …). Throws on `ok: false`. */
  call(method: string, params?: Record<string, unknown>, opts?: CallOptions): Promise<SlackResponse>
}

/**
 * The seconds or HTTP date in a Retry-After header, as milliseconds from `nowMs`.
 * Undefined when the header is missing or unreadable.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000)
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs)
}

const formBody = (params: Record<string, unknown>) => {
  const form = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  }
  return form.toString()
}

const withoutUndefined = (params: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null))

/**
 * Creates the Web API client: POSTs every method (form or JSON body), checks the
 * `ok: false` convention, and retries rate limits (429 with Retry-After, `ratelimited`)
 * and, for reads, 5xx and network errors with exponential backoff.
 *
 * Errors: `UnavailableError` for retryable failures once retries are used up;
 * `MpError('integration_request')` with `details.status` and `details.error` for the rest.
 */
export function createSlackClient(opts: SlackClientOptions): SlackClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const doFetch = opts.fetch ?? fetch
  const clock = opts.clock ?? systemClock
  const logger = opts.logger ?? silentLogger
  const attempts = Math.max(1, opts.retry?.attempts ?? 3)
  const maxDelayMs = opts.retry?.maxDelayMs ?? 30_000
  const baseDelayMs = opts.retry?.baseDelayMs ?? 500
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const redact = (s: string) => (opts.token ? s.split(opts.token).join('[redacted]') : s)

  const call: SlackClient['call'] = async (method, params = {}, callOpts = {}) => {
    const url = `${baseUrl}/${method}`
    const clean = withoutUndefined(params)
    const body = callOpts.json ? JSON.stringify(clean) : formBody(clean)
    const headers = {
      authorization: `Bearer ${opts.token}`,
      'content-type': callOpts.json ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded',
    }
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= attempts
      /** Waits before the next attempt, or throws when there is none. */
      const retry = async (delayMs: number, reason: string, details: Record<string, unknown>) => {
        if (last || delayMs > maxDelayMs) {
          throw new UnavailableError(`slack ${method}: ${reason}`, { method, attempts: attempt, ...details })
        }
        logger.warn('slack call retried', { method, attempt, delayMs, reason })
        await sleep(delayMs)
      }
      const backoff = baseDelayMs * 2 ** (attempt - 1)

      let res: Response
      try {
        res = await doFetch(url, { method: 'POST', headers, body })
      } catch (err) {
        const reason = redact(errorMessage(err))
        if (callOpts.write) throw new UnavailableError(`slack ${method}: request failed: ${reason}`, { method })
        await retry(backoff, `request failed: ${reason}`, {})
        continue
      }

      if (res.status === 429) {
        const wait = parseRetryAfter(res.headers.get('retry-after'), clock.now()) ?? backoff
        await res.body?.cancel().catch(() => {})
        await retry(wait, 'rate limited', { status: 429, retryAfterMs: wait })
        continue
      }
      if (res.status >= 500) {
        await res.body?.cancel().catch(() => {})
        if (callOpts.write) throw new UnavailableError(`slack ${method}: HTTP ${res.status}`, { method, status: res.status })
        await retry(backoff, `HTTP ${res.status}`, { status: res.status })
        continue
      }

      const text = await res.text()
      let data: SlackResponse | undefined
      try {
        data = JSON.parse(text) as SlackResponse
      } catch {
        data = undefined
      }
      if (!res.ok || !data || typeof data !== 'object') {
        throw new MpError('integration_request', `slack ${method}: HTTP ${res.status}`, {
          method,
          status: res.status,
          ...(data?.error ? { error: data.error } : {}),
        })
      }
      if (data.ok === false) {
        const error = typeof data.error === 'string' ? data.error : 'unknown_error'
        if (error === 'ratelimited') {
          const wait = parseRetryAfter(res.headers.get('retry-after'), clock.now()) ?? backoff
          await retry(wait, 'rate limited', { status: res.status, error, retryAfterMs: wait })
          continue
        }
        const messages = slackMessages(data)
        throw new MpError('integration_request', `slack ${method}: ${error}`, {
          method,
          status: res.status,
          error,
          ...(messages.length ? { messages } : {}),
          ...(typeof data.needed === 'string' ? { needed: data.needed } : {}),
        })
      }
      return data
    }
  }
  return { call }
}

/** Most of Slack's explanation lines kept with an error. */
const MAX_ERROR_MESSAGES = 10

/**
 * What Slack says about an error beyond its code: `response_metadata.messages` (e.g. for
 * `invalid_blocks`, `[ERROR] … [json-pointer:/blocks/0/text]`, naming the block) and `errors`.
 */
function slackMessages(data: SlackResponse): string[] {
  const meta = (data.response_metadata ?? {}) as { messages?: unknown }
  const lines = [meta.messages, data.errors].flatMap((v) => (Array.isArray(v) ? v : []))
  return [...new Set(lines.filter((l): l is string => typeof l === 'string' && l !== ''))].slice(0, MAX_ERROR_MESSAGES)
}

/** Slack's explanation lines of an error from the client (`response_metadata.messages`), if any. */
export function slackErrorMessages(err: unknown): string[] | undefined {
  if (err instanceof MpError && Array.isArray(err.details?.messages)) return err.details.messages as string[]
  return undefined
}

/** The Slack error code (`channel_not_found`, …) of an error from the client, if any. */
export function slackErrorCode(err: unknown): string | undefined {
  if (err instanceof MpError && typeof err.details?.error === 'string') return err.details.error
  return undefined
}
