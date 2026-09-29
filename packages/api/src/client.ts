import { ApiRequestError, codeForStatus, type ApiErrorBody } from './errors.ts'
import type {
  ApiEntry,
  ApiRef,
  ApiEvent,
  ApiToken,
  AuthConfig,
  CreatedApiToken,
  LoginLink,
  PreviewToken,
  SessionPreview,
  ApiKindSchema,
  ApiLink,
  ApiLinkedRecord,
  ApiRecord,
  ApiRevision,
  ChannelData,
  ChannelSummary,
  ChatMember,
  ChatSearchResult,
  ChatThread,
  ChannelUnread,
  ControlState,
  EntryTree,
  EventDetail,
  FileContent,
  FileEntry,
  Health,
  InboxItem,
  Json,
  LineageGraph,
  Me,
  Message,
  NowSnapshot,
  Page,
  Run,
  RunState,
  SecretInfo,
  SecretScope,
  Session,
  SessionDetail,
  SessionListItem,
  SessionStatus,
  SessionTreeNode,
  Subscription,
  TokenTotals,
  TriggerStats,
  UsageBreakdown,
  UsageFilter,
  UsageGroupBy,
  UsageSeries,
} from './resources.ts'

/**
 * Every endpoint of the HTTP API, as `[method, path]`. Path parameters are
 * `:name`. The client builds its requests from this table, and the server
 * can check that it implements every route. Documentation for each route is
 * on the matching `ApiClient` method.
 */
export const ROUTES = {
  kinds: ['GET', '/api/kinds'],
  listRecords: ['GET', '/api/records/:kind'],
  getRecord: ['GET', '/api/records/:kind/:id'],
  createRecord: ['POST', '/api/records/:kind'],
  updateRecord: ['PATCH', '/api/records/:kind/:id'],
  deleteRecord: ['DELETE', '/api/records/:kind/:id'],
  recordLinks: ['GET', '/api/records/:kind/:id/links'],
  createLink: ['POST', '/api/records/:kind/:id/links'],
  deleteLink: ['DELETE', '/api/links/:id'],
  recordRevisions: ['GET', '/api/records/:kind/:id/revisions'],
  recordBacklinks: ['GET', '/api/records/:kind/:id/backlinks'],

  listSessions: ['GET', '/api/sessions'],
  getSession: ['GET', '/api/sessions/:id'],
  sessionHistory: ['GET', '/api/sessions/:id/history'],
  sessionTree: ['GET', '/api/sessions/:id/tree'],
  sessionEntryTree: ['GET', '/api/sessions/:id/entry-tree'],
  sessionRuns: ['GET', '/api/sessions/:id/runs'],
  sessionSubscriptions: ['GET', '/api/subscriptions'],
  forkSession: ['POST', '/api/sessions/:id/fork'],
  sendMessage: ['POST', '/api/sessions/:id/message'],
  sessionPreview: ['GET', '/api/sessions/:id/preview'],
  previewToken: ['POST', '/api/previews/token'],
  entryChildren: ['GET', '/api/entries/:id/children'],
  getRun: ['GET', '/api/runs/:id'],
  runHistory: ['GET', '/api/runs/:id/history'],
  pauseRun: ['POST', '/api/runs/:id/pause'],
  resumeRun: ['POST', '/api/runs/:id/resume'],
  cancelRun: ['POST', '/api/runs/:id/cancel'],
  lineage: ['GET', '/api/lineage/:id'],

  now: ['GET', '/api/now'],
  inbox: ['GET', '/api/inbox'],

  listEvents: ['GET', '/api/events'],
  getEvent: ['GET', '/api/events/:id'],
  ingestEvent: ['POST', '/api/events'],
  listTriggers: ['GET', '/api/triggers'],

  listChannels: ['GET', '/api/chat/channels'],
  createChannel: ['POST', '/api/chat/channels'],
  channelMessages: ['GET', '/api/chat/channels/:id/messages'],
  getThread: ['GET', '/api/chat/threads/:id'],
  postMessage: ['POST', '/api/chat/channels/:id/messages'],
  addMember: ['POST', '/api/chat/channels/:id/members'],
  editMessage: ['PATCH', '/api/chat/messages/:id'],
  deleteMessage: ['DELETE', '/api/chat/messages/:id'],
  addReaction: ['POST', '/api/chat/messages/:id/reactions'],
  removeReaction: ['DELETE', '/api/chat/messages/:id/reactions'],
  markRead: ['POST', '/api/chat/read'],
  unread: ['GET', '/api/chat/unread'],
  openDm: ['POST', '/api/chat/dms'],
  searchChat: ['GET', '/api/chat/search'],
  me: ['GET', '/api/me'],

  authConfig: ['GET', '/api/auth/config'],
  logout: ['POST', '/api/auth/logout'],
  listTokens: ['GET', '/api/auth/tokens'],
  createToken: ['POST', '/api/auth/tokens'],
  revokeToken: ['DELETE', '/api/auth/tokens/:id'],
  createLoginLink: ['POST', '/api/auth/links'],

  usageTotals: ['GET', '/api/usage/totals'],
  usageBreakdown: ['GET', '/api/usage/breakdown'],
  usageSeries: ['GET', '/api/usage/series'],

  listFiles: ['GET', '/api/files/:employeeId'],
  readFile: ['GET', '/api/files/:employeeId/content'],
  writeFile: ['PUT', '/api/files/:employeeId/content'],

  listSecrets: ['GET', '/api/secrets'],
  putSecret: ['PUT', '/api/secrets'],
  deleteSecret: ['DELETE', '/api/secrets'],

  control: ['GET', '/api/control'],
  pauseAll: ['POST', '/api/control/pause-all'],
  resumeAll: ['POST', '/api/control/resume-all'],
  health: ['GET', '/healthz'],
  ready: ['GET', '/readyz'],
} as const satisfies Record<string, readonly [HttpMethod, string]>

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type RouteName = keyof typeof ROUTES

/** Query for `GET /api/records/:kind`. */
export interface RecordListQuery {
  /** Case-insensitive substring search over the record's data. */
  text?: string
  /**
   * Conditions, sent as JSON in the `where` query parameter. Either a
   * shorthand object (`{ "status": "active" }`, equality) or a list of
   * `{ field, op, value }` with op in eq, ne, in, nin, gt, gte, lt, lte,
   * contains, like, exists. `field` is `id`, `key`, `version`, `createdAt`,
   * `updatedAt` or a dot path into `data`.
   */
  where?: Record<string, Json> | { field: string; op: string; value: Json }[]
  /** `createdAt`, `updatedAt`, or a data field. Default `updatedAt`. */
  orderBy?: string
  dir?: 'asc' | 'desc'
  /** Default 50, maximum 500. */
  limit?: number
  offset?: number
}

export interface SessionListQuery {
  employeeId?: string
  /** One status, or several separated by commas. */
  status?: SessionStatus | string
  text?: string
  /** Only sessions of this fork tree. */
  rootId?: string
  limit?: number
  offset?: number
}

export interface EventListQuery {
  source?: string
  type?: string
  /**
   * `true`: routed; `false`: not routed yet; `unmatched`: routed, no rule matched and it went to a
   * fallback router session (events delivered to nobody are not included).
   */
  routed?: 'true' | 'false' | 'unmatched'
  subject?: string
  limit?: number
  offset?: number
}

export interface ChatSearchQuery {
  text?: string
  channelId?: string
  /** `contact:con_…`, `session:ses_…`, or a bare id. */
  author?: string
  tagged?: string
  threadId?: string
  limit?: number
}

export interface IngestEventBody {
  source: string
  type: string
  /** Deduplication key; defaults to source + a hash of the payload. */
  dedupeKey?: string
  subject?: { system: string; ref: string; title?: string }
  payload: Json
}

export interface ApiClientOptions {
  /** e.g. `http://localhost:3000` or `''` for same origin. */
  baseUrl: string
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /**
   * Extra headers on every request, e.g. `{ authorization: 'Bearer mpt_…' }`. A function is called per
   * request (the web UI echoes its CSRF cookie this way).
   */
  headers?: Record<string, string> | (() => Record<string, string>)
  /** Called on every 401 (not signed in, or the sign-in expired), before the error is thrown. */
  onUnauthorized?: () => void
}

/**
 * The typed HTTP API. The server implements exactly these routes; the web UI
 * (and its mock) code against this interface. Errors are thrown as
 * `ApiRequestError` (see errors.ts for the error body and status codes).
 */
export interface ApiClient {
  // ── Records ──────────────────────────────────────────────────────────────

  /** `GET /api/kinds` → every record kind's schema (core and extension fields, title field). */
  kinds(): Promise<ApiKindSchema[]>
  /**
   * `GET /api/records/:kind?text=&where=<json>&orderBy=&dir=&limit=&offset=`
   * → `{ items, total }`. `where` is URL-encoded JSON (see `RecordListQuery`).
   */
  listRecords<T = Record<string, unknown>>(kind: string, query?: RecordListQuery): Promise<Page<ApiRecord<T>>>
  /** `GET /api/records/:kind/:id` → the record. 404 when missing. */
  getRecord<T = Record<string, unknown>>(kind: string, id: string): Promise<ApiRecord<T>>
  /**
   * `POST /api/records/:kind` body `{ data, key? }` → the created record (201).
   * Validated against the kind's schema (422 with issues in `details`).
   * A duplicate key is 409.
   */
  createRecord<T = Record<string, unknown>>(kind: string, data: T, opts?: { key?: string }): Promise<ApiRecord<T>>
  /**
   * `PATCH /api/records/:kind/:id` body `{ data, version }` → the updated
   * record. `data` is shallow-merged (null removes a field). `version` is the
   * version the edit was based on: 409 with the current record in `details`
   * when it has moved on.
   */
  updateRecord<T = Record<string, unknown>>(kind: string, id: string, data: Partial<T>, version: number): Promise<ApiRecord<T>>
  /** `DELETE /api/records/:kind/:id?version=&cascade=` → 204. 409 if it still has links and `cascade` isn't set. */
  deleteRecord(kind: string, id: string, opts?: { version?: number; cascade?: boolean }): Promise<void>
  /**
   * `GET /api/records/:kind/:id/links?direction=out|in|both&role=` →
   * `{ link, record }[]`, where `record` is the other end. Default `both`.
   */
  recordLinks(kind: string, id: string, opts?: { direction?: 'out' | 'in' | 'both'; role?: string }): Promise<ApiLinkedRecord[]>
  /** `POST /api/records/:kind/:id/links` body `{ to: {kind,id}, role, data? }` → the link (idempotent per pair and role). */
  createLink(
    kind: string,
    id: string,
    to: { kind: string; id: string },
    role: string,
    data?: Record<string, unknown>,
  ): Promise<ApiLink>
  /** `DELETE /api/links/:id` → 204. */
  deleteLink(linkId: string): Promise<void>
  /** `GET /api/records/:kind/:id/revisions` → every version, oldest first, with who made it. */
  recordRevisions<T = Record<string, unknown>>(kind: string, id: string): Promise<ApiRevision<T>[]>
  /** `GET /api/records/:kind/:id/backlinks` → records whose documents mention this one with `[[kind:id]]`. */
  recordBacklinks(kind: string, id: string): Promise<ApiRecord[]>

  // ── Sessions and runs ────────────────────────────────────────────────────

  /** `GET /api/sessions?employeeId=&status=&text=&rootId=&limit=&offset=` → rows, newest activity first. */
  listSessions(query?: SessionListQuery): Promise<Page<SessionListItem>>
  /** `GET /api/sessions/:id` → the session with its checklist, active run, links, threads and token totals. */
  getSession(id: string): Promise<SessionDetail>
  /** `GET /api/sessions/:id/history` → committed entries, root to head. */
  sessionHistory(id: string): Promise<ApiEntry[]>
  /** `GET /api/sessions/:id/tree` → the whole fork tree the session is in, from its root. */
  sessionTree(id: string): Promise<SessionTreeNode>
  /**
   * `GET /api/sessions/:id/entry-tree` → every entry of the session's history
   * tree: the committed path, ephemeral run branches, rewound branches (with
   * their summaries) and offloaded entries (with their pointers).
   */
  sessionEntryTree(id: string): Promise<EntryTree>
  /** `GET /api/sessions/:id/runs` → the session's runs, newest first. */
  sessionRuns(id: string): Promise<Run[]>
  /** `GET /api/subscriptions?sessionId=` → subscriptions, optionally of one session. */
  subscriptions(query?: { sessionId?: string }): Promise<Subscription[]>
  /** `POST /api/sessions/:id/fork` body `{ atEntry?, title? }` → the new session. */
  forkSession(id: string, body?: { atEntry?: string; title?: string }): Promise<Session>
  /**
   * `POST /api/sessions/:id/message` body `{ text }` → the stored event and
   * its delivery. The text becomes a `ui` event delivered to the session:
   * it starts a run, or goes into the active run's inbox.
   */
  sendMessage(id: string, text: string): Promise<{ event: ApiEvent; runId: string | null; inbox: boolean }>
  /** `GET /api/sessions/:id/preview` → the ports the session's environment serves, and the commit it runs. */
  sessionPreview(id: string): Promise<SessionPreview>
  /**
   * `POST /api/previews/token` body `{ envId, port }` → a preview token and the URL that opens the
   * preview with it (members; 404 when the environment is gone or doesn't expose the port).
   */
  previewToken(envId: string, port: number): Promise<PreviewToken>
  /** `GET /api/entries/:id/children` → entries whose parent is this one (branches). */
  entryChildren(entryId: string): Promise<ApiEntry[]>
  /** `GET /api/runs/:id` → the run. */
  getRun(id: string): Promise<Run>
  /** `GET /api/runs/:id/history` → session history up to the run's base, then the run's own entries. */
  runHistory(id: string): Promise<ApiEntry[]>
  /** `POST /api/runs/:id/pause` body `{ reason? }` → the run (paused at its next step boundary). */
  pauseRun(id: string, reason?: string): Promise<Run>
  /** `POST /api/runs/:id/resume` → the run, back in `queued`. */
  resumeRun(id: string): Promise<Run>
  /** `POST /api/runs/:id/cancel` → the run (cancelled at its next step boundary). */
  cancelRun(id: string): Promise<Run>
  /**
   * `GET /api/lineage/:id` for an event, session or run id → its lineage graph:
   * upstream (event → trigger/subscription → context → forks leading to it)
   * and downstream (everything it caused: deliveries, runs, forks, loops,
   * emitted events).
   */
  lineage(id: string): Promise<LineageGraph>

  // ── Activity ─────────────────────────────────────────────────────────────

  /** `GET /api/now` → running, queued, suspended and paused runs with their live facts. */
  now(): Promise<NowSnapshot>
  /** `GET /api/inbox` → items for people: mentions, approvals, paused runs, reviews, limits. */
  inbox(): Promise<InboxItem[]>

  // ── Events and triggers ──────────────────────────────────────────────────

  /** `GET /api/events?source=&type=&routed=&subject=&limit=&offset=` → events, newest first. */
  listEvents(query?: EventListQuery): Promise<Page<ApiEvent>>
  /** `GET /api/events/:id` → the event with the deliveries and runs it caused. */
  getEvent(id: string): Promise<EventDetail>
  /**
   * `POST /api/events` (webhook ingest) body `IngestEventBody` → `{ event, created }`.
   * Deduplicated by `dedupeKey`: a repeat returns the stored event with `created: false` (200, else 201).
   */
  ingestEvent(body: IngestEventBody): Promise<{ event: ApiEvent; created: boolean }>
  /** `GET /api/triggers` → every trigger with its context, fire count and recent events. */
  triggers(): Promise<TriggerStats[]>

  // ── Chat ─────────────────────────────────────────────────────────────────

  /** `GET /api/chat/channels` → channels (incl. DMs), with activity. */
  channels(): Promise<ChannelSummary[]>
  /**
   * `POST /api/chat/channels` body `{ name, topic?, members?, dm? }` → the channel. With `dm: true` it's a
   * direct message: the current person is added as a member too.
   */
  createChannel(body: { name: string; topic?: string; members?: ChatMember[]; dm?: boolean }): Promise<ApiRecord<ChannelData>>
  /** `GET /api/chat/channels/:id/messages?before=&limit=` → top-level messages, oldest first. */
  channelMessages(channelId: string, query?: { before?: string; limit?: number }): Promise<Message[]>
  /** `GET /api/chat/threads/:id` (id = root message id) → the root, its replies and the sessions on it. */
  thread(threadId: string): Promise<ChatThread>
  /**
   * `POST /api/chat/channels/:id/messages` body `{ text, threadId? }` → the
   * message, posted as the current person. Tags in the text are parsed and
   * routed.
   */
  postMessage(channelId: string, body: { text: string; threadId?: string }): Promise<Message>
  /** `POST /api/chat/channels/:id/members` body `ChatMember` → the channel. */
  addMember(channelId: string, member: Omit<ChatMember, 'label'> & { label?: string }): Promise<ApiRecord<ChannelData>>
  /** `PATCH /api/chat/messages/:id` body `{ text }` → the message. Only its author may edit it (403 otherwise). */
  editMessage(messageId: string, text: string): Promise<Message>
  /** `DELETE /api/chat/messages/:id` → the message, now a placeholder (empty text, `deleted`). Author only (403). */
  deleteMessage(messageId: string): Promise<Message>
  /** `POST /api/chat/messages/:id/reactions` body `{ emoji }` → the message (idempotent). */
  addReaction(messageId: string, emoji: string): Promise<Message>
  /** `DELETE /api/chat/messages/:id/reactions?emoji=` → the message (idempotent). */
  removeReaction(messageId: string, emoji: string): Promise<Message>
  /** `POST /api/chat/read` body `{ scope, messageId? }` → 204. `scope` is a channel id or a thread's root id. */
  markRead(scope: string, messageId?: string): Promise<void>
  /** `GET /api/chat/unread` → unread and mention counts per channel for the current person. */
  unread(): Promise<ChannelUnread[]>
  /** `POST /api/chat/dms` body `{ members: [{ kind, id }] }` → the DM with exactly these members and you (created if new). */
  openDm(members: ApiRef[]): Promise<ApiRecord<ChannelData>>
  /**
   * `GET /api/chat/search?text=&channelId=&author=&tagged=&threadId=&limit=` → matching messages, newest first,
   * with their channel and thread. `author` is `kind:id` or an id; `tagged` an employee, session or contact id.
   */
  searchChat(query: ChatSearchQuery): Promise<ChatSearchResult[]>
  /** `GET /api/me` → who is signed in, with their access. 401 when nobody is. */
  me(): Promise<Me>

  // ── Sign-in and tokens ───────────────────────────────────────────────────

  /** `GET /api/auth/config` (no sign-in needed) → what the login page offers, e.g. OIDC. */
  authConfig(): Promise<AuthConfig>
  /** `POST /api/auth/logout` → 204. Ends the web session and clears its cookie. */
  logout(): Promise<void>
  /** `GET /api/auth/tokens?contactId=&all=` → API tokens, newest first: yours; anyone's (or `all`) for admins. */
  listTokens(query?: { contactId?: string; all?: boolean }): Promise<ApiToken[]>
  /**
   * `POST /api/auth/tokens` body `{ name?, contactId? }` → the new token (201), shown only this once.
   * The same token works for `/api`, `/ws` and `/mcp`. Tokens for others: admins.
   */
  createToken(body?: { name?: string; contactId?: string }): Promise<CreatedApiToken>
  /** `DELETE /api/auth/tokens/:id` → the token, revoked (idempotent). Others' tokens: admins. */
  revokeToken(id: string): Promise<ApiToken>
  /** `POST /api/auth/links` body `{ contactId }` or `{ email }` → a one-time sign-in link (admins). */
  createLoginLink(who: { contactId: string } | { email: string }): Promise<LoginLink>

  // ── Usage ────────────────────────────────────────────────────────────────

  /** `GET /api/usage/totals?runId=&employeeId=&sessionId=&rootSessionId=&projectId=&requesterId=&templateId=&model=&since=&until=`. */
  usageTotals(filter?: UsageFilter): Promise<TokenTotals>
  /** `GET /api/usage/breakdown?groupBy=&since=&…filters` → rows per group. */
  usageBreakdown(groupBy: UsageGroupBy, filter?: UsageFilter): Promise<UsageBreakdown>
  /** `GET /api/usage/series?interval=hour|day&splitBy=&since=&…filters` → points over time. */
  usageSeries(interval: 'hour' | 'day', filter?: UsageFilter & { splitBy?: UsageGroupBy }): Promise<UsageSeries>

  // ── Files ────────────────────────────────────────────────────────────────

  /** `GET /api/files/:employeeId?dir=/` → a directory listing (own files and `/shared`). */
  listFiles(employeeId: string, dir?: string): Promise<FileEntry[]>
  /** `GET /api/files/:employeeId/content?path=` → the file. */
  readFile(employeeId: string, path: string): Promise<FileContent>
  /** `PUT /api/files/:employeeId/content?path=` body `{ content, version? }` → the file. 409 on a version mismatch. */
  writeFile(employeeId: string, path: string, content: string, version?: number): Promise<FileContent>

  // ── Secrets ──────────────────────────────────────────────────────────────

  /** `GET /api/secrets` → names and scopes only, never values. */
  secrets(): Promise<SecretInfo[]>
  /** `PUT /api/secrets` body `{ name, value, scope }` → the secret's info (create or replace). */
  putSecret(name: string, value: string, scope: SecretScope): Promise<SecretInfo>
  /** `DELETE /api/secrets?name=&scopeType=&scopeId=` → 204. */
  deleteSecret(name: string, scope: SecretScope): Promise<void>

  // ── Control and health ───────────────────────────────────────────────────

  /** `GET /api/control` → the global pause flag. */
  control(): Promise<ControlState>
  /** `POST /api/control/pause-all` → pauses every employee at the next step boundary (kill switch). */
  pauseAll(): Promise<ControlState>
  /** `POST /api/control/resume-all` → clears the global pause; paused runs go back to `queued`. */
  resumeAll(): Promise<ControlState>
  /** `GET /healthz` → the process is up. */
  health(): Promise<Health>
  /** `GET /readyz` → database, queue and migrations are ready (503 otherwise). */
  ready(): Promise<Health>
}

type Query = Record<string, string | number | boolean | undefined | null>

/** Fills `:name` parameters (URL-encoded). */
export function buildPath(template: string, params: Record<string, string> = {}): string {
  return template.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const v = params[name]
    if (v === undefined) throw new Error(`missing path parameter ${name}`)
    return encodeURIComponent(v)
  })
}

/** Serialises a query, dropping undefined, null and empty values. */
export function buildQuery(query: Query = {}): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

function usageQuery(f: UsageFilter & { splitBy?: UsageGroupBy } = {}): Query {
  return { ...f }
}

/** A small typed `fetch` client for the API. */
export function createApiClient(opts: ApiClientOptions): ApiClient {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a))
  const base = opts.baseUrl.replace(/\/$/, '')

  async function call<T>(route: RouteName, params?: Record<string, string>, query?: Query, body?: unknown): Promise<T> {
    const [method, template] = ROUTES[route]
    const url = `${base}${buildPath(template, params)}${buildQuery(query)}`
    const extra = typeof opts.headers === 'function' ? opts.headers() : opts.headers
    const headers: Record<string, string> = { accept: 'application/json', ...extra }
    const init: RequestInit = { method, headers }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    let res: Response
    try {
      res = await doFetch(url, init)
    } catch (err) {
      throw new ApiRequestError(0, 'unavailable', err instanceof Error ? err.message : String(err))
    }
    if (res.status === 204) return undefined as T
    if (res.status === 401) opts.onUnauthorized?.()
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = undefined
    }
    if (!res.ok) {
      const e = (parsed as { error?: ApiErrorBody } | undefined)?.error
      throw new ApiRequestError(
        res.status,
        e?.code ?? codeForStatus(res.status),
        e?.message ?? `${method} ${url} failed: ${res.status}`,
        e?.details,
      )
    }
    return parsed as T
  }

  return {
    kinds: () => call('kinds'),
    listRecords: (kind, q = {}) =>
      call('listRecords', { kind }, { ...q, where: q.where ? JSON.stringify(q.where) : undefined } as Query),
    getRecord: (kind, id) => call('getRecord', { kind, id }),
    createRecord: (kind, data, o = {}) => call('createRecord', { kind }, undefined, { data, ...o }),
    updateRecord: (kind, id, data, version) => call('updateRecord', { kind, id }, undefined, { data, version }),
    deleteRecord: (kind, id, o = {}) => call('deleteRecord', { kind, id }, { version: o.version, cascade: o.cascade }),
    recordLinks: (kind, id, o = {}) => call('recordLinks', { kind, id }, o),
    createLink: (kind, id, to, role, data) => call('createLink', { kind, id }, undefined, { to, role, data }),
    deleteLink: (linkId) => call('deleteLink', { id: linkId }),
    recordRevisions: (kind, id) => call('recordRevisions', { kind, id }),
    recordBacklinks: (kind, id) => call('recordBacklinks', { kind, id }),

    listSessions: (q = {}) => call('listSessions', undefined, { ...q }),
    getSession: (id) => call('getSession', { id }),
    sessionHistory: (id) => call('sessionHistory', { id }),
    sessionTree: (id) => call('sessionTree', { id }),
    sessionEntryTree: (id) => call('sessionEntryTree', { id }),
    sessionRuns: (id) => call('sessionRuns', { id }),
    subscriptions: (q = {}) => call('sessionSubscriptions', undefined, { ...q }),
    forkSession: (id, body = {}) => call('forkSession', { id }, undefined, body),
    sendMessage: (id, text) => call('sendMessage', { id }, undefined, { text }),
    sessionPreview: (id) => call('sessionPreview', { id }),
    previewToken: (envId, port) => call('previewToken', undefined, undefined, { envId, port }),
    entryChildren: (id) => call('entryChildren', { id }),
    getRun: (id) => call('getRun', { id }),
    runHistory: (id) => call('runHistory', { id }),
    pauseRun: (id, reason) => call('pauseRun', { id }, undefined, { reason }),
    resumeRun: (id) => call('resumeRun', { id }, undefined, {}),
    cancelRun: (id) => call('cancelRun', { id }, undefined, {}),
    lineage: (id) => call('lineage', { id }),

    now: () => call('now'),
    inbox: () => call('inbox'),

    listEvents: (q = {}) => call('listEvents', undefined, { ...q }),
    getEvent: (id) => call('getEvent', { id }),
    ingestEvent: (body) => call('ingestEvent', undefined, undefined, body),
    triggers: () => call('listTriggers'),

    channels: () => call('listChannels'),
    createChannel: (body) => call('createChannel', undefined, undefined, body),
    channelMessages: (id, q = {}) => call('channelMessages', { id }, { ...q }),
    thread: (id) => call('getThread', { id }),
    postMessage: (id, body) => call('postMessage', { id }, undefined, body),
    addMember: (id, member) => call('addMember', { id }, undefined, member),
    editMessage: (id, text) => call('editMessage', { id }, undefined, { text }),
    deleteMessage: (id) => call('deleteMessage', { id }),
    addReaction: (id, emoji) => call('addReaction', { id }, undefined, { emoji }),
    removeReaction: (id, emoji) => call('removeReaction', { id }, { emoji }),
    markRead: (scope, messageId) => call('markRead', undefined, undefined, { scope, ...(messageId ? { messageId } : {}) }),
    unread: () => call('unread'),
    openDm: (members) => call('openDm', undefined, undefined, { members }),
    searchChat: (q) => call('searchChat', undefined, { ...q }),
    me: () => call('me'),

    authConfig: () => call('authConfig'),
    logout: () => call('logout', undefined, undefined, {}),
    listTokens: (q = {}) => call('listTokens', undefined, { ...q }),
    createToken: (body = {}) => call('createToken', undefined, undefined, body),
    revokeToken: (id) => call('revokeToken', { id }),
    createLoginLink: (who) => call('createLoginLink', undefined, undefined, who),

    usageTotals: (f) => call('usageTotals', undefined, usageQuery(f)),
    usageBreakdown: (groupBy, f) => call('usageBreakdown', undefined, { groupBy, ...usageQuery(f) }),
    usageSeries: (interval, f) => call('usageSeries', undefined, { interval, ...usageQuery(f) }),

    listFiles: (employeeId, dir) => call('listFiles', { employeeId }, { dir }),
    readFile: (employeeId, path) => call('readFile', { employeeId }, { path }),
    writeFile: (employeeId, path, content, version) => call('writeFile', { employeeId }, { path }, { content, version }),

    secrets: () => call('listSecrets'),
    putSecret: (name, value, scope) => call('putSecret', undefined, undefined, { name, value, scope }),
    deleteSecret: (name, scope) => call('deleteSecret', undefined, { name, scopeType: scope.type, scopeId: scope.id }),

    control: () => call('control'),
    pauseAll: () => call('pauseAll', undefined, undefined, {}),
    resumeAll: () => call('resumeAll', undefined, undefined, {}),
    health: () => call('health'),
    ready: () => call('ready'),
  }
}

/** Convenience: the run states that count as "live" on the Now page. */
export const LIVE_RUN_STATES: readonly RunState[] = ['queued', 'running', 'suspended', 'paused']
