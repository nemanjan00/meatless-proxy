import { type Clock, type Logger, MpError, silentLogger, systemClock, UnavailableError } from '@mp/core'

export const DEFAULT_LINEAR_URL = 'https://api.linear.app/graphql'

export interface LinearClientOptions {
  /** A personal API key (`lin_api_…`, sent as is) or an OAuth token (send it as `Bearer <token>`). */
  apiKey: string
  /** The GraphQL endpoint. Default `https://api.linear.app/graphql`. */
  baseUrl?: string
  fetch?: typeof fetch
  clock?: Clock
  logger?: Logger
  /** Retries after the first attempt for retryable failures. Default 3. */
  maxRetries?: number
  /** First backoff delay; doubles per retry. Default 500 ms. */
  retryBaseMs?: number
  /** Cap for one delay, including Retry-After and the rate-limit reset. Default 30 000 ms. */
  retryMaxMs?: number
  /** Per attempt. Default 30 000 ms. */
  timeoutMs?: number
  /** For tests. */
  sleep?: (ms: number) => Promise<void>
}

export interface RequestOptions {
  /**
   * A mutation is retried only when Linear provably didn't run it (429, RATELIMITED),
   * never on 5xx or network errors, so an issue is never created twice.
   */
  mutation?: boolean
  /** Overrides `maxRetries` for this call, e.g. 0 for best-effort lookups. */
  maxRetries?: number
}

/** A GraphQL error as Linear returns it. */
interface GqlError {
  message?: string
  extensions?: { code?: string; type?: string; userPresentableMessage?: string; http?: { status?: number } }
}

/** A thin GraphQL client for Linear, with retries on rate limits and 5xx, and typed errors. */
export interface LinearClient {
  /**
   * Runs one operation and returns its `data`. Throws `UnavailableError` when Linear stays unavailable
   * or rate limited, and `MpError('integration_request')` (details: status, code) for everything else.
   */
  request<T = any>(query: string, variables?: Record<string, unknown>, opts?: RequestOptions): Promise<T>
  /**
   * Follows `first`/`after` cursors: `select` picks the connection from `data`. Stops at `limit` nodes
   * or the last page, and returns the cursor to continue from.
   */
  paginate<N = any>(
    query: string,
    variables: Record<string, unknown>,
    select: (data: any) => { nodes: N[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } | null | undefined,
    limit: number,
  ): Promise<{ nodes: N[]; nextCursor: string | null }>
}

const PAGE_SIZE = 50

export function createLinearClient(opts: LinearClientOptions): LinearClient {
  const url = opts.baseUrl ?? DEFAULT_LINEAR_URL
  const doFetch = opts.fetch ?? globalThis.fetch
  const clock = opts.clock ?? systemClock
  const log = (opts.logger ?? silentLogger).child({ component: 'integration-linear' })
  const maxRetries = Math.max(0, opts.maxRetries ?? 3)
  const baseMs = opts.retryBaseMs ?? 500
  const maxMs = opts.retryMaxMs ?? 30_000
  const timeoutMs = opts.timeoutMs ?? 30_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const redact = (s: string) => (opts.apiKey ? s.split(opts.apiKey).join('[redacted]') : s)
  const operation = (q: string) => /\b(?:query|mutation)\s+(\w+)/.exec(q)?.[1] ?? 'anonymous'

  type Failure = { retryable: boolean; reason: string; status?: number; waitMs?: number; error?: MpError }

  async function attempt(query: string, variables: Record<string, unknown>, mutation: boolean): Promise<{ data: any } | Failure> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let res: Response
    let text: string
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: opts.apiKey },
        body: JSON.stringify({ query, variables }),
        signal: ctrl.signal,
      })
      text = await res.text()
    } catch (e) {
      const reason = ctrl.signal.aborted ? 'timed out' : `network error: ${redact(e instanceof Error ? e.message : String(e))}`
      return { retryable: !mutation, reason }
    } finally {
      clearTimeout(timer)
    }
    let body: { data?: any; errors?: GqlError[] } | null = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    const errors = Array.isArray(body?.errors) ? body.errors : []
    const rateLimited = res.status === 429 || errors.some((e) => e.extensions?.code === 'RATELIMITED')
    if (rateLimited) {
      return { retryable: true, reason: 'rate limited', status: res.status, waitMs: waitFor(res.headers, clock.now()) }
    }
    if (res.status >= 500) {
      return {
        retryable: !mutation,
        reason: `HTTP ${res.status}`,
        status: res.status,
        waitMs: waitFor(res.headers, clock.now()),
        ...(mutation ? { error: requestError(res.status, errors, text, true) } : {}),
      }
    }
    if (errors.length || !res.ok || !body || body.data == null) {
      const error = requestError(res.status, errors, text)
      return { retryable: false, reason: error.message, status: res.status, error }
    }
    return { data: body.data }
  }

  function requestError(status: number, errors: GqlError[], text: string, maybeApplied = false): MpError {
    const first = errors[0]
    const message = first
      ? (first.extensions?.userPresentableMessage ?? first.message ?? 'unknown error')
      : `HTTP ${status}${text ? `: ${text.slice(0, 200)}` : ''}`
    const code = first?.extensions?.code ?? first?.extensions?.type
    const note = maybeApplied ? ' (the change may have been applied: check before retrying)' : ''
    return new MpError('integration_request', `Linear: ${redact(message)}${note}`, {
      status: first?.extensions?.http?.status ?? status,
      ...(code ? { code } : {}),
      ...(errors.length > 1 ? { errors: errors.slice(0, 5).map((e) => redact(e.message ?? '')) } : {}),
    })
  }

  const client: LinearClient = {
    async request(query, variables = {}, ro = {}) {
      const retries = Math.max(0, ro.maxRetries ?? maxRetries)
      const op = operation(query)
      for (let n = 0; ; n++) {
        const out = await attempt(query, variables, !!ro.mutation)
        if ('data' in out) return out.data
        if (!out.retryable) {
          throw (
            out.error ??
            new UnavailableError(`Linear ${op} failed: ${out.reason}; it may have been applied, check before retrying`)
          )
        }
        if (n >= retries) {
          throw new UnavailableError(`Linear unavailable after ${n + 1} attempts: ${out.reason}`, {
            operation: op,
            attempts: n + 1,
            ...(out.status ? { status: out.status } : {}),
          })
        }
        const backoff = Math.min(maxMs, baseMs * 2 ** n)
        const delay = Math.min(maxMs, Math.max(backoff, out.waitMs ?? 0))
        log.warn('linear request failed, retrying', { operation: op, attempt: n + 1, reason: out.reason, delayMs: delay })
        await sleep(delay)
      }
    },

    async paginate(query, variables, select, limit) {
      const nodes: any[] = []
      let after: string | null = (variables.after as string | undefined) ?? null
      while (nodes.length < limit) {
        const first = Math.min(PAGE_SIZE, limit - nodes.length)
        const conn = select(await client.request(query, { ...variables, first, after }))
        const page = conn?.nodes ?? []
        nodes.push(...page)
        const more = !!conn?.pageInfo?.hasNextPage && !!conn.pageInfo.endCursor && page.length > 0
        after = more ? conn!.pageInfo!.endCursor! : null
        if (!after) break
      }
      return { nodes: nodes.slice(0, limit), nextCursor: after }
    },
  }
  return client
}

/** How long to wait before retrying: `Retry-After` (seconds or a date), else Linear's rate-limit reset (epoch ms). */
export function waitFor(headers: Headers, now: number): number | undefined {
  const ra = headers.get('retry-after')
  if (ra) {
    const secs = Number(ra)
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
    const at = Date.parse(ra)
    if (!Number.isNaN(at)) return Math.max(0, at - now)
  }
  const reset = headers.get('x-ratelimit-requests-reset') ?? headers.get('x-ratelimit-complexity-reset')
  if (reset && Number.isFinite(Number(reset))) return Math.max(0, Number(reset) - now)
  return undefined
}
