import type { ApiRecord, EmployeeSummary, Json, RunState } from './resources.ts'

// ─── Procedures: what they are, when they run, how their runs went ─────────
//
// Served by packages/server/src/procedures. A procedure is a record (kind `procedure`) with a
// markdown body (its steps), an owner, approvals, and a procedure context: a session that has
// read it, forked once per run. "How it starts" is the triggers that target it, described here
// in the UI's terms (`ProcedureStart`); the server turns each into a trigger and back.
// Reads are for everyone signed in; writes for members, except triggers (admins), like the
// records API.

/** Who has to say yes: a contact or a role, optionally at a step ("before issuing the refund"). */
export interface ProcedureApproval {
  contactId?: string
  role?: string
  step?: string
}

/** Kind `procedure`, as the directory stores it. */
export interface ProcedureRecordData extends Record<string, unknown> {
  name: string
  /** When it applies, in plain words: its one-line purpose. */
  applies: string
  /** The steps, markdown. */
  body?: string
  /** A contact: a person, or an AI employee's contact. */
  ownerId?: string
  approvals?: ProcedureApproval[]
  /** The procedure context (a session id). */
  contextSessionId?: string
  checklist?: { text: string; required?: boolean; review?: boolean }[]
  skills?: string[]
  projectIds?: string[]
  archived?: boolean
}

/** How a procedure starts. `manual` (Run now, or `procedures.run` from any session) is always possible and is never stored. */
export type ProcedureStartKind = 'manual' | 'channel' | 'tag' | 'schedule' | 'integration' | 'custom'

/**
 * A way a procedure starts, stored as a trigger. Every kind takes an optional `filter`: a
 * MongoDB-style query over the event (e.g. `{ "payload.labels": { "$in": ["refund"] } }`),
 * the "Advanced" part of the form.
 *
 * - `channel`: a new top-level message from a person in a harness chat channel.
 * - `tag`: a chat message that tags `@<tag>` (a name that is no employee or person).
 * - `schedule`: a cron expression, in a time zone (default: the company's).
 * - `integration`: an event from an integration (see `INTEGRATION_EVENTS`), with optional field matches.
 * - `custom`: any other source and type, e.g. an MCP server's notifications.
 */
export type ProcedureStart = (
  | { kind: 'channel'; channelId: string }
  | { kind: 'tag'; tag: string }
  | { kind: 'schedule'; cron: string; timezone?: string }
  | { kind: 'integration'; source: string; type: string; where?: Record<string, Json> }
  | { kind: 'custom'; source?: string; type?: string; where?: Record<string, Json> }
) & { filter?: Json }

/** A trigger that starts a procedure, in plain words. */
export interface ProcedureTrigger {
  id: string
  name: string
  employee: EmployeeSummary
  enabled: boolean
  start: ProcedureStart
  /** e.g. "When someone posts in #access-requests". */
  description: string
  /** The trigger's stored match and schedule, for the Advanced view. */
  raw: { match: Record<string, Json>; schedule?: { cron: string; timezone?: string } }
  fired: number
  lastFiredAt: string | null
}

/** The procedure context's state: `ready`, `stale` (built before the procedure last changed) or `missing` (not built). */
export type ProcedureContextState = 'ready' | 'stale' | 'missing'

export interface ProcedureContextInfo {
  state: ProcedureContextState
  sessionId: string | null
  slug?: string
  /** The employee whose session it is: the one that runs the procedure. */
  employee?: EmployeeSummary
  builtAt: string | null
  builtFromVersion: number | null
  /** Why it's out of date. */
  reason?: string
}

/** What started a run: a trigger, another session (`procedures.run`), a person (Run now), or an event. */
export interface ProcedureRunCause {
  type: 'trigger' | 'session' | 'person' | 'event' | 'system'
  label: string
  id?: string
}

/** One instance of a procedure: a fork of its context, and how its runs went. */
export interface ProcedureRun {
  sessionId: string
  title: string
  slug: string
  employee: EmployeeSummary
  /** The latest run. */
  runId: string | null
  state: RunState | null
  startedAt: string
  /** When the latest run ended; null while it's live. */
  endedAt: string | null
  startedBy: ProcedureRunCause
  /** The latest run's answer or error, shortened. */
  outcome?: string
  runs: number
}

/** Someone on a procedure (its owner or an approver), with their name. */
export interface ProcedurePerson {
  contactId: string
  name: string
  /** `person`, `ai` (an AI employee) or `agent`. */
  kind: 'person' | 'ai' | 'agent'
  employeeId?: string
}

/** `GET /api/procedures` rows. */
export interface ProcedureListItem {
  procedure: ApiRecord<ProcedureRecordData>
  owner: ProcedurePerson | null
  /** How it starts, from its enabled triggers; `[{ kind: 'manual' }]` when it has none. */
  starts: { kind: ProcedureStartKind; description: string }[]
  approvals: number
  /** Instances started in the last 30 days. */
  runs30d: number
  lastRun: { sessionId: string; state: RunState | null; at: string } | null
  context: ProcedureContextInfo
}

/** `GET /api/procedures/:id`. */
export interface ProcedureDetail extends ProcedureListItem {
  /** Every trigger that targets it, enabled or not. */
  triggers: ProcedureTrigger[]
  /** Approvers with names, in order. */
  approvers: (ProcedureApproval & { name?: string })[]
  /** Its instances, newest first (at most 100). */
  runs: ProcedureRun[]
}

/** `GET /api/procedures` query. */
export interface ProcedureListQuery {
  text?: string
  /** Only procedures this contact owns. */
  ownerId?: string
  /** Include archived ones. */
  archived?: boolean
}

/** `POST /api/procedures`: a procedure, how it starts and its context, in one call. */
export interface CreateProcedureBody {
  name: string
  applies: string
  body?: string
  ownerId?: string
  approvals?: ProcedureApproval[]
  projectIds?: string[]
  /** The employee that runs it: its context is built as that employee's session, and its triggers are that employee's. */
  employeeId: string
  /** Triggers to create (admins). Leave out for a manual-only procedure. */
  starts?: ProcedureStart[]
  /** Makes a retried or double-submitted create return the first one (any unique string). */
  idempotencyKey?: string
}

/** `POST /api/procedures` → 201 with the new procedure, or 200 with the existing one for a repeated `idempotencyKey`. */
export interface CreatedProcedure {
  created: boolean
  procedure: ProcedureDetail
}

/** `POST|PATCH /api/procedures/:id/triggers[/:triggerId]` body (admins). */
export interface ProcedureTriggerBody {
  start: ProcedureStart
  /** Default: a name from the description. */
  name?: string
  /** Default: the context's employee. */
  employeeId?: string
  enabled?: boolean
}

/** `POST /api/procedures/:id/run` body: what to do this time. */
export interface RunProcedureBody {
  work?: string
  /** Who runs it when its context isn't built yet. */
  employeeId?: string
  /** A repeated key returns the first run instead of starting another. */
  idempotencyKey?: string
}

/** `POST /api/procedures/:id/run` → the new instance. */
export interface ProcedureRunStarted {
  sessionId: string
  slug: string
  runId: string
  contextSessionId: string
}

/** The refusal of a start that would match every event (a catch-all trigger), shown as the form's error. */
export const CATCH_ALL_START_MESSAGE =
  "This would start the procedure for every event. Pick a source, an event type or a field to match: events nothing else claims already go to the employee's router."

/** Events the integrations send, for the "integration event" picker and for plain-language descriptions. */
export interface IntegrationEventSpec {
  source: string
  system: string
  types: { type: string; label: string }[]
  /** Fields worth matching on, e.g. the GitLab project. */
  fields: { path: string; label: string; placeholder: string; phrase: string }[]
}

export const INTEGRATION_EVENTS: IntegrationEventSpec[] = [
  {
    source: 'integration:gitlab',
    system: 'GitLab',
    types: [
      { type: 'merge_request.opened', label: 'a merge request is opened' },
      { type: 'merge_request.updated', label: 'a merge request is updated' },
      { type: 'merge_request.approved', label: 'a merge request is approved' },
      { type: 'merge_request.merged', label: 'a merge request is merged' },
      { type: 'merge_request.closed', label: 'a merge request is closed' },
      { type: 'pipeline.failed', label: 'a pipeline fails' },
      { type: 'pipeline.succeeded', label: 'a pipeline succeeds' },
      { type: 'job.failed', label: 'a CI job fails' },
      { type: 'issue.opened', label: 'an issue is opened' },
      { type: 'comment.created', label: 'someone comments' },
      { type: 'push', label: 'someone pushes' },
    ],
    fields: [{ path: 'payload.project', label: 'Project', placeholder: 'acme/billing', phrase: 'in' }],
  },
  {
    source: 'integration:linear',
    system: 'Linear',
    types: [
      { type: 'issue.created', label: 'an issue is created' },
      { type: 'issue.assigned', label: 'an issue is assigned' },
      { type: 'issue.labeled', label: 'an issue gets a label' },
      { type: 'issue.state_changed', label: 'an issue changes state' },
      { type: 'comment.created', label: 'someone comments' },
    ],
    fields: [{ path: 'payload.team', label: 'Team', placeholder: 'PAY', phrase: 'in team' }],
  },
  {
    source: 'integration:slack',
    system: 'Slack',
    types: [
      { type: 'message.posted', label: 'a message is posted' },
      { type: 'message.mentioned', label: 'the employee is mentioned' },
      { type: 'message.direct', label: 'someone sends a direct message' },
    ],
    fields: [{ path: 'payload.channel_name', label: 'Channel', placeholder: 'access-requests', phrase: 'in #' }],
  },
]

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (n: string) => n.padStart(2, '0')

/** A cron expression in words, for the common shapes ("Every Monday at 09:00"); otherwise the expression itself. */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return `on the schedule ${cron}`
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string]
  const num = /^\d+$/
  if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour'
  if (/^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${min.slice(2)} minutes`
  if (!num.test(min) || !num.test(hour) || mon !== '*') return `On the schedule ${cron}`
  const at = `${pad(hour)}:${pad(min)}`
  if (dom === '*' && dow === '*') return `Every day at ${at}`
  if (dom === '*' && (dow === '1-5' || dow === 'MON-FRI')) return `Every weekday at ${at}`
  if (dom === '*' && num.test(dow) && Number(dow) <= 7) return `Every ${DAYS[Number(dow) % 7]} at ${at}`
  if (dom === '*' && /^[\d,]+$/.test(dow))
    return `Every ${dow
      .split(',')
      .map((d) => DAYS[Number(d) % 7])
      .join(', ')} at ${at}`
  if (num.test(dom) && dow === '*') return `On day ${dom} of every month at ${at}`
  return `On the schedule ${cron}`
}

/**
 * A start in plain words: "When someone posts in #access-requests", "Every Monday at 09:00",
 * "When a GitLab merge request is opened in acme/billing". `channelName` names a channel id.
 */
export function describeStart(
  start: ProcedureStart | { kind: 'manual' },
  channelName?: (id: string) => string | undefined,
): string {
  const extra = 'filter' in start && start.filter !== undefined && start.filter !== null ? ', with an extra filter' : ''
  switch (start.kind) {
    case 'manual':
      return 'Only when someone starts it'
    case 'channel': {
      const name = channelName?.(start.channelId)
      return `When someone posts in ${name ? `#${name}` : 'a chat channel'}${extra}`
    }
    case 'tag':
      return `When someone writes @${start.tag} in chat${extra}`
    case 'schedule':
      return `${describeCron(start.cron)}${start.timezone ? ` (${start.timezone})` : ''}${extra}`
    case 'integration': {
      const spec = INTEGRATION_EVENTS.find((s) => s.source === start.source)
      const what = spec?.types.find((t) => t.type === start.type)?.label ?? `a ${start.type} event arrives`
      const where = Object.entries(start.where ?? {})
        .map(([path, value]) => {
          const f = spec?.fields.find((x) => x.path === path)
          const v = typeof value === 'string' ? value : JSON.stringify(value)
          return f ? `${f.phrase}${f.phrase.endsWith('#') ? '' : ' '}${v}` : `where ${path} is ${v}`
        })
        .join(' ')
      return `When ${spec ? `${spec.system}: ` : ''}${what}${where ? ` ${where}` : ''}${extra}`
    }
    case 'custom': {
      const src = start.source && start.source !== '*' ? start.source : 'any source'
      const type = start.type && start.type !== '*' ? start.type : 'any'
      const where = Object.keys(start.where ?? {}).length ? ' with matching fields' : ''
      return `When a ${type} event arrives from ${src}${where}${extra}`
    }
  }
}

/** A short label for a start kind, for badges. */
export const START_LABELS: Record<ProcedureStartKind, string> = {
  manual: 'Manual',
  channel: 'Channel',
  tag: '@tag',
  schedule: 'Schedule',
  integration: 'Integration',
  custom: 'Event',
}

/** The routes of this section (merged into `ROUTES`). */
export const PROCEDURE_ROUTES = {
  listProcedures: ['GET', '/api/procedures'],
  getProcedure: ['GET', '/api/procedures/:id'],
  createProcedure: ['POST', '/api/procedures'],
  runProcedure: ['POST', '/api/procedures/:id/run'],
  rebuildProcedureContext: ['POST', '/api/procedures/:id/context/rebuild'],
  archiveProcedure: ['POST', '/api/procedures/:id/archive'],
  addProcedureTrigger: ['POST', '/api/procedures/:id/triggers'],
  updateProcedureTrigger: ['PATCH', '/api/procedures/:id/triggers/:triggerId'],
  deleteProcedureTrigger: ['DELETE', '/api/procedures/:id/triggers/:triggerId'],
} as const

/** The client methods of this section (part of `ApiClient`). */
export interface ProceduresApi {
  /** `GET /api/procedures?text=&ownerId=&archived=` → procedures with how they start, their runs and context state, by name. */
  procedures(q?: ProcedureListQuery): Promise<ProcedureListItem[]>
  /** `GET /api/procedures/:id` → the procedure, its triggers, approvers, runs and context. */
  procedure(id: string): Promise<ProcedureDetail>
  /**
   * `POST /api/procedures` → the procedure, its triggers and its context, created in one call (members; `starts`
   * needs an admin). A catch-all start is 422 and nothing is created; a repeated `idempotencyKey` returns the first.
   */
  createProcedure(body: CreateProcedureBody): Promise<CreatedProcedure>
  /** `POST /api/procedures/:id/run` body `{ work?, employeeId?, idempotencyKey? }` → the new instance (members). */
  runProcedure(id: string, body?: RunProcedureBody): Promise<ProcedureRunStarted>
  /** `POST /api/procedures/:id/context/rebuild` body `{ employeeId? }` → the procedure, with a fresh context (members). */
  rebuildProcedureContext(id: string, body?: { employeeId?: string }): Promise<ProcedureDetail>
  /** `POST /api/procedures/:id/archive` body `{ archived }` → the procedure. Archiving turns its triggers off (members). */
  archiveProcedure(id: string, archived: boolean): Promise<ProcedureDetail>
  /** `POST /api/procedures/:id/triggers` → the procedure with the new trigger (admins). A catch-all is 422. */
  addProcedureTrigger(id: string, body: ProcedureTriggerBody): Promise<ProcedureDetail>
  /** `PATCH /api/procedures/:id/triggers/:triggerId` body: any of `ProcedureTriggerBody` (admins). */
  updateProcedureTrigger(id: string, triggerId: string, body: Partial<ProcedureTriggerBody>): Promise<ProcedureDetail>
  /** `DELETE /api/procedures/:id/triggers/:triggerId` → the procedure without it (admins). */
  deleteProcedureTrigger(id: string, triggerId: string): Promise<ProcedureDetail>
}

type Call = <T>(
  route: keyof typeof PROCEDURE_ROUTES,
  params?: Record<string, string>,
  query?: Record<string, string | number | boolean | undefined | null>,
  body?: unknown,
) => Promise<T>

/** The `ProceduresApi` part of `createApiClient`. */
export function proceduresMethods(call: Call): ProceduresApi {
  return {
    procedures: (q = {}) => call('listProcedures', undefined, { ...q }),
    procedure: (id) => call('getProcedure', { id }),
    createProcedure: (body) => call('createProcedure', undefined, undefined, body),
    runProcedure: (id, body = {}) => call('runProcedure', { id }, undefined, body),
    rebuildProcedureContext: (id, body = {}) => call('rebuildProcedureContext', { id }, undefined, body),
    archiveProcedure: (id, archived) => call('archiveProcedure', { id }, undefined, { archived }),
    addProcedureTrigger: (id, body) => call('addProcedureTrigger', { id }, undefined, body),
    updateProcedureTrigger: (id, triggerId, body) => call('updateProcedureTrigger', { id, triggerId }, undefined, body),
    deleteProcedureTrigger: (id, triggerId) => call('deleteProcedureTrigger', { id, triggerId }),
  }
}
