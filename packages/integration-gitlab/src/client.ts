import { type Clock, DeniedError, type Logger, MpError, silentLogger, systemClock, UnavailableError } from '@mp/core'

export const DEFAULT_BASE_URL = 'https://gitlab.com'

export interface GitlabClientOptions {
  /** The GitLab instance, e.g. `https://gitlab.com` or `https://git.example.com/gitlab`. The API is at `<baseUrl>/api/v4`. */
  baseUrl?: string
  /** A personal, project or group access token, sent as `PRIVATE-TOKEN`. */
  token: string
  fetch?: typeof fetch
  clock?: Clock
  logger?: Logger
  /** Retries after the first attempt, for 429, 5xx and network errors. Default 3. */
  maxRetries?: number
  /** First backoff delay; doubles per retry. Default 500 ms. */
  retryBaseMs?: number
  /** Cap for one backoff delay, Retry-After included. Default 30 000 ms. */
  retryMaxMs?: number
  /** Per attempt. Default 30 000 ms. */
  timeoutMs?: number
}

export type Query = Record<string, string | number | boolean | string[] | undefined>

export interface RequestOptions {
  query?: Query
  body?: Record<string, unknown>
  /** Return the body as text instead of parsing JSON (raw files, job traces). */
  raw?: boolean
}

export interface GitlabResponse<T> {
  status: number
  headers: Headers
  data: T
}

/** A thin GitLab REST v4 client: retries, pagination, typed errors, and a hard refusal of anything that merges. */
export interface GitlabClient {
  readonly apiUrl: string
  request<T = any>(method: string, path: string, opts?: RequestOptions): Promise<GitlabResponse<T>>
  get<T = any>(path: string, query?: Query): Promise<T>
  getText(path: string, query?: Query): Promise<string>
  post<T = any>(path: string, body: Record<string, unknown>): Promise<T>
  put<T = any>(path: string, body: Record<string, unknown>): Promise<T>
  /** Follows `X-Next-Page` until `limit` items are collected or there are no more pages. */
  paginate<T = any>(path: string, query?: Query, limit?: number): Promise<T[]>
}

/** `123` or `'123'` stay as they are; a path like `group/sub/repo` is URL-encoded, as the API expects. */
export function projectRef(project: string | number): string {
  const s = String(project).trim()
  if (/^\d+$/.test(s)) return s
  return encodeURIComponent(s.replace(/^\/+|\/+$/g, ''))
}

/** Retry-After in ms: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined
  const s = Number(value)
  if (Number.isFinite(s)) return Math.max(0, s * 1000)
  const t = Date.parse(value)
  return Number.isNaN(t) ? undefined : Math.max(0, t - nowMs)
}

/**
 * Anything that would merge, approve or set auto-merge. Employees never merge
 * (docs/spec.md#no-production-access): the token should not allow it, and this
 * client refuses it anyway, whatever the caller asks for.
 */
const MERGE_PATHS = [
  /\/merge_requests\/[^/]+\/(merge|approve|approvals|unapprove|merge_when_pipeline_succeeds)$/,
  /\/merge_trains\b/,
]
const MERGE_FIELDS = ['merge_when_pipeline_succeeds', 'auto_merge', 'auto_merge_strategy', 'merge_commit_message']

export function assertNotMerging(method: string, path: string, body?: Record<string, unknown>): void {
  if (method === 'GET' || method === 'HEAD') return
  const bare = path.split('?')[0]!
  if (MERGE_PATHS.some((re) => re.test(bare))) throw new DeniedError('employees never merge or approve merge requests')
  if (body && /\/merge_requests\b/.test(bare)) {
    const field = MERGE_FIELDS.find((f) => f in body)
    if (field) throw new DeniedError(`employees never merge: '${field}' is refused`)
    if (body.state_event === 'merge') throw new DeniedError('employees never merge merge requests')
  }
}

const RETRYABLE = (status: number) => status === 408 || status === 429 || status >= 500

export function createGitlabClient(opts: GitlabClientOptions): GitlabClient {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const apiUrl = `${base}/api/v4`
  const doFetch = opts.fetch ?? globalThis.fetch
  const clock = opts.clock ?? systemClock
  const logger = opts.logger ?? silentLogger
  const maxRetries = opts.maxRetries ?? 3
  const retryBaseMs = opts.retryBaseMs ?? 500
  const retryMaxMs = opts.retryMaxMs ?? 30_000
  const timeoutMs = opts.timeoutMs ?? 30_000
  const redact = (s: string) => (opts.token ? s.split(opts.token).join('[redacted]') : s)

  const buildUrl = (path: string, query?: Query) => {
    const url = new URL(apiUrl + (path.startsWith('/') ? path : `/${path}`))
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue
      if (Array.isArray(v)) {
        for (const x of v) url.searchParams.append(`${k}[]`, x)
      } else url.searchParams.set(k, String(v))
    }
    return url.toString()
  }

  const backoff = (attempt: number, retryAfterMs?: number) =>
    Math.min(retryMaxMs, retryAfterMs ?? retryBaseMs * 2 ** attempt * (0.75 + Math.random() * 0.5))

  async function request<T>(method: string, path: string, ro: RequestOptions = {}): Promise<GitlabResponse<T>> {
    assertNotMerging(method, path, ro.body)
    const url = buildUrl(path, ro.query)
    const where = { method, path: path.split('?')[0] }
    let lastError = ''
    let lastStatus: number | undefined
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res: Response
      try {
        res = await doFetch(url, {
          method,
          headers: {
            'PRIVATE-TOKEN': opts.token,
            accept: ro.raw ? '*/*' : 'application/json',
            ...(ro.body ? { 'content-type': 'application/json' } : {}),
          },
          ...(ro.body ? { body: JSON.stringify(ro.body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        lastError = redact(e instanceof Error ? e.message : String(e))
        lastStatus = undefined
        if (attempt < maxRetries) {
          const wait = backoff(attempt)
          logger.warn('gitlab request failed, retrying', { ...where, error: lastError, attempt, waitMs: Math.round(wait) })
          await sleep(wait)
          continue
        }
        break
      }
      if (res.ok) {
        const data = (ro.raw ? await res.text() : res.status === 204 ? null : await res.json().catch(() => null)) as T
        logger.debug('gitlab request', { ...where, status: res.status })
        return { status: res.status, headers: res.headers, data }
      }
      const text = redact(await res.text().catch(() => ''))
      lastStatus = res.status
      lastError = apiMessage(text) || res.statusText || `HTTP ${res.status}`
      if (RETRYABLE(res.status) && attempt < maxRetries) {
        const wait = backoff(attempt, parseRetryAfter(res.headers.get('retry-after'), clock.now()))
        logger.warn('gitlab request retrying', { ...where, status: res.status, attempt, waitMs: Math.round(wait) })
        await sleep(wait)
        continue
      }
      if (RETRYABLE(res.status)) break
      throw new MpError('integration_request', `GitLab ${method} ${where.path}: ${res.status} ${lastError}`, {
        status: res.status,
        ...where,
      })
    }
    throw new UnavailableError(`GitLab ${method} ${where.path} unavailable: ${lastStatus ?? 'network'} ${lastError}`.trim(), {
      ...(lastStatus ? { status: lastStatus } : {}),
      ...where,
    })
  }

  const client: GitlabClient = {
    apiUrl,
    request,
    get: async (path, query) => (await request<any>('GET', path, { query })).data,
    getText: async (path, query) => (await request<string>('GET', path, { query, raw: true })).data,
    post: async (path, body) => (await request<any>('POST', path, { body })).data,
    put: async (path, body) => (await request<any>('PUT', path, { body })).data,
    async paginate(path, query = {}, limit = 100) {
      const out: any[] = []
      const perPage = Math.max(1, Math.min(100, limit))
      let page: string | null = '1'
      for (let n = 0; page && out.length < limit && n < 100; n++) {
        const res: GitlabResponse<any> = await request<any>('GET', path, { query: { ...query, per_page: perPage, page } })
        if (!Array.isArray(res.data)) break
        out.push(...res.data)
        page = res.headers.get('x-next-page') || null
      }
      return out.slice(0, limit)
    },
  }
  return client
}

/** GitLab errors look like `{"message": …}` or `{"error": …}`; `message` may be an object of field errors. */
function apiMessage(text: string): string {
  try {
    const j = JSON.parse(text)
    const m = j?.message ?? j?.error_description ?? j?.error
    if (typeof m === 'string') return m
    if (m && typeof m === 'object') return JSON.stringify(m)
  } catch {}
  return text.slice(0, 300)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
