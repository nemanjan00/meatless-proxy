/**
 * The sessions contract. Other packages (tools, checklists, router, runner,
 * stdlib, server) code against these types. See docs/execution.md for the
 * design: history is an append-only tree of entries, a session is a pointer
 * (`head`) into it, and a run is one piece of work in a session.
 */
import type { Json } from '@mp/core'
import type { Actor, Entry, Ref, StoredRecord } from '@mp/store'

// ─── Entries ────────────────────────────────────────────────────────────────

export type EntryKind =
  | 'system' // instructions, identity, loaded context
  | 'user' // input addressed to the model
  | 'assistant' // model output, possibly with tool calls
  | 'tool_result' // result of one tool call
  | 'event' // an event delivered to the session (untrusted content is marked in meta)
  | 'summary' // stands for a branch that was rewound (meta.replaces: entry ids)
  | 'pointer' // stands for an offloaded entry (meta.original: entry id)

/** What entry content looks like, per kind. Stored as JSON. */
export interface SystemContent {
  text: string
}
export interface UserContent {
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
  /**
   * Images the tool returned, as references (`ImageRef` of `@mp/model`: source, id or owner and path,
   * sha256, name, mime, size), never their bytes. The runner loads the bytes when it builds a request.
   */
  images?: Json[]
}
export interface EventContent {
  eventId: string
  source: string
  type: string
  /** Rendered text of the event for the model. */
  text: string
  /** False for anything that came from outside and wasn't expected. */
  trusted: boolean
  expectedToAct: boolean
}
export interface SummaryContent {
  text: string
  /** The entry this summary's branch was rewound to. */
  rewoundTo: string
  /** The last entry of the branch the summary stands for. */
  replacesTip: string
}
export interface PointerContent {
  text: string
  /** The entry that was offloaded. */
  original: string
  doc?: { id: string; chapter?: string }
  /**
   * When the offloaded entry was a tool result: its call id and tool name. The pointer then answers that call
   * (it's rendered as the call's tool message), so the assistant entry's calls stay paired with results.
   */
  toolCallId?: string
  toolName?: string
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export type SessionStatus = 'active' | 'waiting' | 'done' | 'abandoned'

export interface SessionData extends Record<string, unknown> {
  title: string
  /** Unique per employee, for `@employee#slug`. Also the record key `${employeeId}:${slug}`. */
  slug: string
  employeeId: string
  status: SessionStatus
  /** Last committed entry. null only for a session with no history yet. */
  head: string | null
  /** Root session of the fork tree (itself for a root). */
  rootId: string
  /** Where it was forked from. */
  parent?: { sessionId: string; entryId: string | null }
  /** 0 for a root session, parent's depth + 1 for a fork. */
  depth: number
  template?: { id: string; version: number }
  /** Tool names available in this session. Fixed at creation (keeps the cached prefix stable). */
  toolset: string[]
  /** Model override. */
  model?: string
  /** The session's markdown document: purpose, what was done, decisions, open items. */
  document: string
  /** Default mode for runs started by deliveries to this session. */
  defaultRunMode?: RunMode
  /** Free-form metadata; extension fields go here or at the top level via schema extension. */
  meta?: Record<string, Json>
}

export type Session = StoredRecord<SessionData>

export interface CreateSessionInput {
  employeeId: string
  title: string
  /** Generated from the title when missing. Made unique per employee. */
  slug?: string
  toolset?: string[]
  model?: string
  document?: string
  defaultRunMode?: RunMode
  /** Initial history, appended in order (e.g. the system prompt). */
  entries?: { kind: EntryKind; content: Json; meta?: Record<string, Json> }[]
  /** Links to create, e.g. `{ ref: project, role: 'works_on' }`. */
  links?: { ref: Ref; role: string }[]
  meta?: Record<string, Json>
  actor?: Actor
}

// ─── Runs ───────────────────────────────────────────────────────────────────

export type RunMode = 'continuing' | 'ephemeral'

export type RunState = 'queued' | 'running' | 'suspended' | 'paused' | 'completed' | 'failed' | 'cancelled'

export const TERMINAL_RUN_STATES: readonly RunState[] = ['completed', 'failed', 'cancelled']

/** Allowed transitions. Anything else throws `ConflictError`. */
export const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ['running', 'paused', 'cancelled'],
  running: ['suspended', 'paused', 'completed', 'failed', 'cancelled', 'queued'],
  suspended: ['queued', 'paused', 'cancelled', 'failed'],
  paused: ['queued', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

export type WaitCondition =
  /** Wait for other runs to reach a terminal state. */
  | { type: 'runs'; runIds: string[]; mode: 'all' | 'any'; timeoutAt?: string }
  /** Wait for any delivery to this session (a reply, an approval, a subscribed event). */
  | { type: 'delivery'; timeoutAt?: string }
  /** Wait until a time. */
  | { type: 'timer'; until: string }

export interface RunResult {
  status: 'completed' | 'failed' | 'cancelled'
  /** Final assistant text, if any. */
  output?: string
  error?: string
}

export interface RunData extends Record<string, unknown> {
  sessionId: string
  employeeId: string
  rootSessionId: string
  mode: RunMode
  state: RunState
  /** The session's head when the run started. */
  base: string | null
  /** The run's latest entry (null until it appends one). */
  tip: string | null
  /** What started it. */
  cause: { type: 'event' | 'fork' | 'loop' | 'manual' | 'wake'; eventId?: string; parentRunId?: string; note?: string }
  /** The contact the work is for, if known. */
  requesterId?: string
  /** Higher runs first. */
  priority: number
  wait?: WaitCondition
  /** Set by the `commit` tool in an ephemeral run, or false to discard a continuing run. */
  commit?: boolean
  /** Commit as this summary instead of the full history. */
  commitSummary?: string
  /** Number of model calls so far. */
  steps: number
  pauseReason?: string
  result?: RunResult
  startedAt?: string
  endedAt?: string
  /** When it last started working (queued → running); with `activeMs`, its wall clock. */
  runningSince?: string
  /** Time spent working before `runningSince` (waits, pauses and time in the queue don't count). */
  activeMs?: number
  /** Set by the runner when it paused the run for its step or wall-clock limit; resuming gives a fresh allowance. */
  limitPaused?: 'steps' | 'wall'
  /** Steps taken before the latest resume after a step-limit pause. */
  stepsFrom?: number
  /** Set once the run was committed to its session: in full (head moved to the tip) or as a summary entry. */
  committed?: { as: 'full' | 'summary'; at: string; entryId: string | null }
  /** The size of the run's context at its latest model call (set by the runner). */
  context?: RunContextSize
}

/** How full a run's context was at its latest model call. */
export interface RunContextSize {
  /** Prompt tokens of the latest model call, as the provider counted them. */
  tokens: number
  /** The model's context window. */
  window: number
  /** Characters of that request (messages and tools), to estimate the next request's tokens from its characters. */
  chars: number
  model: string
  at: string
  /** The highest context threshold (percent) the model was told about since the context last fell below it. */
  noted?: number
}

export type Run = StoredRecord<RunData>

export interface CreateRunInput {
  sessionId: string
  mode?: RunMode
  cause: RunData['cause']
  requesterId?: string
  priority?: number
  /** Entries to add on top of the base before the run starts (e.g. the loop item). */
  input?: { kind: EntryKind; content: Json; meta?: Record<string, Json> }[]
  actor?: Actor
}

// ─── Inbox ──────────────────────────────────────────────────────────────────

/** A delivery waiting for a session's continuing run to pick it up at the next step. */
export interface InboxItemData extends Record<string, unknown> {
  sessionId: string
  eventId: string
  expectedToAct: boolean
  trusted: boolean
  /** Rendered text for the model. */
  text: string
  source: string
  type: string
  consumed: boolean
  consumedByRun?: string
}

export type InboxItem = StoredRecord<InboxItemData>

// ─── Templates ──────────────────────────────────────────────────────────────

export interface TemplateData extends Record<string, unknown> {
  name: string
  description?: string
  /** Initial instructions, with `{{param}}` placeholders. */
  instructions: string
  params?: { name: string; description?: string; required?: boolean }[]
  toolset?: string[]
  defaultRunMode?: RunMode
  checklist?: { text: string; required?: boolean; review?: boolean }[]
  links?: { ref: Ref; role: string }[]
  document?: string
}

export type Template = StoredRecord<TemplateData>

// ─── Tree ───────────────────────────────────────────────────────────────────

export interface TreeNode {
  session: Session
  children: TreeNode[]
}

// ─── Waiting and search results ─────────────────────────────────────────────

/** One awaited run, as returned by `waitResults`. `done` is false for runs that hadn't finished (e.g. on timeout). */
export interface WaitResult {
  runId: string
  sessionId: string
  state: RunState
  result?: RunResult
  document: string
  done: boolean
}

export interface SearchQuery {
  text: string
  employeeId?: string
  /** Only entries written in these sessions (entries inherited from a parent belong to the parent). */
  sessionIds?: string[]
  kinds?: EntryKind[]
  limit?: number
  offset?: number
}

export interface SearchHit {
  entry: Entry
  /** The session the entry was written in (`meta.sessionId`). */
  sessionId: string
  session: Session | null
  /** About 160 characters of the entry's text around the first match. */
  snippet: string
}

// ─── Bus topics ─────────────────────────────────────────────────────────────

export const SessionTopics = {
  runState: 'run.state',
  sessionHead: 'session.head',
  sessionCreated: 'session.created',
  inboxAdded: 'inbox.added',
} as const

export interface RunStateChanged {
  runId: string
  sessionId: string
  employeeId: string
  from: RunState
  to: RunState
}

export interface SessionHeadChanged {
  sessionId: string
  from: string | null
  to: string | null
  runId?: string
}

// ─── Service ────────────────────────────────────────────────────────────────

/** What `Sessions.query` filters and sorts by. */
export interface SessionQuery {
  employeeId?: string
  status?: SessionStatus | SessionStatus[]
  rootId?: string
  text?: string
  /** Only these sessions (an empty list matches nothing). */
  ids?: string[]
  /** Leave out sessions whose `meta.role` is one of these (e.g. `router-retired`). Sessions without a role stay. */
  excludeRoles?: string[]
  /** Default: newest first (`createdAt` desc). Ties break on id, so paging is stable. */
  orderBy?: { field: 'createdAt' | 'updatedAt' | 'title'; dir?: 'asc' | 'desc' }
  limit?: number
  offset?: number
}

export interface Sessions {
  // sessions
  create(input: CreateSessionInput): Promise<Session>
  get(id: string): Promise<Session | null>
  require(id: string): Promise<Session>
  bySlug(employeeId: string, slug: string): Promise<Session | null>
  query(q: SessionQuery): Promise<{ items: Session[]; total: number }>
  update(
    id: string,
    patch: Partial<Pick<SessionData, 'title' | 'status' | 'document' | 'meta' | 'model' | 'toolset'>>,
    actor?: Actor,
  ): Promise<Session>
  /** The session's committed history, root to head. */
  history(sessionId: string): Promise<Entry[]>
  /** The tree the session belongs to, from its root. */
  tree(sessionId: string): Promise<TreeNode>
  children(sessionId: string): Promise<Session[]>

  /** A new session starting from `atEntry` (default: the parent's head). The parent is untouched. */
  fork(
    sessionId: string,
    opts?: { atEntry?: string | null; title?: string; slug?: string; toolset?: string[]; actor?: Actor },
  ): Promise<Session>
  /** One fork per item, each with a `user` entry describing its item on top of the fork point. */
  loop(
    sessionId: string,
    items: Json[],
    opts?: { atEntry?: string | null; titlePrefix?: string; render?: (item: Json, index: number) => string; actor?: Actor },
  ): Promise<Session[]>

  /**
   * Full-text search over entry content, newest first. Each entry is attributed
   * to the session it was written in (`meta.sessionId`), so history a fork
   * inherited is found under its parent. Session titles and documents are
   * searched by `searchSessions`.
   */
  search(q: SearchQuery): Promise<{ items: SearchHit[]; total: number }>
  /** Sessions whose title, document or other data contain `text` (same as `query({ text })`). */
  searchSessions(
    text: string,
    opts?: { employeeId?: string; limit?: number; offset?: number },
  ): Promise<{ items: Session[]; total: number }>

  // runs
  createRun(input: CreateRunInput): Promise<Run>
  getRun(id: string): Promise<Run | null>
  requireRun(id: string): Promise<Run>
  runs(q: {
    sessionId?: string
    state?: RunState | RunState[]
    employeeId?: string
    rootSessionId?: string
    limit?: number
  }): Promise<Run[]>
  /** The non-terminal continuing run of a session, if any (there is at most one). */
  activeContinuingRun(sessionId: string): Promise<Run | null>
  /**
   * Moves a run to `to`, only if its current state is one of `from` (and the
   * move is allowed by RUN_TRANSITIONS). Compare-and-swap: of several callers
   * racing, one wins, the others get `ConflictError`.
   */
  transition(runId: string, from: RunState | RunState[], to: RunState, patch?: Partial<RunData>): Promise<Run>
  /** Updates non-state fields of a run (steps, commit flags, …). */
  updateRun(runId: string, patch: Partial<Omit<RunData, 'state'>>): Promise<Run>
  /** The run's history: session history up to `base`, then the run's own entries up to `tip`. */
  runHistory(runId: string): Promise<Entry[]>
  /** Appends an entry on top of the run's tip (or base) and moves the tip. */
  append(runId: string, entry: { kind: EntryKind; content: Json; meta?: Record<string, Json> }): Promise<Entry>

  /**
   * Moves the session's head from the run's base to its tip. If the head moved
   * since the run started, throws `ConflictError` (the caller then commits a
   * summary with `commitSummary`).
   */
  commit(runId: string): Promise<Session>
  /** Appends a summary entry on top of the session's *current* head and moves the head to it. */
  commitSummary(runId: string, summary: string): Promise<Session>

  /** Rewind within a run: a summary entry whose parent is `toEntry` becomes the run's tip. */
  rewind(runId: string, toEntry: string, summary: string): Promise<Entry>
  /**
   * Replaces `entryId` (on the run's current path) with a pointer entry, and
   * re-creates the entries after it on top (same content). Returns the new tip.
   */
  offload(
    runId: string,
    entryId: string,
    pointer: { text: string; doc?: { id: string; chapter?: string } },
    opts?: { meta?: Record<string, Json> },
  ): Promise<Entry>
  /** Undoes an offload: the original entry goes back in place of the pointer. Returns the new tip. */
  restore(runId: string, pointerEntryId: string): Promise<Entry>
  /**
   * Real compaction: rewind to the first entry of the history with a summary of everything. With `keepFrom`
   * (an entry on the run's current path, after the first), the entries from it to the tip are re-created
   * verbatim on top of the summary: the summary stands for what lies between the first entry and `keepFrom`.
   * `meta` is added to the summary entry's meta (e.g. `automatic: true`). Returns the new tip.
   */
  compact(runId: string, summary: string, opts?: { keepFrom?: string; meta?: Record<string, Json> }): Promise<Entry>

  // waiting
  /** Suspends a running run with a wait condition. */
  suspend(runId: string, wait: WaitCondition): Promise<Run>
  /** Suspended runs whose `runs` wait mentions `runId`. */
  waitersOf(runId: string): Promise<Run[]>
  /** Whether a suspended run's wait is satisfied now (timers use the injected clock). */
  isWaitSatisfied(run: Run): Promise<boolean>
  /** Results of the runs a `runs` wait was waiting for. */
  waitResults(run: Run): Promise<WaitResult[]>

  // inbox
  addToInbox(item: Omit<InboxItemData, 'consumed' | 'consumedByRun'>): Promise<InboxItem>
  /** Unconsumed items for a session, oldest first. */
  inbox(sessionId: string): Promise<InboxItem[]>
  /** Marks items consumed by a run and returns them. */
  takeInbox(sessionId: string, runId: string): Promise<InboxItem[]>

  // templates
  createTemplate(data: TemplateData, actor?: Actor): Promise<Template>
  getTemplate(id: string): Promise<Template | null>
  templates(): Promise<Template[]>
  updateTemplate(id: string, patch: Partial<TemplateData>, actor?: Actor): Promise<Template>
  /** Creates a session from a template, filling `{{param}}` placeholders. */
  fromTemplate(
    templateId: string,
    input: {
      employeeId: string
      params?: Record<string, string>
      title?: string
      slug?: string
      actor?: Actor
      entriesBefore?: CreateSessionInput['entries']
    },
  ): Promise<Session>
}
