/**
 * Resource shapes returned by the HTTP API. They are plain JSON: timestamps
 * are ISO 8601 strings, ids are prefixed and sortable (`ses_01J…`).
 *
 * The API is generic at its core: every thing is a record (`ApiRecord`) of a
 * kind with a schema (`ApiKindSchema`), records are connected by links
 * (`ApiLink`), and session history is a tree of entries (`ApiEntry`). The
 * typed `…Data` interfaces below describe the `data` of the kinds the UI
 * knows about. Unknown fields (schema extensions) are allowed everywhere.
 */

/** Any JSON value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

// ─── Generic records ────────────────────────────────────────────────────────

/** A reference to a record. */
export interface ApiRef {
  kind: string
  id: string
}

/** Who made a change. */
export interface ApiActor {
  type: 'contact' | 'session' | 'system'
  id: string
}

/** A stored record of any kind. `version` starts at 1 and is used for compare-and-swap updates. */
export interface ApiRecord<T = Record<string, unknown>> {
  kind: string
  id: string
  version: number
  /** Optional unique key within the kind, e.g. a session's `employeeId:slug` or an event's dedupe key. */
  key: string | null
  data: T
  createdAt: string
  updatedAt: string
}

/** A link between two records, with a role (`owner`, `works_on`, `mentions`, …) and extra fields. */
export interface ApiLink<T = Record<string, unknown>> {
  id: string
  from: ApiRef
  to: ApiRef
  role: string
  data: T
  createdAt: string
}

/** A link together with the record at its other end. */
export interface ApiLinkedRecord<T = Record<string, unknown>> {
  link: ApiLink
  record: ApiRecord<T>
}

/** One version of a record. `data` is null for a deletion. */
export interface ApiRevision<T = Record<string, unknown>> {
  kind: string
  id: string
  version: number
  op: 'create' | 'update' | 'delete'
  data: T | null
  actor: ApiActor
  at: string
}

/** A page of results. `total` counts all matches, ignoring `limit` and `offset`. */
export interface Page<T> {
  items: T[]
  total: number
}

// ─── Schemas ────────────────────────────────────────────────────────────────

export type ApiFieldType = 'string' | 'text' | 'number' | 'boolean' | 'timestamp' | 'json' | 'ref' | 'list' | 'object' | 'enum'

/** One field of a kind's schema. Mirrors `FieldDef` in @mp/core. */
export interface ApiFieldDef {
  name: string
  type: ApiFieldType
  description?: string
  required?: boolean
  /** For `ref`: the kind(s) it may point to. */
  ref?: string | string[]
  /** For `list`: the item type. */
  of?: Omit<ApiFieldDef, 'name'>
  /** For `object`: its fields. */
  fields?: ApiFieldDef[]
  /** For `enum`: the allowed values. */
  values?: string[]
}

/** A record kind: core fields (fixed by the harness) and extension fields (added by the deployment). */
export interface ApiKindSchema {
  kind: string
  /** Id prefix, e.g. `con` for contacts. */
  prefix: string
  description?: string
  core: ApiFieldDef[]
  extensions?: ApiFieldDef[]
  /** The field used as the record's title in lists. */
  titleField?: string
}

// ─── Entries (session history) ──────────────────────────────────────────────

export type EntryKind = 'system' | 'user' | 'assistant' | 'tool_result' | 'event' | 'summary' | 'pointer'

/**
 * One item of session history. Entries form an append-only tree: `parent` is
 * the previous entry. `meta` carries `runId`, `usage` and similar.
 */
export interface ApiEntry<C = Json> {
  id: string
  parent: string | null
  kind: EntryKind | (string & {})
  content: C
  /** sha256 of the canonical content. */
  hash: string
  meta: Record<string, Json>
  createdAt: string
}

/** Entry content per kind (mirrors @mp/sessions). */
export interface TextContent {
  text: string
}
export interface AssistantContent {
  text: string | null
  reasoning?: string
  toolCalls?: { id: string; name: string; arguments: string }[]
}
export interface ToolResultContent {
  toolCallId: string
  name: string
  output: Json
  isError?: boolean
}
export interface EventEntryContent {
  eventId: string
  source: string
  type: string
  text: string
  trusted: boolean
  expectedToAct: boolean
}
export interface SummaryContent {
  text: string
  /** The entry the branch was rewound to. */
  rewoundTo: string
  /** The last entry of the branch the summary stands for. */
  replacesTip: string
}
export interface PointerContent {
  text: string
  /** The offloaded entry. */
  original: string
  doc?: { id: string; chapter?: string }
}

/** Token counts of one model call, as stored in `entry.meta.usage`. */
export interface TokenUsage {
  input: number
  output: number
  cached: number
  reasoning?: number
}

// ─── Employees and directory ────────────────────────────────────────────────

/** Kind `employee`: an AI employee, a workspace with its own identity and scope. */
export interface EmployeeData extends Record<string, unknown> {
  name: string
  /** The employee's own contact record. */
  contactId?: string
  /** Short description of the slice of the company it covers. */
  scope?: string
  /** Plain-words personality: quirks, sign-off, tone. */
  personality?: string
  /** Tool allow and deny lists (names or patterns like `mcp.linear.*`). The deny list wins. */
  tools: { allow: string[]; deny: string[] }
  /** The same lists as stored by the server's directory (`tools` is the older shape). */
  toolAllow?: string[]
  toolDeny?: string[]
  model?: string
  /** The employee's router session, for input nothing else claims. */
  routerSessionId?: string
  paused?: boolean
}

/** Kind `contact`. */
export interface ContactData extends Record<string, unknown> {
  name: string
  /** `ai` for AI employees' contact records. */
  kind?: 'person' | 'ai'
  handles?: { system: string; id: string }[]
  role?: string
  team?: string
  manager?: string
  permissions?: string
  /** True for AI employees' contact records (older shape of `kind: 'ai'`). */
  ai?: boolean
  email?: string
}

/** Kind `project`. */
export interface ProjectData extends Record<string, unknown> {
  name: string
  aliases?: string[]
  description: string
  status: string
  owner?: string
  repositories?: { url: string; defaultBranch?: string; path?: string }[]
  links?: { system: string; ref: string }[]
  document?: string
}

/** Kind `procedure`. */
export interface ProcedureData extends Record<string, unknown> {
  name: string
  applies: string
  owner?: string
  approvals?: string[]
  /** The procedure context (a session id). */
  context?: string
  document?: string
}

/** Kind `skill`. */
export interface SkillData extends Record<string, unknown> {
  name: string
  description: string
  body: string
  /** `company` or a project id. */
  scope: string
}

/** Kind `memory`. */
export interface MemoryData extends Record<string, unknown> {
  summary: string
  kind: string
  content: string
  source?: { sessionId?: string; contactId?: string }
  verified?: string
  scope?: string
}

/** Kind `limit`: a set of limits for a scope (deployment, employee, template, procedure or session). */
export interface LimitData extends Record<string, unknown> {
  name?: string
  scope: { type: 'deployment' | 'employee' | 'template' | 'procedure' | 'session'; id?: string }
  forkDepth?: number
  fanOut?: number
  concurrentSessions?: number
  tokensPerRun?: number
  tokensPerSession?: number
  tokensPerTree?: number
  tokensPerEmployeePerDay?: number
  costPerDay?: number
  wallClockPerRunSec?: number
  aiToAiStreak?: number
}

// ─── Sessions and runs ──────────────────────────────────────────────────────

export type SessionStatus = 'active' | 'waiting' | 'done' | 'abandoned'
export type RunMode = 'continuing' | 'ephemeral'
export type RunState = 'queued' | 'running' | 'suspended' | 'paused' | 'completed' | 'failed' | 'cancelled'

export const RUN_STATES: readonly RunState[] = ['queued', 'running', 'suspended', 'paused', 'completed', 'failed', 'cancelled']
export const TERMINAL_RUN_STATES: readonly RunState[] = ['completed', 'failed', 'cancelled']

/** Kind `session`. */
export interface SessionData extends Record<string, unknown> {
  title: string
  /** Unique per employee, addressable as `@employee#slug`. */
  slug: string
  employeeId: string
  status: SessionStatus
  /** Last committed entry. */
  head: string | null
  /** Root of the fork tree (itself for a root). */
  rootId: string
  parent?: { sessionId: string; entryId: string | null }
  depth: number
  template?: { id: string; version: number }
  toolset: string[]
  model?: string
  /** The session's markdown document. */
  document: string
  defaultRunMode?: RunMode
  /** Free-form metadata. `meta.loop` = `{ index, of, item }` for loop children. */
  meta?: Record<string, Json>
}
export type Session = ApiRecord<SessionData>

export type WaitCondition =
  | { type: 'runs'; runIds: string[]; mode: 'all' | 'any'; timeoutAt?: string }
  | { type: 'delivery'; timeoutAt?: string }
  | { type: 'timer'; until: string }

export interface RunResult {
  status: 'completed' | 'failed' | 'cancelled'
  output?: string
  error?: string
}

/** Kind `run`. */
export interface RunData extends Record<string, unknown> {
  sessionId: string
  employeeId: string
  rootSessionId: string
  mode: RunMode
  state: RunState
  base: string | null
  tip: string | null
  cause: { type: 'event' | 'fork' | 'loop' | 'manual' | 'wake'; eventId?: string; parentRunId?: string; note?: string }
  requesterId?: string
  priority: number
  wait?: WaitCondition
  commit?: boolean
  commitSummary?: string
  steps: number
  pauseReason?: string
  result?: RunResult
  startedAt?: string
  endedAt?: string
}
export type Run = ApiRecord<RunData>

/** Token totals, with cost in USD. */
export interface TokenTotals {
  input: number
  output: number
  cached: number
  reasoning: number
  /** input + output. */
  total: number
  cost: number
  /** Number of model calls. */
  calls: number
}

// ─── Checklists ─────────────────────────────────────────────────────────────

export interface ChecklistItem {
  id: string
  text: string
  required: boolean
  checked: boolean
  /** Entry ids the check was based on. */
  evidence?: string[]
  checkedAt?: string
  /** Fresh-context review, when the item needs one. */
  review?: { state: 'requested' | 'passed' | 'failed'; reviewerSessionId?: string; note?: string }
}

/** Kind `checklist`, one per session. */
export interface ChecklistData extends Record<string, unknown> {
  sessionId: string
  items: ChecklistItem[]
}
export type Checklist = ApiRecord<ChecklistData>

// ─── Session views ──────────────────────────────────────────────────────────

/** A compact view of an employee, embedded in other responses. */
export interface EmployeeSummary {
  id: string
  name: string
}

/** A session row in lists, with the facts a list needs. */
export interface SessionListItem {
  session: Session
  employee: EmployeeSummary
  /** State of the latest run, if any. */
  runState: RunState | null
  tokens: TokenTotals
  /** Number of direct children. */
  children: number
  checklist?: { done: number; total: number }
}

/** `GET /api/sessions/:id`. */
export interface SessionDetail {
  session: Session
  employee: EmployeeSummary
  checklist: Checklist | null
  /** The non-terminal run (continuing first), if any. */
  activeRun: Run | null
  /** Links to contacts, projects and other sessions. */
  links: ApiLinkedRecord[]
  tokens: TokenTotals
  /** Chat threads linked to this session. */
  threads: { channelId: string; threadId: string; title: string }[]
}

/** How a session came to be, relative to its parent. */
export type SessionOrigin = 'root' | 'fork' | 'loop'

/** A node of the fork tree (`GET /api/sessions/:id/tree`). */
export interface SessionTreeNode {
  id: string
  title: string
  slug: string
  status: SessionStatus
  employee: EmployeeSummary
  origin: SessionOrigin
  /** For loop children: position and size of the loop. */
  loop?: { index: number; of: number }
  /** State of the latest run. */
  runState: RunState | null
  tokens: number
  createdAt: string
  children: SessionTreeNode[]
}

/** `GET /api/sessions/:id/entry-tree`: every entry reachable in the session, including run branches. */
export interface EntryTree {
  sessionId: string
  head: string | null
  entries: ApiEntry[]
  /** Runs of the session, to label branches. */
  runs: { id: string; mode: RunMode; state: RunState; base: string | null; tip: string | null }[]
}

// ─── Now ────────────────────────────────────────────────────────────────────

/** A live run as shown on the Now page (`GET /api/now`). */
export interface NowItem {
  run: Run
  session: Session
  employee: EmployeeSummary
  /** What the run is doing right now. */
  step: { kind: 'model' | 'tool' | 'waiting' | 'queued' | 'paused'; label: string; since: string }
  /** For suspended runs: what they wait on. */
  waitingOn?: { type: 'children' | 'person' | 'container' | 'timer' | 'delivery'; label: string; refs?: ApiRef[] }
  tokens: TokenTotals
  checklist?: { done: number; total: number }
  /** The latest tool calls, newest last. */
  recentTools: { name: string; isError?: boolean; at: string }[]
  /** Model output streamed so far in the current step. */
  streaming?: { content: string; reasoning: string }
}

export interface NowSnapshot {
  items: NowItem[]
  /** Global pause (kill switch). */
  paused: boolean
  counts: Record<RunState, number>
}

// ─── Events, triggers, subscriptions ────────────────────────────────────────

/** Which routing rule delivered an event (see docs/execution.md#routing). */
export type RoutingRule = 'session_tag' | 'subscription' | 'employee_tag' | 'trigger' | 'fallback'

/** What an event is about, in the outside system or the harness. */
export interface EventSubject {
  /** e.g. `linear`, `slack`, `chat`, `github`, `session`. */
  system: string
  /** The thing's id in that system, e.g. `PAY-123` or a thread id. */
  ref: string
  title?: string
}

/** Kind `event`: an input from outside or a lifecycle event, stored before anything acts on it. */
export interface EventData extends Record<string, unknown> {
  /** e.g. `mcp:linear`, `mcp:slack`, `chat`, `timer`, `ui`, `git`, `run`, `webhook`. */
  source: string
  /** e.g. `task.assigned`, `message.posted`, `run.completed`. */
  type: string
  dedupeKey: string
  subject?: EventSubject
  /** The contact who caused it, if known. */
  actorId?: string
  /** Raw content, untrusted. */
  payload: Json
  receivedAt: string
  /** False until the router handled it. */
  routed: boolean
  /**
   * The rules that matched. Empty after routing means nothing matched: it went to a
   * router session (`deliveries` > 0) or nowhere at all (`deliveries` = 0).
   */
  matched?: RoutingRule[]
  /**
   * Number of sessions it was delivered to, once routed. 0 means it went nowhere,
   * e.g. a session's own message, which the router never delivers back to it.
   */
  deliveries?: number
}
export type ApiEvent = ApiRecord<EventData>

/** Kind `delivery`: an event handed to one session. */
export interface DeliveryData extends Record<string, unknown> {
  eventId: string
  sessionId: string
  rule: RoutingRule
  triggerId?: string
  subscriptionId?: string
  expectedToAct: boolean
  /** The run it started, or the run whose inbox it went into. */
  runId?: string
  inbox: boolean
}
export type Delivery = ApiRecord<DeliveryData>

/** `GET /api/events/:id`. */
export interface EventDetail {
  event: ApiEvent
  deliveries: Delivery[]
  runs: Run[]
}

/** Kind `trigger`: routes new events of a source and type into a context. */
export interface TriggerData extends Record<string, unknown> {
  name: string
  employeeId: string
  source: string
  type: string
  /** Field filters on the event, e.g. `{ "subject.system": "linear", "payload.team": "PAY" }`. */
  filters?: Record<string, Json>
  /** The context (session) that handles matching events. */
  contextId: string
  /** Forks the context per event instead of running in it (procedure contexts). */
  fork?: boolean
  mode?: RunMode
  enabled: boolean
}
export type Trigger = ApiRecord<TriggerData>

/** `GET /api/triggers`: a trigger with its statistics. */
export interface TriggerStats {
  trigger: Trigger
  context: { id: string; title: string; slug: string } | null
  employee: EmployeeSummary
  fires: number
  lastFiredAt: string | null
  /** The latest events it matched, newest first. */
  recentEvents: {
    id: string
    type: string
    subject?: EventSubject
    receivedAt: string /** The event's text, shortened. */
    text?: string
  }[]
}

/** Kind `subscription`: delivers events about one thing straight to a session. */
export interface SubscriptionData extends Record<string, unknown> {
  sessionId: string
  subject: EventSubject
  /** Expected to act on untagged events. */
  primary: boolean
  active: boolean
  fires?: number
}
export type Subscription = ApiRecord<SubscriptionData>

// ─── Lineage ────────────────────────────────────────────────────────────────

export type LineageNodeType = 'event' | 'trigger' | 'subscription' | 'delivery' | 'session' | 'run'

export interface LineageNode {
  id: string
  type: LineageNodeType
  label: string
  /** Secondary text, e.g. `mcp:linear · task.assigned` or a slug. */
  detail?: string
  /** Run state, or session status. */
  status?: RunState | SessionStatus
  at?: string
}

export type LineageEdgeType =
  /** event → delivery, and trigger / subscription → delivery: what matched the event */
  | 'matched'
  /** delivery → the run it started or fed (its inbox), or the session when no run was involved */
  | 'delivered'
  /** run → session it forked */
  | 'forked'
  /** run → loop child session */
  | 'looped'
  /** run → event it emitted (e.g. run.completed, which may wake a parent) */
  | 'emitted'
  /** session → one of its runs */
  | 'ran'

export interface LineageEdge {
  from: string
  to: string
  type: LineageEdgeType
}

/**
 * `GET /api/lineage/:id`: the graph around one event, session or run.
 * Each delivery is its own node (labelled with its trigger or subscription),
 * so a trigger that fired many times doesn't merge unrelated chains:
 * event → delivery ← trigger, delivery → run ← session, run → forked session,
 * run → emitted event.
 * `upstream` edges lead to the focus (its origins), `downstream` edges lead
 * away from it (everything it caused). Both are directed from cause to effect.
 */
export interface LineageGraph {
  focus: string
  nodes: LineageNode[]
  edges: LineageEdge[]
}

// ─── Chat ───────────────────────────────────────────────────────────────────

export interface ChatMember {
  type: 'employee' | 'session' | 'person'
  id: string
  /** Display name, e.g. `Billing Bot`, `@billing-bot#pay-123-refund`, `Ana`. */
  label: string
}

/** Kind `channel`. DMs are channels with `dm: true`. */
export interface ChannelData extends Record<string, unknown> {
  name: string
  topic?: string
  dm?: boolean
  archived: boolean
  /** The context a new top-level message is routed to (through a trigger). */
  contextId?: string
  createdBy: ApiActor
  members: ChatMember[]
}
export type Channel = ApiRecord<ChannelData>

/** A tag in a message: who is expected to act. */
export interface ChatTag {
  type: 'employee' | 'session' | 'person'
  id: string
  /** As written, e.g. `@billing-bot#pay-123-refund`. */
  text: string
}

/** Kind `message`. */
export interface MessageData extends Record<string, unknown> {
  channelId: string
  /** Id of the thread's root message; null for a top-level message. */
  threadId: string | null
  author: { type: 'employee' | 'session' | 'person'; id: string; name: string }
  /** Markdown. May contain `[[kind:id]]` links and tags. */
  text: string
  tags: ChatTag[]
  /** Records mentioned by id. */
  mentions: ApiRef[]
  /** For top-level messages: the thread summary. */
  replyCount?: number
  lastReplyAt?: string
  /** The session handling the thread, if any. */
  sessionId?: string
  /** When the author last edited it. */
  editedAt?: string
  /** Deleted by its author: the text is empty and a placeholder stays in the thread. */
  deleted?: boolean
  /** Emoji → who reacted with it (`contact`, `session` or `employee` refs). */
  reactions?: Record<string, ApiRef[]>
}
export type Message = ApiRecord<MessageData>

/** `GET /api/chat/channels`: a channel with unread and activity facts. */
export interface ChannelSummary {
  channel: Channel
  lastMessageAt: string | null
  messages: number
}

/** `GET /api/chat/unread`: unread state of one channel for the current person. */
export interface ChannelUnread {
  channelId: string
  /** Messages (top-level and replies) by others since the read marker. */
  unread: number
  /** Of those, messages that tag you. */
  mentions: number
  lastReadAt: string | null
}

/** One hit of `GET /api/chat/search`. */
export interface ChatSearchResult {
  message: Message
  channel: { id: string; name: string; dm: boolean }
  /** The thread it's in (its root's id; the message's own id for a top-level message). */
  threadId: string
}

/** `GET /api/me`: who the web UI acts as. */
export interface Me {
  contactId: string
  name: string
}

/** `GET /api/chat/threads/:id`. */
export interface ChatThread {
  root: Message
  replies: Message[]
  /** Sessions subscribed to the thread. */
  sessions: { id: string; slug: string; title: string; employee: EmployeeSummary }[]
}

// ─── Inbox ──────────────────────────────────────────────────────────────────

/** `GET /api/inbox`: things that need a person. */
export interface InboxItem {
  id: string
  type: 'mention' | 'approval' | 'paused_run' | 'review' | 'limit'
  title: string
  /** One line of context. */
  detail?: string
  at: string
  read: boolean
  sessionId?: string
  runId?: string
  channelId?: string
  threadId?: string
  employee?: EmployeeSummary
}

// ─── Usage ──────────────────────────────────────────────────────────────────

/** Kind `usage`: one model call. */
export interface UsageData extends Record<string, unknown> {
  runId: string
  sessionId: string
  rootSessionId: string
  employeeId: string
  projectId?: string
  requesterId?: string
  templateId?: string
  model: string
  /** The tool call that followed, if the step is attributed to a tool. */
  tool?: string
  input: number
  output: number
  cached: number
  reasoning?: number
  cost: number
  at: string
}

export type UsageGroupBy =
  | 'employee'
  | 'model'
  | 'session'
  | 'tree'
  | 'project'
  | 'contact'
  | 'template'
  | 'tool'
  | 'day'
  | 'hour'

/** Filters shared by the usage endpoints. All optional. */
export interface UsageFilter {
  /** One run's model calls. */
  runId?: string
  employeeId?: string
  sessionId?: string
  rootSessionId?: string
  projectId?: string
  requesterId?: string
  templateId?: string
  model?: string
  /** ISO timestamp, inclusive. */
  since?: string
  /** ISO timestamp, exclusive. */
  until?: string
}

export interface UsageRow extends TokenTotals {
  key: string
  label: string
}

/** `GET /api/usage/breakdown`: rows sorted by total tokens, largest first (time groupings: oldest first). */
export interface UsageBreakdown {
  groupBy: UsageGroupBy
  rows: UsageRow[]
}

/** `GET /api/usage/series`: token use over time, optionally split by a dimension. */
export interface UsageSeries {
  interval: 'hour' | 'day'
  splitBy?: UsageGroupBy
  /** Series keys and labels, in legend order. */
  keys: { key: string; label: string }[]
  /** One point per bucket: `{ t, [key]: tokens }`. */
  points: ({ t: string } & Record<string, number | string>)[]
}

// ─── Files ──────────────────────────────────────────────────────────────────

export interface FileEntry {
  /** Absolute within the employee's filesystem, e.g. `/notes/pay-123.md`. */
  path: string
  name: string
  type: 'file' | 'dir'
  size: number
  updatedAt: string
  /** For entries under `/shared`. */
  shared?: { ownerEmployeeId: string; permission: 'read' | 'write' }
}

export interface FileContent {
  path: string
  content: string
  version: number
  updatedAt: string
}

// ─── Secrets ────────────────────────────────────────────────────────────────

export interface SecretScope {
  type: 'global' | 'employee' | 'project' | 'tool'
  /** Employee, project or tool id; absent for `global`. */
  id?: string
}

/** A secret without its value. Values can be written but never read back. */
export interface SecretInfo {
  name: string
  scope: SecretScope
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
  uses?: number
}

// ─── Control and health ─────────────────────────────────────────────────────

export interface ControlState {
  /** The global pause flag (kill switch). */
  paused: boolean
  pausedAt?: string
  pausedBy?: ApiActor
}

export interface Health {
  ok: boolean
  /** For `/readyz`: individual checks, e.g. `{ database: true, queue: true, migrations: true }`. */
  checks?: Record<string, boolean>
  version?: string
}
