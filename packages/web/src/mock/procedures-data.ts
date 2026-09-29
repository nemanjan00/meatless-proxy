import type { ApiRecord, Json, ProcedureRecordData, ProcedureStart, RunData, RunState, SessionData, TriggerData } from '@mp/api'
import { CHN, CON, EMP, type MockDb, PRC, PRO, SES, mockId } from './data.ts'

/**
 * Procedures for the mock: their triggers (a chat channel, an @tag, a schedule, a GitLab event,
 * a Linear label), a month of instances in every state, and contexts that are ready, out of date
 * after an edit, or not built yet. Called at the end of `createMockDb` (only inside functions:
 * data.ts and this module import each other).
 */

/** The fields that go into a procedure's context: a change to any of them makes the context out of date. */
export const CONTEXT_FIELDS = ['name', 'applies', 'body', 'ownerId', 'approvals', 'skills', 'checklist'] as const

/** What a context was built from (the server keeps a hash; the mock keeps the fields). */
export function mockDigest(data: Record<string, unknown>): string {
  return JSON.stringify(CONTEXT_FIELDS.map((f) => data[f] ?? null))
}

/** The trigger fields the Triggers page reads (source, type, filters), for a start. */
export function triggerShape(start: ProcedureStart): Pick<TriggerData, 'source' | 'type'> & { filters?: Record<string, Json> } {
  const extra: Record<string, Json> = start.filter && typeof start.filter === 'object' ? { filter: start.filter } : {}
  switch (start.kind) {
    case 'channel':
      return { source: 'chat', type: 'message.posted', filters: { 'payload.channelId': start.channelId, ...extra } }
    case 'tag':
      return { source: 'chat', type: 'message.*', filters: { tag: `@${start.tag}`, ...extra } }
    case 'schedule':
      return {
        source: 'timer',
        type: 'schedule.fired',
        filters: { cron: start.cron, ...(start.timezone ? { timezone: start.timezone } : {}) },
      }
    case 'integration':
    case 'custom':
      return {
        source: start.source ?? '*',
        type: start.type ?? '*',
        ...(start.where || start.filter ? { filters: { ...(start.where ?? {}), ...extra } } : {}),
      }
  }
}

export function seedProcedures(db: MockDb, at: (minutesAgo: number) => string) {
  const map = (kind: string) => {
    if (!db.records.has(kind)) db.records.set(kind, new Map())
    return db.records.get(kind)!
  }
  const put = <T extends Record<string, unknown>>(kind: string, id: string, data: T, created: number, updated = created) => {
    const rec: ApiRecord<T> = { kind, id, version: 1, key: null, data, createdAt: at(created), updatedAt: at(updated) }
    map(kind).set(id, rec as ApiRecord)
    db.revisions.set(id, [{ kind, id, version: 1, op: 'create', data, actor: { type: 'system', id: 'seed' }, at: at(created) }])
    return rec
  }
  const session = (id: string) => map('session').get(id) as ApiRecord<SessionData> | undefined
  const DAY = 60 * 24
  // Ids made here, not at the top of the module: data.ts and this module import each other.
  const MOCK_PRC = { review: mockId('prc', 4), release: mockId('prc', 5), postmortem: mockId('prc', 6) }

  // ── More procedures: a schedule with no context yet, a GitLab one, a manual-only one ──
  put<ProcedureRecordData>(
    'procedure',
    MOCK_PRC.review,
    {
      name: 'Weekly access review',
      applies: 'Every Monday: review who has access to production systems, and remove what nobody uses.',
      ownerId: CON.infraBot,
      approvals: [{ contactId: CON.dana, step: 'before removing anyone’s access' }],
      body: '## When to use\n\nEvery Monday morning, for production systems.\n\n## Steps\n\n1. List who has access to each production system.\n2. Flag accounts nobody used in 30 days.\n3. Ask @dana before removing access.\n\n## Done when\n\nThe review is posted in #access-requests with what changed.\n\n## Escalate if\n\nAn account belongs to someone who left the company.\n',
    },
    3 * DAY,
  )
  put<ProcedureRecordData>(
    'procedure',
    MOCK_PRC.release,
    {
      name: 'Release notes',
      applies: 'A merge request to payments-api is merged: write the customer-facing release note.',
      ownerId: CON.chen,
      projectIds: [PRO.payments],
      body: '## When to use\n\nA merge request to `acme/payments-api` is merged.\n\n## Steps\n\n1. Read the merge request and its linked issue.\n2. Write two sentences a customer understands.\n3. Add it to the draft release notes.\n\n## Done when\n\nThe draft has the note, with a link to the merge request.\n\n## Escalate if\n\nThe change affects pricing: ask @chen.\n',
      contextSessionId: mockId('ses', 60),
    },
    25 * DAY,
  )
  put<ProcedureRecordData>(
    'procedure',
    MOCK_PRC.postmortem,
    {
      name: 'Incident postmortem',
      applies: 'After an incident is resolved: write the timeline, the cause and the follow-ups.',
      ownerId: CON.bob,
      approvals: [{ role: 'engineering manager', step: 'before it is published' }],
      body: '## When to use\n\nWithin two days after an incident is resolved.\n\n## Steps\n\n1. Build the timeline from the incident channel.\n2. Write the cause, without blame.\n3. List follow-ups as Linear issues.\n\n## Done when\n\nThe postmortem is published and every follow-up has an owner.\n\n## Escalate if\n\nCustomer data was exposed.\n',
      contextSessionId: mockId('ses', 61),
    },
    40 * DAY,
  )

  // ── Contexts: the existing three, and the new ones. Production deploy's is out of date. ──
  const contextMeta = (procedureId: string, digestOf: Record<string, unknown>, version = 1): Record<string, Json> => ({
    context: true,
    procedure: procedureId,
    procedureContext: true,
    procedureVersion: version,
    procedureDigest: mockDigest(digestOf),
  })
  for (const [sid, pid] of [
    [SES.refundCtx, PRC.refund],
    [SES.accessCtx, PRC.access],
  ] as const) {
    const s = session(sid)
    const p = map('procedure').get(pid)
    if (s && p) s.data = { ...s.data, meta: { ...(s.data.meta ?? {}), ...contextMeta(pid, p.data) } }
  }
  const deploy = map('procedure').get(PRC.deploy) as ApiRecord<ProcedureRecordData> | undefined
  const deployCtx = session(SES.deployCtx)
  if (deploy && deployCtx) {
    const before = {
      ...deploy.data,
      body: deploy.data.body?.replace('Watch the error rate for 15 minutes', 'Watch the error rate for 5 minutes'),
    }
    deployCtx.data = { ...deployCtx.data, meta: { ...(deployCtx.data.meta ?? {}), ...contextMeta(PRC.deploy, before) } }
    // Bob edited the steps two days ago, after the context was built.
    deploy.version = 2
    deploy.updatedAt = at(2 * DAY)
    db.revisions.set(PRC.deploy, [
      { ...db.revisions.get(PRC.deploy)![0]!, data: before },
      {
        kind: 'procedure',
        id: PRC.deploy,
        version: 2,
        op: 'update',
        data: deploy.data,
        actor: { type: 'contact', id: CON.bob },
        at: at(2 * DAY),
      },
    ])
  }
  const infraHead = deployCtx?.data.head ?? null
  const billingHead = session(SES.refundCtx)?.data.head ?? null
  const ctxSession = (
    id: string,
    title: string,
    slug: string,
    employeeId: string,
    head: string | null,
    procedureId: string,
    created: number,
  ) => {
    const p = map('procedure').get(procedureId)!
    put<SessionData>(
      'session',
      id,
      {
        title,
        slug,
        employeeId,
        status: 'active',
        head,
        rootId: id,
        depth: 0,
        toolset: ['sessions.fork', 'chat.post', 'docs.read'],
        document: `# ${title} (procedure context)\n\nHas read the procedure. Every run is a fork of this context.\n`,
        defaultRunMode: 'ephemeral',
        meta: contextMeta(procedureId, p.data),
      },
      created,
    )
    db.links.push({
      id: mockId('lnk', `c${id.slice(-4)}`),
      from: { kind: 'session', id },
      to: { kind: 'procedure', id: procedureId },
      role: 'context_of',
      data: {},
      createdAt: at(created),
    })
  }
  ctxSession(mockId('ses', 60), 'Procedure: Release notes', 'release-notes', EMP.billing, billingHead, MOCK_PRC.release, 25 * DAY)
  ctxSession(
    mockId('ses', 61),
    'Procedure: Incident postmortem',
    'postmortem',
    EMP.infra,
    infraHead,
    MOCK_PRC.postmortem,
    40 * DAY,
  )

  // ── Triggers: the existing procedure triggers get their start; new ones for the new procedures. ──
  const trg = (n: number) => mockId('trg', n)
  const withStart = (n: number, procedureId: string, start: ProcedureStart, patch: Partial<TriggerData> = {}) => {
    const t = map('trigger').get(trg(n)) as ApiRecord<TriggerData> | undefined
    if (t) t.data = { ...t.data, ...triggerShape(start), ...patch, procedureId, start }
  }
  withStart(3, PRC.refund, {
    kind: 'integration',
    source: 'integration:linear',
    type: 'issue.labeled',
    where: { 'payload.team': 'PAY' },
    filter: { 'payload.labels': { $in: ['refund'] } },
  })
  withStart(5, PRC.deploy, { kind: 'channel', channelId: CHN.deploys }, { name: 'Someone posts in #deploys' })
  withStart(7, PRC.access, { kind: 'channel', channelId: CHN.access }, { name: 'Someone posts in #access-requests' })
  const newTrigger = (
    n: number,
    name: string,
    employeeId: string,
    contextId: string,
    procedureId: string,
    start: ProcedureStart,
    fired: number,
  ) =>
    put<TriggerData>(
      'trigger',
      trg(n),
      { name, employeeId, contextId, fork: true, enabled: true, procedureId, start, fired, ...triggerShape(start) },
      20 * DAY,
    )
  newTrigger(
    20,
    'Every Monday at 09:00',
    EMP.infra,
    '',
    MOCK_PRC.review,
    { kind: 'schedule', cron: '0 9 * * 1', timezone: 'Europe/Belgrade' },
    0,
  )
  newTrigger(21, 'Someone writes @deploy in chat', EMP.infra, SES.deployCtx, PRC.deploy, { kind: 'tag', tag: 'deploy' }, 4)
  newTrigger(
    22,
    'GitLab: a merge request is merged in acme/payments-api',
    EMP.billing,
    mockId('ses', 60),
    MOCK_PRC.release,
    {
      kind: 'integration',
      source: 'integration:gitlab',
      type: 'merge_request.merged',
      where: { 'payload.project': 'acme/payments-api' },
    },
    9,
  )

  // ── A month of instances: forks of each context, with their runs. ──
  type Cause = { trigger: number } | { person: string } | { session: string }
  const instances: {
    procedure: string
    context: string
    employee: string
    title: string
    ago: number
    minutes: number
    state: RunState
    cause: Cause
    outcome?: string
  }[] = [
    {
      procedure: PRC.refund,
      context: SES.refundCtx,
      employee: EMP.billing,
      title: 'Refund approval: PAY-118',
      ago: 3 * DAY,
      minutes: 42,
      state: 'completed',
      cause: { trigger: 3 },
      outcome: 'Refunded $380 on INV-0981 after Ana approved; the customer has the reply.',
    },
    {
      procedure: PRC.refund,
      context: SES.refundCtx,
      employee: EMP.billing,
      title: 'Refund approval: PAY-109',
      ago: 9 * DAY,
      minutes: 18,
      state: 'completed',
      cause: { session: SES.billingIntake },
      outcome: 'Refunded $260; Ana approved in the thread.',
    },
    {
      procedure: PRC.refund,
      context: SES.refundCtx,
      employee: EMP.billing,
      title: 'Refund approval: PAY-097',
      ago: 16 * DAY,
      minutes: 7,
      state: 'failed',
      cause: { trigger: 3 },
      outcome: 'The billing system refused the refund: the charge was already disputed.',
    },
    {
      procedure: PRC.refund,
      context: SES.refundCtx,
      employee: EMP.billing,
      title: 'Refund approval: goodwill credit',
      ago: 26 * DAY,
      minutes: 95,
      state: 'completed',
      cause: { person: CON.ana },
      outcome: 'Issued a $300 goodwill credit, approved by Ana.',
    },
    {
      procedure: PRC.deploy,
      context: SES.deployCtx,
      employee: EMP.infra,
      title: 'Deploy payments-api v2.13',
      ago: 2 * DAY,
      minutes: 34,
      state: 'completed',
      cause: { trigger: 5 },
      outcome: 'v2.13 is live; error rate flat for 15 minutes.',
    },
    {
      procedure: PRC.deploy,
      context: SES.deployCtx,
      employee: EMP.infra,
      title: 'Deploy invoicing v1.8',
      ago: 6 * DAY,
      minutes: 12,
      state: 'cancelled',
      cause: { trigger: 21 },
      outcome: 'Cancelled by Bob: outside the deploy window.',
    },
    {
      procedure: PRC.deploy,
      context: SES.deployCtx,
      employee: EMP.infra,
      title: 'Deploy payments-api v2.12',
      ago: 11 * DAY,
      minutes: 51,
      state: 'completed',
      cause: { trigger: 5 },
      outcome: 'Deployed after Bob approved; the migration ran in 40s.',
    },
    {
      procedure: PRC.deploy,
      context: SES.deployCtx,
      employee: EMP.infra,
      title: 'Deploy support-portal hotfix',
      ago: 19 * DAY,
      minutes: 22,
      state: 'failed',
      cause: { person: CON.bob },
      outcome: 'Rolled back: the error rate rose to 3% after the deploy.',
    },
    {
      procedure: PRC.access,
      context: SES.accessCtx,
      employee: EMP.infra,
      title: 'Access request: Grafana for Eli',
      ago: 45,
      minutes: 0,
      state: 'suspended',
      cause: { trigger: 7 },
      outcome: 'Waiting for Dana to approve read access to Grafana.',
    },
    {
      procedure: PRC.access,
      context: SES.accessCtx,
      employee: EMP.infra,
      title: 'Access request: payments repo for Chen',
      ago: 4 * DAY,
      minutes: 26,
      state: 'completed',
      cause: { trigger: 7 },
      outcome: 'Granted Developer on acme/payments-api until Dec 31.',
    },
    {
      procedure: PRC.access,
      context: SES.accessCtx,
      employee: EMP.infra,
      title: 'Access request: prod database',
      ago: 13 * DAY,
      minutes: 9,
      state: 'completed',
      cause: { trigger: 7 },
      outcome: 'Declined: production data needs Dana, who said no. Offered the staging copy.',
    },
    {
      procedure: MOCK_PRC.release,
      context: mockId('ses', 60),
      employee: EMP.billing,
      title: 'Release note: !481 refund webhooks',
      ago: 20,
      minutes: 0,
      state: 'queued',
      cause: { trigger: 22 },
    },
    {
      procedure: MOCK_PRC.release,
      context: mockId('ses', 60),
      employee: EMP.billing,
      title: 'Release note: !476 invoice PDFs',
      ago: 5 * DAY,
      minutes: 4,
      state: 'completed',
      cause: { trigger: 22 },
      outcome: 'Added: “Invoice PDFs now show the tax breakdown.”',
    },
    {
      procedure: MOCK_PRC.release,
      context: mockId('ses', 60),
      employee: EMP.billing,
      title: 'Release note: !470 currency rounding',
      ago: 12 * DAY,
      minutes: 3,
      state: 'completed',
      cause: { trigger: 22 },
      outcome: 'Added: “Amounts in JPY are no longer rounded to cents.”',
    },
    {
      procedure: MOCK_PRC.postmortem,
      context: mockId('ses', 61),
      employee: EMP.infra,
      title: 'Postmortem: INC-39 queue backlog',
      ago: 12 * DAY,
      minutes: 64,
      state: 'completed',
      cause: { person: CON.bob },
      outcome: 'Published; three follow-ups filed as INC-40 to INC-42.',
    },
  ]
  let n = 0
  for (const i of instances) {
    n++
    const sid = mockId('ses', `7${String(n).padStart(2, '0')}`)
    const rid = mockId('run', `7${String(n).padStart(2, '0')}`)
    const ctx = session(i.context)
    const live = !['completed', 'failed', 'cancelled'].includes(i.state)
    put<SessionData>(
      'session',
      sid,
      {
        title: i.title,
        slug: i.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40),
        employeeId: i.employee,
        status: i.state === 'suspended' ? 'waiting' : live ? 'active' : 'done',
        head: ctx?.data.head ?? null,
        rootId: ctx?.data.rootId ?? i.context,
        parent: { sessionId: i.context, entryId: ctx?.data.head ?? null },
        depth: 1,
        toolset: ctx?.data.toolset ?? [],
        document: `# ${i.title}\n\n${i.outcome ?? 'Working on it.'}\n`,
        meta: { procedure: i.procedure },
      },
      i.ago,
      live ? 1 : i.ago - i.minutes,
    )
    db.links.push({
      id: mockId('lnk', `r${n}`),
      from: { kind: 'session', id: sid },
      to: { kind: 'procedure', id: i.procedure },
      role: 'runs_procedure',
      data: {},
      createdAt: at(i.ago),
    })
    const cause: RunData['cause'] =
      'trigger' in i.cause
        ? { type: 'event', note: 'trigger' }
        : 'person' in i.cause
          ? { type: 'manual', note: 'run now' }
          : { type: 'fork', note: `procedure ${i.procedure}` }
    put<RunData>(
      'run',
      rid,
      {
        sessionId: sid,
        employeeId: i.employee,
        rootSessionId: ctx?.data.rootId ?? i.context,
        mode: 'continuing',
        state: i.state,
        base: ctx?.data.head ?? null,
        tip: ctx?.data.head ?? null,
        cause,
        ...('person' in i.cause ? { requesterId: i.cause.person } : {}),
        ...('trigger' in i.cause ? { triggerId: trg(i.cause.trigger) } : {}),
        ...('session' in i.cause ? { callerSessionId: i.cause.session } : {}),
        priority: 0,
        steps: Math.max(1, Math.round(i.minutes / 4)),
        startedAt: at(i.ago),
        ...(live ? {} : { endedAt: at(i.ago - i.minutes) }),
        ...(i.outcome && !live
          ? {
              result:
                i.state === 'failed'
                  ? { status: 'failed', error: i.outcome }
                  : { status: i.state as 'completed' | 'cancelled', output: i.outcome },
            }
          : {}),
        ...(i.state === 'suspended' ? { wait: { type: 'delivery' } } : {}),
      },
      i.ago,
      live ? 1 : i.ago - i.minutes,
    )
    if (i.state === 'suspended')
      db.steps.set(rid, { kind: 'waiting', label: 'Waiting for Dana in #access-requests', since: at(40) })
  }
}
