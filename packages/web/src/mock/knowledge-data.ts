import type { ApiLink, ApiRecord, ApiRevision, MemoryRecordData, PersonRecordData, SkillRecordData } from '@mp/api'
import { type MockDb, mockId } from './data.ts'

/**
 * Memory, skills and people for the mock (the Memory, Skills and People pages): contacts with
 * their kind, access and handles, a deactivated person and a local agent; skills per company and
 * project, one with a few versions and one switched off; memories of every kind, some personal,
 * one corrected; and when employees last used them. Called at the end of `createMockDb` (ids are
 * made inside the function: data.ts and this module import each other).
 */

export interface KnowledgeUseRow {
  target: 'memory' | 'skill'
  id: string
  employeeId: string
  lastAt: string
  count: number
  lastSessionId?: string
}

export interface KnowledgeMockState {
  uses: KnowledgeUseRow[]
  signIns: Map<string, { lastSignInAt: string; lastSeenAt: string }>
  /** API tokens to seed into the mock API's token list. */
  tokens: { id: string; contactId: string; name: string; createdAt: string; revoked: boolean }[]
}

const STATE = new WeakMap<MockDb, KnowledgeMockState>()

/** The knowledge state of a mock db (seeded by `seedKnowledge`). */
export function knowledgeState(db: MockDb): KnowledgeMockState {
  let s = STATE.get(db)
  if (!s) {
    s = { uses: [], signIns: new Map(), tokens: [] }
    STATE.set(db, s)
  }
  return s
}

export function seedKnowledge(db: MockDb, at: (minutesAgo: number) => string) {
  const DAY = 60 * 24
  const map = (kind: string) => {
    if (!db.records.has(kind)) db.records.set(kind, new Map())
    return db.records.get(kind)!
  }
  const put = <T extends Record<string, unknown>>(
    kind: string,
    id: string,
    versions: { data: T; ago: number; by?: string }[],
  ): ApiRecord<T> => {
    const revs: ApiRevision[] = versions.map((v, i) => ({
      kind,
      id,
      version: i + 1,
      op: i === 0 ? 'create' : 'update',
      data: v.data as Record<string, unknown>,
      actor: v.by ? { type: v.by.startsWith('ses_') ? 'session' : 'contact', id: v.by } : { type: 'system', id: 'seed' },
      at: at(v.ago),
    }))
    const last = versions.at(-1)!
    const rec: ApiRecord<T> = {
      kind,
      id,
      version: versions.length,
      key: null,
      data: last.data,
      createdAt: at(versions[0]!.ago),
      updatedAt: at(last.ago),
    }
    map(kind).set(id, rec as ApiRecord)
    db.revisions.set(id, revs)
    return rec
  }
  const link = (from: [string, string], to: [string, string], role: string) => {
    db.links.push({
      id: mockId('lnk', 900 + db.links.length),
      from: { kind: from[0], id: from[1] },
      to: { kind: to[0], id: to[1] },
      role,
      data: {},
      createdAt: at(10 * DAY),
    } satisfies ApiLink)
  }
  const CON = {
    ana: mockId('con', 1),
    bob: mockId('con', 2),
    chen: mockId('con', 3),
    dana: mockId('con', 4),
    eli: mockId('con', 5),
    farah: mockId('con', 6),
    gus: mockId('con', 7),
    anaAgent: mockId('con', 8),
    billingBot: mockId('con', 11),
    infraBot: mockId('con', 12),
    supportBot: mockId('con', 13),
  }
  const EMP = { billing: mockId('emp', 1), infra: mockId('emp', 2), support: mockId('emp', 3) }
  const PRO = { payments: mockId('pro', 1), invoicing: mockId('pro', 2), platform: mockId('pro', 3), portal: mockId('pro', 4) }
  const SES = {
    billingIntake: mockId('ses', 1),
    pay123: mockId('ses', 2),
    pay131: mockId('ses', 7),
    pay140: mockId('ses', 8),
    inc42: mockId('ses', 21),
    deploy214: mockId('ses', 23),
    sup88: mockId('ses', 31),
    sup91: mockId('ses', 32),
  }
  const state = knowledgeState(db)

  // ── People: kinds, access, handles; a deactivated person and a local agent ──
  const contact = (id: string) => map('contact').get(id) as ApiRecord<PersonRecordData> | undefined
  const patch = (id: string, p: Partial<PersonRecordData>) => {
    const c = contact(id)
    if (c) c.data = { ...c.data, ...p }
  }
  patch(CON.ana, {
    kind: 'person',
    access: 'admin',
    handles: [
      { system: 'slack', id: 'U0ANA' },
      { system: 'gitlab', id: 'ana.novak' },
      { system: 'linear', id: 'ana' },
    ],
  })
  patch(CON.bob, {
    kind: 'person',
    access: 'member',
    handles: [
      { system: 'slack', id: 'U0BOB' },
      { system: 'gitlab', id: 'bsmith' },
    ],
  })
  patch(CON.chen, { kind: 'person', access: 'member', handles: [{ system: 'slack', id: 'U0CHEN' }] })
  patch(CON.dana, { kind: 'person', access: 'admin', handles: [{ system: 'slack', id: 'U0DANA' }] })
  patch(CON.eli, { kind: 'person', access: 'viewer' })
  for (const id of [CON.billingBot, CON.infraBot, CON.supportBot]) patch(id, { kind: 'ai' })
  put<PersonRecordData>('contact', CON.farah, [
    {
      data: {
        name: 'Farah Haddad',
        kind: 'person',
        role: 'Support engineer',
        team: 'Support',
        manager: CON.dana,
        email: 'farah@example.com',
        access: 'member',
        handles: [{ system: 'slack', id: 'U0FARAH' }],
      },
      ago: 90 * DAY,
    },
    {
      data: {
        name: 'Farah Haddad',
        kind: 'person',
        role: 'Support engineer',
        team: 'Support',
        manager: CON.dana,
        email: 'farah@example.com',
        access: 'member',
        handles: [{ system: 'slack', id: 'U0FARAH' }],
        deactivatedAt: at(5 * DAY),
        deactivatedBy: CON.dana,
      },
      ago: 5 * DAY,
      by: CON.dana,
    },
  ])
  put<PersonRecordData>('contact', CON.gus, [
    {
      data: {
        name: 'Gus Lee',
        kind: 'person',
        role: 'Platform engineer',
        team: 'Platform',
        manager: CON.bob,
        email: 'gus@example.com',
        access: 'member',
        handles: [
          { system: 'slack', id: 'U0GUS' },
          { system: 'gitlab', id: 'gus.lee' },
        ],
      },
      ago: 3 * DAY,
      by: CON.ana,
    },
  ])
  put<PersonRecordData>('contact', CON.anaAgent, [
    { data: { name: "Ana's Claude Code", kind: 'agent', sponsor: CON.ana, role: 'Local agent' }, ago: 2 * DAY },
  ])
  link(['contact', CON.gus], ['project', PRO.platform], 'member')
  link(['contact', CON.chen], ['project', PRO.payments], 'stakeholder')
  const signIn = (id: string, signedInMinAgo: number, seenMinAgo: number) =>
    state.signIns.set(id, { lastSignInAt: at(signedInMinAgo), lastSeenAt: at(seenMinAgo) })
  signIn(CON.ana, 2 * 60, 1)
  signIn(CON.bob, 3 * DAY, 40)
  signIn(CON.chen, 9 * DAY, 2 * DAY)
  signIn(CON.dana, 20 * 60, 6 * 60)
  signIn(CON.farah, 12 * DAY, 6 * DAY)
  state.tokens.push(
    { id: mockId('mtk', 90), contactId: CON.dana, name: 'Release script (CI)', createdAt: at(30 * DAY), revoked: false },
    { id: mockId('mtk', 91), contactId: CON.dana, name: 'Old laptop', createdAt: at(80 * DAY), revoked: true },
    { id: mockId('mtk', 92), contactId: CON.bob, name: 'Laptop agent', createdAt: at(6 * DAY), revoked: false },
  )

  // ── Skills ──
  map('skill').clear()
  const SKL = {
    triage: mockId('skl', 1),
    migration: mockId('skl', 2),
    release: mockId('skl', 3),
    incident: mockId('skl', 4),
    refunds: mockId('skl', 5),
    platformRelease: mockId('skl', 6),
    access: mockId('skl', 7),
  }
  const company = { type: 'company' as const }
  const project = (projectId: string) => ({ type: 'project' as const, projectId })
  put<SkillRecordData>('skill', SKL.triage, [
    {
      data: {
        name: 'triage-customer-bug',
        description: 'Reproduce, scope and route a bug a customer reported.',
        whenToUse: 'A support ticket or chat message describes something broken for a customer.',
        scope: company,
        body: "## When to use\n\nA customer reports something broken.\n\n## How to do it\n\n1. Find the account and the exact error message.\n2. Reproduce on staging with the same plan and data shape.\n3. Say how many customers it affects, and since when.\n4. Link the ticket to the project and ask its owner in the thread.\n\n## Check before you finish\n\n- The ticket has steps to reproduce and the owner is tagged.\n\n## Pitfalls\n\n- Don't promise a fix date: the owner does that.\n",
      },
      ago: 40 * DAY,
      by: CON.chen,
    },
  ])
  const releaseBody = (extra: string) =>
    `## When to use\n\nA release is due, or someone asks for one.\n\n## How to do it\n\n1. Tag from \`main\` once CI is green.\n2. Write the release notes from the merged merge requests, grouped by customer impact.\n3. Open the deploy merge request and start the [[procedure:${mockId('prc', 2)}|Production deploy]] procedure.${extra}\n\n## Pitfalls\n\n- Never merge the deploy merge request yourself: a person does.\n`
  put<SkillRecordData>('skill', SKL.release, [
    {
      data: {
        name: 'cut-release',
        description: 'Cut a release, write the notes and open the deploy MR.',
        scope: company,
        body: releaseBody(''),
      },
      ago: 30 * DAY,
      by: CON.bob,
    },
    {
      data: {
        name: 'cut-release',
        description: 'Cut a release, write the notes and open the deploy merge request.',
        whenToUse: 'A release train is due, or someone asks for a release.',
        scope: company,
        body: releaseBody(''),
      },
      ago: 12 * DAY,
      by: CON.ana,
    },
    {
      data: {
        name: 'cut-release',
        description: 'Cut a release, write the notes and open the deploy merge request.',
        whenToUse: 'A release train is due, or someone asks for a release.',
        scope: company,
        body: releaseBody('\n4. Post the notes in #deploys and link the merge request.'),
      },
      ago: 2 * DAY,
      by: CON.bob,
    },
  ])
  put<SkillRecordData>('skill', SKL.incident, [
    {
      data: {
        name: 'write-incident-update',
        description: 'Write a short, calm status update during an incident.',
        whenToUse: 'An incident is open and it has been 30 minutes since the last update.',
        scope: company,
        body: '## How to do it\n\n1. Say what is affected, in customer terms.\n2. Say what we know and what we are trying next.\n3. Give the time of the next update.\n\n## Pitfalls\n\n- No blame, no guesses about the cause.\n',
      },
      ago: 18 * DAY,
      by: CON.bob,
    },
  ])
  put<SkillRecordData>('skill', SKL.access, [
    {
      data: {
        name: 'answer-access-request',
        description: 'Grant access to a dashboard after the owner approves.',
        scope: company,
        enabled: false,
        body: '## How to do it\n\nReplaced by the [[procedure:' + mockId('prc', 3) + '|Access request]] procedure.\n',
      },
      ago: 50 * DAY,
      by: CON.dana,
    },
  ])
  put<SkillRecordData>('skill', SKL.migration, [
    {
      data: {
        name: 'write-migration',
        description: 'Write a forward-only SQL migration with a rollback plan.',
        whenToUse: 'A change to the payments database schema.',
        scope: project(PRO.payments),
        body: '## How to do it\n\n- Forward-only and numbered: never edit an old migration.\n- Test it against a copy of production data.\n- Write the rollback plan in the merge request.\n',
      },
      ago: 25 * DAY,
      by: CON.ana,
    },
  ])
  put<SkillRecordData>('skill', SKL.refunds, [
    {
      data: {
        name: 'refund-edge-cases',
        description: 'Partial refunds, refunds after a currency change, and refunds of refunds.',
        whenToUse: 'A refund that is not a simple full refund of one charge.',
        scope: project(PRO.payments),
        body:
          '## How to do it\n\n1. Partial refunds: refund the exact minor units asked, never round.\n2. After a currency change: refund in the charge currency.\n3. A refund of a refund: stop and ask [[contact:' +
          CON.ana +
          '|Ana]].\n',
      },
      ago: 8 * DAY,
      by: CON.ana,
    },
  ])
  put<SkillRecordData>('skill', SKL.platformRelease, [
    {
      data: {
        name: 'cut-release',
        description: 'Platform releases: images first, then the chart bump.',
        whenToUse: 'A release of a platform service.',
        scope: project(PRO.platform),
        body: '## How to do it\n\n1. Build and push the images from the tag.\n2. Bump the Helm chart version in a merge request.\n3. Ask @bob to approve the rollout.\n',
      },
      ago: 6 * DAY,
      by: CON.bob,
    },
  ])
  const use = (
    target: 'memory' | 'skill',
    id: string,
    employeeId: string,
    minutesAgo: number,
    count: number,
    sessionId?: string,
  ) =>
    state.uses.push({ target, id, employeeId, lastAt: at(minutesAgo), count, ...(sessionId ? { lastSessionId: sessionId } : {}) })
  use('skill', SKL.triage, EMP.support, 3 * 60, 7, SES.sup88)
  use('skill', SKL.triage, EMP.billing, 2 * DAY, 2, SES.pay123)
  use('skill', SKL.release, EMP.infra, 26 * 60, 3, SES.deploy214)
  use('skill', SKL.incident, EMP.infra, 5 * DAY, 4, SES.inc42)
  use('skill', SKL.refunds, EMP.billing, 50, 5, SES.pay123)
  use('skill', SKL.migration, EMP.billing, 9 * DAY, 1, SES.pay131)

  // ── Memories ──
  map('memory').clear()
  db.links = db.links.filter((l) => l.from.kind !== 'memory' && l.to.kind !== 'memory')
  type M = {
    summary: string
    kind: MemoryRecordData['kind']
    content?: string
    employeeId?: string
    scope?: MemoryRecordData['scope']
    source?: MemoryRecordData['source']
    verified?: number
    about?: string[]
    ago: number
    by?: string
    used?: [number, number]
  }
  const memories: M[] = [
    {
      summary: 'Ana approves refunds above $250; below that no approval is needed.',
      kind: 'fact',
      content: 'Confirmed by Ana in #billing. Refunds of a refund always need her, whatever the amount.',
      employeeId: EMP.billing,
      scope: { type: 'project', id: PRO.payments },
      source: { sessionId: SES.pay123, contactId: CON.ana },
      verified: 3 * DAY,
      about: [CON.ana, PRO.payments],
      ago: 10 * DAY,
      used: [45, 12],
    },
    {
      summary: 'Bob prefers incident updates every 30 minutes, not per finding.',
      kind: 'preference',
      employeeId: EMP.infra,
      source: { sessionId: SES.inc42, contactId: CON.bob },
      about: [CON.bob],
      ago: 9 * DAY,
      used: [5 * DAY, 3],
    },
    {
      summary: 'Stripe idempotency keys are the invoice id plus the attempt number.',
      kind: 'fact',
      content: 'Seen in the payments-api code (`charges/create.ts`). A retry with a new attempt number is a new charge.',
      employeeId: EMP.billing,
      scope: { type: 'project', id: PRO.payments },
      source: { sessionId: SES.pay140 },
      about: [PRO.payments],
      ago: 8 * DAY,
      used: [2 * DAY, 4],
    },
    {
      summary: 'Do not post refund amounts in public channels.',
      kind: 'feedback',
      content: 'Ana asked to keep amounts in threads or DMs.',
      source: { sessionId: SES.billingIntake, contactId: CON.ana },
      about: [CON.ana],
      ago: 7 * DAY,
      used: [3 * 60, 9],
    },
    {
      summary: 'Invoice rounding uses the currency minor unit, not two decimals.',
      kind: 'decision',
      content: 'Decided in PAY-131 with Eli: JPY has no minor unit, KWD has three.',
      employeeId: EMP.billing,
      scope: { type: 'project', id: PRO.invoicing },
      source: { sessionId: SES.pay131, contactId: CON.eli },
      about: [PRO.invoicing, CON.eli],
      ago: 6 * DAY,
    },
    {
      summary: 'Deploys to production happen on weekdays between 10:00 and 16:00 UTC.',
      kind: 'fact',
      source: { sessionId: SES.deploy214, contactId: CON.bob },
      about: [PRO.platform],
      verified: DAY,
      ago: 14 * DAY,
      used: [26 * 60, 6],
    },
    {
      summary: 'Chen works from Tokyo: tag him before 10:00 UTC for a same-day answer.',
      kind: 'preference',
      employeeId: EMP.support,
      source: { contactId: CON.chen },
      about: [CON.chen],
      ago: 20 * DAY,
      by: CON.chen,
      used: [DAY, 2],
    },
    {
      summary: 'Customers on the legacy plan see the old invoice PDF; that is expected.',
      kind: 'fact',
      employeeId: EMP.support,
      scope: { type: 'project', id: PRO.portal },
      source: { sessionId: SES.sup91 },
      about: [PRO.portal],
      ago: 4 * DAY,
    },
    {
      summary: 'SSO login failures are usually a clock skew on the customer IdP.',
      kind: 'feedback',
      content: 'Ask for the SAML response timestamp before escalating to the platform team.',
      employeeId: EMP.support,
      source: { sessionId: SES.sup88, contactId: CON.chen },
      ago: 2 * DAY,
      used: [5 * 60, 1],
    },
    {
      summary: 'Eli is on leave until the 14th; send finance questions to Dana.',
      kind: 'fact',
      scope: { type: 'contact', id: CON.eli },
      source: { contactId: CON.dana },
      about: [CON.eli, CON.dana],
      ago: 3 * DAY,
      by: CON.dana,
    },
    {
      summary: 'The staging disk fills up when log rotation is off; check it first.',
      kind: 'decision',
      employeeId: EMP.infra,
      scope: { type: 'project', id: PRO.platform },
      source: { sessionId: SES.inc42, contactId: CON.bob },
      about: [PRO.platform],
      ago: 11 * DAY,
      used: [11 * DAY - 60, 1],
    },
    {
      summary: 'Gus owns the Helm charts now, not Bob.',
      kind: 'fact',
      employeeId: EMP.infra,
      source: { contactId: CON.bob },
      about: [CON.gus, PRO.platform],
      ago: 3 * 60,
      by: CON.bob,
    },
  ]
  memories.forEach((m, i) => {
    const id = mockId('mem', i + 1)
    const data: MemoryRecordData = {
      summary: m.summary,
      kind: m.kind,
      ...(m.content ? { content: m.content } : {}),
      scope: m.scope ?? { type: 'company' },
      ...(m.source ? { source: m.source } : {}),
      ...(m.employeeId ? { employeeId: m.employeeId } : {}),
      ...(m.verified ? { verified: at(m.verified) } : {}),
    }
    const by = m.by ?? m.source?.sessionId
    put<MemoryRecordData>('memory', id, [{ data, ago: m.ago, ...(by ? { by } : {}) }])
    for (const r of m.about ?? []) link(['memory', id], [r.startsWith('con') ? 'contact' : 'project', r], 'about')
    if (m.used && m.employeeId) use('memory', id, m.employeeId, m.used[0], m.used[1], m.source?.sessionId)
    else if (m.used) use('memory', id, EMP.billing, m.used[0], m.used[1], m.source?.sessionId)
  })
  // One corrected memory, with its history.
  const fixedId = mockId('mem', memories.length + 1)
  const before: MemoryRecordData = {
    summary: 'The monthly billing run starts on the 1st at 02:00 UTC.',
    kind: 'fact',
    scope: { type: 'project', id: PRO.invoicing },
    employeeId: EMP.billing,
    source: { sessionId: SES.billingIntake, contactId: CON.eli },
  }
  const after: MemoryRecordData = {
    ...before,
    summary: 'The monthly billing run starts on the 1st at 04:00 UTC.',
    content: 'Moved two hours later in August so the FX rates are in.',
    correction: { note: 'It moved to 04:00 in August, after the FX rate job.', contactId: CON.eli, at: at(DAY) },
    verified: at(DAY),
  }
  put<MemoryRecordData>('memory', fixedId, [
    { data: before, ago: 25 * DAY, by: SES.billingIntake },
    { data: after, ago: DAY, by: CON.eli },
  ])
  link(['memory', fixedId], ['project', PRO.invoicing], 'about')
  use('memory', fixedId, EMP.billing, 20, 14, SES.billingIntake)

  // The generic kinds list, in the real shapes.
  const kinds = db.kinds.filter((k) => k.kind !== 'memory' && k.kind !== 'skill')
  kinds.push(
    {
      kind: 'skill',
      prefix: 'skl',
      description: 'A packaged playbook: instructions for doing one kind of work well, company-wide or for one project.',
      titleField: 'name',
      core: [
        { name: 'name', type: 'string', required: true },
        { name: 'description', type: 'string', required: true },
        { name: 'whenToUse', type: 'string' },
        { name: 'body', type: 'text', required: true },
        { name: 'scope', type: 'json', required: true },
        { name: 'enabled', type: 'boolean' },
      ],
    },
    {
      kind: 'memory',
      prefix: 'mem',
      description: 'One thing the employee learned, was told or decided, recallable in later sessions.',
      titleField: 'summary',
      core: [
        { name: 'summary', type: 'string', required: true },
        { name: 'kind', type: 'enum', values: ['fact', 'preference', 'feedback', 'decision', 'other'], required: true },
        { name: 'content', type: 'text' },
        { name: 'scope', type: 'json', required: true },
        { name: 'source', type: 'json' },
        { name: 'verified', type: 'timestamp' },
        { name: 'employeeId', type: 'ref', ref: 'employee' },
      ],
    },
  )
  db.kinds = kinds
}
