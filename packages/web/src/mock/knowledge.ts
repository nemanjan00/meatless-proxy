import {
  type Access,
  type ApiRecord,
  ApiRequestError,
  type ApiToken,
  type EmployeeData,
  type KnowledgeApi,
  type KnowledgePerson,
  type KnowledgeRef,
  MEMORY_KINDS,
  type MemoryDetail,
  type MemoryItem,
  type MemoryRecordData,
  type PersonDetail,
  type PersonItem,
  type PersonRecordData,
  type ProcedureRecordData,
  type ProjectData,
  type SessionData,
  type SkillDetail,
  type SkillListItem,
  type SkillRecordData,
} from '@mp/api'
import { type MockDb, mockId } from './data.ts'
import { knowledgeState } from './knowledge-data.ts'

/** What the knowledge mock borrows from the mock API. */
export interface MockKnowledgeHelpers {
  db: MockDb
  iso(): string
  delay<T>(v: T): Promise<T>
  write<T extends Record<string, unknown>>(kind: string, id: string, data: T): ApiRecord<T>
  get<T>(kind: string, id: string): ApiRecord<T> | undefined
  all<T>(kind: string): ApiRecord<T>[]
  me: { id: string; name: string; access?: Access }
  /** The mock API's token list (shared with Settings › API tokens). */
  tokens: ApiToken[]
}

const fail = (status: number, code: 'not_found' | 'validation' | 'denied' | 'conflict' | 'bad_request', message: string) =>
  Promise.reject(new ApiRequestError(status, code, message))
const norm = (s: string) => s.trim().toLowerCase()
const changed = (a: Record<string, unknown> | null, b: Record<string, unknown> | null) =>
  [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter(
    (k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]),
  )
const SKILL_RECENT_MS = 30 * 24 * 3600 * 1000

/**
 * The Memory, Skills and People API in the mock, like packages/server/src/knowledge: the memory
 * privacy rule (personal memories for the person and admins), skill versions and usage, and
 * people with access, sign-ins, sign-in links and deactivation.
 */
export function createMockKnowledgeApi(h: MockKnowledgeHelpers): KnowledgeApi {
  const { db, iso, delay, get, all, me } = h
  const state = knowledgeState(db)
  for (const t of state.tokens) if (!h.tokens.some((x) => x.id === t.id)) h.tokens.push({ ...t })
  const access = (): Access => me.access ?? 'admin'
  const isAdmin = () => access() === 'admin'
  const map = (kind: string) => {
    if (!db.records.has(kind)) db.records.set(kind, new Map())
    return db.records.get(kind)!
  }
  const write = <T extends Record<string, unknown>>(kind: string, id: string, data: T) => {
    const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null)) as T
    return h.write(kind, id, clean)
  }
  const employeeByContact = (cid: string) => all<EmployeeData>('employee').find((e) => e.data.contactId === cid)
  const person = (cid: string | undefined): KnowledgePerson | null => {
    if (!cid) return null
    const c = get<PersonRecordData>('contact', cid)
    if (!c) return { contactId: cid, name: cid, kind: 'person' }
    const e = employeeByContact(cid)
    return { contactId: cid, name: c.data.name, kind: c.data.kind ?? 'person', ...(e ? { employeeId: e.id } : {}) }
  }
  const ref = (kind: string, id: string): KnowledgeRef | null => {
    if (kind === 'contact') {
      const c = get<PersonRecordData>('contact', id)
      if (!c) return null
      const e = employeeByContact(id)
      return { kind, id, name: c.data.name, contactKind: c.data.kind ?? 'person', ...(e ? { employeeId: e.id } : {}) }
    }
    if (kind === 'project') {
      const p = get<ProjectData>('project', id)
      return p ? { kind, id, name: p.data.name } : null
    }
    return null
  }
  const employee = (id: string | undefined) => (id ? { id, name: get<EmployeeData>('employee', id)?.data.name ?? id } : null)
  const actorName = (a: { type: string; id: string }) =>
    a.type === 'contact'
      ? (get<PersonRecordData>('contact', a.id)?.data.name ?? a.id)
      : a.type === 'session'
        ? 'an employee session'
        : 'the harness'

  // ── Memory ──
  const memLinks = (id: string) =>
    db.links.filter((l) => (l.from.kind === 'memory' && l.from.id === id) || (l.to.kind === 'memory' && l.to.id === id))
  const aboutOf = (m: ApiRecord<MemoryRecordData>) => {
    const out = new Map<string, KnowledgeRef>()
    if (m.data.scope?.type !== 'company' && m.data.scope?.id) {
      const r = ref(m.data.scope.type, m.data.scope.id)
      if (r) out.set(r.id, r)
    }
    for (const l of memLinks(m.id)) {
      if (l.role !== 'about') continue
      const other = l.from.id === m.id ? l.to : l.from
      const r = ref(other.kind, other.id)
      if (r) out.set(r.id, r)
    }
    return [...out.values()]
  }
  const peopleOf = (about: KnowledgeRef[]) =>
    about.filter((a) => a.kind === 'contact' && a.contactKind === 'person').map((a) => a.id)
  const canSee = (people: string[]) => isAdmin() || !people.length || people.includes(me.id)
  const canChange = (people: string[]) => isAdmin() || people.includes(me.id) || (access() === 'member' && !people.length)
  const usage = (target: 'memory' | 'skill', id: string) => state.uses.filter((u) => u.target === target && u.id === id)
  const memItem = (m: ApiRecord<MemoryRecordData>): MemoryItem => {
    const about = aboutOf(m)
    const people = peopleOf(about)
    const uses = usage('memory', m.id)
    const session = m.data.source?.sessionId ? get<SessionData>('session', m.data.source.sessionId) : undefined
    return {
      memory: m,
      employee: employee(m.data.employeeId),
      about,
      personal: people.length > 0,
      source: {
        session: session
          ? { id: session.id, title: session.data.title, slug: session.data.slug, status: session.data.status }
          : null,
        person: person(m.data.source?.contactId),
      },
      lastUsedAt: uses.reduce<string | null>((a, u) => (!a || u.lastAt > a ? u.lastAt : a), null),
      uses: uses.reduce((n, u) => n + u.count, 0),
      canEdit: canChange(people),
    }
  }
  const memDetail = (m: ApiRecord<MemoryRecordData>): MemoryDetail => {
    const revs = db.revisions.get(m.id) ?? []
    return {
      ...memItem(m),
      history: revs
        .map((r, i) => {
          const data = r.data as MemoryRecordData | null
          const diff = i === 0 ? [] : changed(revs[i - 1]!.data, r.data)
          return {
            version: r.version,
            op: r.op,
            at: r.at,
            actor: { ...r.actor, name: actorName(r.actor) },
            changed: diff,
            summary: data?.summary ?? '',
            ...(data?.content ? { content: data.content } : {}),
            ...(data?.correction && diff.includes('correction') ? { note: data.correction.note } : {}),
          }
        })
        .reverse(),
    }
  }
  const visibleMemory = (id: string) => {
    const m = get<MemoryRecordData>('memory', id)
    if (!m || !canSee(peopleOf(aboutOf(m)))) return null
    return m
  }
  const setAbout = (id: string, about: { kind: string; id: string }[]) => {
    db.links = db.links.filter((l) => !(l.from.kind === 'memory' && l.from.id === id && l.role === 'about'))
    for (const a of about)
      db.links.push({
        id: mockId('lnk', 5000 + db.links.length + Math.floor(Math.random() * 1000)),
        from: { kind: 'memory', id },
        to: { kind: a.kind, id: a.id },
        role: 'about',
        data: {},
        createdAt: iso(),
      })
  }

  // ── Skills ──
  const skillItem = (k: ApiRecord<SkillRecordData>): SkillListItem => {
    const since = new Date(db.now() - SKILL_RECENT_MS).toISOString()
    const byEmployee = new Map<string, SkillListItem['usedBy'][number]>()
    for (const u of usage('skill', k.id)) {
      if (u.lastAt < since) continue
      const prev = byEmployee.get(u.employeeId)
      byEmployee.set(u.employeeId, {
        employee: employee(u.employeeId)!,
        lastAt: prev && prev.lastAt > u.lastAt ? prev.lastAt : u.lastAt,
        count: (prev?.count ?? 0) + u.count,
        ...(u.lastSessionId ? { lastSessionId: u.lastSessionId } : {}),
      })
    }
    const pid = k.data.scope.type === 'project' ? k.data.scope.projectId : undefined
    const company =
      pid && all<SkillRecordData>('skill').find((o) => o.data.scope.type === 'company' && norm(o.data.name) === norm(k.data.name))
    const last = (db.revisions.get(k.id) ?? []).at(-1)
    return {
      skill: k,
      project: pid ? { id: pid, name: get<ProjectData>('project', pid)?.data.name ?? pid } : null,
      overrides: company ? { id: company.id, name: company.data.name } : null,
      usedBy: [...byEmployee.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)),
      updatedBy: last ? { type: last.actor.type, id: last.actor.id, name: actorName(last.actor) } : null,
    }
  }
  const skillDetail = (k: ApiRecord<SkillRecordData>): SkillDetail => {
    const revs = db.revisions.get(k.id) ?? []
    return {
      ...skillItem(k),
      versions: revs
        .map((r, i) => ({
          version: r.version,
          op: r.op,
          at: r.at,
          actor: { ...r.actor, name: actorName(r.actor) },
          changed: i === 0 ? [] : changed(revs[i - 1]!.data, r.data),
          data: r.data as SkillRecordData | null,
        }))
        .reverse(),
      procedures: all<ProcedureRecordData>('procedure')
        .filter((p) => !p.data.archived && (p.data.skills ?? []).some((n) => norm(n) === norm(k.data.name)))
        .map((p) => ({ id: p.id, name: p.data.name })),
    }
  }
  const nameTaken = (name: string, scope: SkillRecordData['scope'], self?: string) =>
    all<SkillRecordData>('skill').some(
      (o) =>
        o.id !== self &&
        norm(o.data.name) === norm(name) &&
        o.data.scope.type === scope.type &&
        (o.data.scope.projectId ?? '') === (scope.projectId ?? ''),
    )

  // ── People ──
  const typeOf = (c: ApiRecord<PersonRecordData>) => c.data.kind ?? (c.data.ai === true ? 'ai' : 'person')
  const priv = (cid: string) => isAdmin() || me.id === cid
  const personItem = (c: ApiRecord<PersonRecordData>): PersonItem => {
    const type = typeOf(c)
    const e = employeeByContact(c.id)
    const seen = priv(c.id) ? state.signIns.get(c.id) : undefined
    const projects = new Map<string, { id: string; name: string; roles: string[] }>()
    for (const l of db.links)
      if (l.from.kind === 'contact' && l.from.id === c.id && l.to.kind === 'project') {
        const p = get<ProjectData>('project', l.to.id)
        if (!p) continue
        const cur = projects.get(p.id) ?? { id: p.id, name: p.data.name, roles: [] }
        if (!cur.roles.includes(l.role)) cur.roles.push(l.role)
        projects.set(p.id, cur)
      }
    const sponsor = type === 'agent' ? person(c.data.sponsor) : null
    return {
      contact: c,
      type,
      ...(e ? { employeeId: e.id } : {}),
      access: type === 'person' ? (c.data.access ?? 'viewer') : null,
      deactivated: !!c.data.deactivatedAt,
      lastSignInAt: seen?.lastSignInAt ?? null,
      lastSeenAt: seen?.lastSeenAt ?? null,
      projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name)),
      sponsor: sponsor ? { contactId: sponsor.contactId, name: sponsor.name } : null,
    }
  }
  const personDetail = (c: ApiRecord<PersonRecordData>): PersonDetail => {
    const item = personItem(c)
    const memoriesAbout =
      item.type !== 'person' || priv(c.id)
        ? all<MemoryRecordData>('memory').filter((m) => aboutOf(m).some((a) => a.id === c.id)).length
        : null
    return {
      ...item,
      manager: person(c.data.manager),
      reports: all<PersonRecordData>('contact')
        .filter((o) => o.data.manager === c.id)
        .map((o) => person(o.id)!),
      memoriesAbout,
      tokens: item.type === 'person' && priv(c.id) ? h.tokens.filter((t) => t.contactId === c.id).map((t) => ({ ...t })) : null,
      canEdit: isAdmin() || (access() === 'member' && item.type === 'person'),
      canAdmin: isAdmin() && item.type === 'person',
    }
  }
  const contact = (id: string) => get<PersonRecordData>('contact', id)
  const link = (c: ApiRecord<PersonRecordData>, send: boolean) => {
    const slack = c.data.handles?.find((x) => x.system === 'slack')
    return {
      url: `${typeof location === 'undefined' ? 'http://localhost' : location.origin}/auth/login?token=mpl_mock${Math.random().toString(36).slice(2, 12)}`,
      expiresAt: new Date(db.now() + 15 * 60_000).toISOString(),
      ...(send && slack
        ? { sentVia: 'slack' as const }
        : {
            sentVia: null,
            notSent: slack ? 'Not sent: you asked to only show it.' : 'They have no Slack handle, so send it yourself.',
          }),
    }
  }
  const requests = new Map<string, string>()

  return {
    // ── Memory ──
    memories: (q = {}) => {
      const rows = all<MemoryRecordData>('memory')
        .map((m) => ({ m, item: memItem(m), about: aboutOf(m) }))
        .filter((r) => canSee(peopleOf(r.about)))
      const words = (q.text ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const shown = rows.filter(({ m, item }) => {
        const d = m.data
        if (q.employeeId === 'shared' ? !!d.employeeId : q.employeeId && d.employeeId !== q.employeeId) return false
        if (q.kind && d.kind !== q.kind) return false
        if (q.about && !item.about.some((a) => a.id === q.about)) return false
        if (q.taughtBy && d.source?.contactId !== q.taughtBy) return false
        if (q.sessionId && d.source?.sessionId !== q.sessionId) return false
        if (q.mine && !peopleOf(item.about).includes(me.id)) return false
        const hay = `${d.summary} ${d.content ?? ''} ${item.about.map((a) => a.name).join(' ')}`.toLowerCase()
        return words.every((w) => hay.includes(w))
      })
      const key = (r: (typeof rows)[number]) =>
        q.sort === 'used' ? (r.item.lastUsedAt ?? '') : q.sort === 'updated' ? r.m.updatedAt : r.m.createdAt
      shown.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0))
      const count = <K extends string>(keys: K[]) => {
        const out = new Map<K, number>()
        for (const k of keys) out.set(k, (out.get(k) ?? 0) + 1)
        return out
      }
      const emps = count(rows.map((r) => r.m.data.employeeId).filter((x): x is string => !!x))
      const kinds = count(rows.map((r) => r.m.data.kind))
      const subjects = new Map<string, KnowledgeRef & { count: number }>()
      for (const r of rows)
        for (const a of r.item.about) subjects.set(a.id, { ...a, count: (subjects.get(a.id)?.count ?? 0) + 1 })
      const teachers = count(rows.map((r) => r.m.data.source?.contactId).filter((x): x is string => !!x))
      const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)
      const offset = q.offset ?? 0
      return delay({
        items: shown.slice(offset, offset + (q.limit ?? 100)).map((r) => r.item),
        total: shown.length,
        facets: {
          employees: [...emps].map(([id, n]) => ({ ...employee(id)!, count: n })).sort(byName),
          shared: rows.filter((r) => !r.m.data.employeeId).length,
          kinds: MEMORY_KINDS.filter((k) => kinds.has(k)).map((k) => ({ kind: k, count: kinds.get(k)! })),
          subjects: [...subjects.values()].sort(byName),
          teachers: [...teachers]
            .map(([id, n]) => ({ ...person(id)!, count: n }))
            .filter((t) => t.kind === 'person')
            .sort(byName),
        },
      })
    },
    memory: (id) => {
      const m = visibleMemory(id)
      return m ? delay(memDetail(m)) : fail(404, 'not_found', `memory ${id} not found`)
    },
    createMemory: (body) => {
      if (access() === 'viewer') return fail(403, 'denied', 'members only: you are signed in as a viewer')
      if (!body.summary?.trim()) return fail(400, 'bad_request', 'summary is required')
      const existing = all<MemoryRecordData>('memory').find(
        (m) =>
          norm(m.data.summary) === norm(body.summary) &&
          (m.data.employeeId ?? '') === (body.employeeId ?? '') &&
          JSON.stringify(m.data.scope) === JSON.stringify(body.scope ?? { type: 'company' }),
      )
      const id = existing?.id ?? mockId('mem', 500 + map('memory').size)
      const m = write<MemoryRecordData>('memory', id, {
        ...(existing?.data ?? {}),
        summary: body.summary.trim(),
        kind: body.kind ?? 'fact',
        ...(body.content ? { content: body.content } : {}),
        scope: body.scope ?? { type: 'company' },
        source: existing?.data.source ?? { contactId: me.id },
        ...(body.employeeId ? { employeeId: body.employeeId } : {}),
      } as MemoryRecordData)
      if (body.about) setAbout(id, body.about)
      return delay({ created: !existing, memory: memDetail(m) })
    },
    updateMemory: (id, body) => {
      const m = visibleMemory(id)
      if (!m) return fail(404, 'not_found', `memory ${id} not found`)
      if (!canChange(peopleOf(aboutOf(m)))) return fail(403, 'denied', 'members change memories')
      if (body.version !== undefined && body.version !== m.version)
        return fail(409, 'conflict', 'someone changed this memory meanwhile: reload it and try again')
      if (body.note !== undefined && !body.note.trim()) return fail(400, 'bad_request', 'a correction needs a note')
      const next: MemoryRecordData = {
        ...m.data,
        ...(body.summary !== undefined ? { summary: body.summary } : {}),
        ...(body.kind ? { kind: body.kind } : {}),
        ...(body.content !== undefined ? { content: body.content || undefined } : {}),
        ...(body.scope ? { scope: body.scope } : {}),
        ...(body.employeeId !== undefined ? { employeeId: body.employeeId || undefined } : {}),
        ...(body.note ? { correction: { note: body.note, contactId: me.id, at: iso() }, verified: iso() } : {}),
      }
      const saved = write<MemoryRecordData>('memory', id, next)
      if (body.about) setAbout(id, body.about)
      return delay(memDetail(saved))
    },
    verifyMemory: (id) => {
      const m = visibleMemory(id)
      if (!m) return fail(404, 'not_found', `memory ${id} not found`)
      return delay(memDetail(write<MemoryRecordData>('memory', id, { ...m.data, verified: iso() })))
    },
    forgetMemory: (id) => {
      const m = visibleMemory(id)
      if (!m) return fail(404, 'not_found', `memory ${id} not found`)
      if (!canChange(peopleOf(aboutOf(m)))) return fail(403, 'denied', 'members change memories')
      map('memory').delete(id)
      db.links = db.links.filter((l) => l.from.id !== id && l.to.id !== id)
      return delay(undefined)
    },

    // ── Skills ──
    skills: (q = {}) => {
      const words = (q.text ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const items = all<SkillRecordData>('skill')
        .filter((k) => q.disabled !== false || k.data.enabled !== false)
        .filter((k) => words.every((w) => `${k.data.name} ${k.data.description} ${k.data.body}`.toLowerCase().includes(w)))
        .map(skillItem)
      const group = (i: SkillListItem) => (i.project ? `1${i.project.name.toLowerCase()}` : '0')
      items.sort((a, b) => group(a).localeCompare(group(b)) || a.skill.data.name.localeCompare(b.skill.data.name))
      return delay(items)
    },
    skill: (id) => {
      const k = get<SkillRecordData>('skill', id)
      return k ? delay(skillDetail(k)) : fail(404, 'not_found', `skill ${id} not found`)
    },
    createSkill: (body) => {
      if (access() === 'viewer') return fail(403, 'denied', 'members only')
      const scope = body.scope ?? { type: 'company' as const }
      if (nameTaken(body.name, scope))
        return fail(409, 'conflict', `There is already a skill called ${body.name} here. Pick another name, or edit that one.`)
      const id = mockId('skl', 100 + map('skill').size)
      const k = write<SkillRecordData>('skill', id, { ...body, scope } as SkillRecordData)
      return delay(skillDetail(k))
    },
    updateSkill: (id, body) => {
      const k = get<SkillRecordData>('skill', id)
      if (!k) return fail(404, 'not_found', `skill ${id} not found`)
      if (body.version !== undefined && body.version !== k.version)
        return fail(409, 'conflict', 'Someone else changed this skill meanwhile: copy your text, reload and try again.')
      const { version: _v, ...patch } = body
      const next = { ...k.data, ...patch } as SkillRecordData
      if (nameTaken(next.name, next.scope, id))
        return fail(409, 'conflict', `There is already a skill called ${next.name} here. Pick another name, or edit that one.`)
      return delay(skillDetail(write<SkillRecordData>('skill', id, next)))
    },
    restoreSkill: (id, version) => {
      const k = get<SkillRecordData>('skill', id)
      const rev = (db.revisions.get(id) ?? []).find((r) => r.version === version)
      if (!k || !rev?.data) return fail(404, 'not_found', `version ${version} of skill ${id} not found`)
      const old = rev.data as SkillRecordData
      return delay(
        skillDetail(
          write<SkillRecordData>('skill', id, {
            ...k.data,
            name: old.name,
            description: old.description,
            whenToUse: old.whenToUse,
            body: old.body,
          }),
        ),
      )
    },
    deleteSkill: (id) => {
      if (!get('skill', id)) return fail(404, 'not_found', `skill ${id} not found`)
      map('skill').delete(id)
      return delay(undefined)
    },

    // ── People ──
    people: (q = {}) => {
      const words = (q.text ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const items = all<PersonRecordData>('contact')
        .sort((a, b) => a.data.name.localeCompare(b.data.name))
        .map(personItem)
        .filter((p) => {
          const d = p.contact.data
          if (q.type && p.type !== q.type) return false
          if (q.access && p.access !== q.access) return false
          if (q.team && norm(d.team ?? '') !== norm(q.team)) return false
          if (q.deactivated === false && p.deactivated) return false
          const hay = [d.name, d.email, d.role, d.team, ...(d.handles ?? []).map((x) => x.id)].join(' ').toLowerCase()
          return words.every((w) => hay.includes(w))
        })
      return delay(items)
    },
    person: (id) => {
      const c = contact(id)
      return c ? delay(personDetail(c)) : fail(404, 'not_found', `person ${id} not found`)
    },
    createPerson: (body) => {
      if (!isAdmin()) return fail(403, 'denied', 'admins only')
      if (body.idempotencyKey && requests.has(body.idempotencyKey))
        return delay({ created: false, person: personDetail(contact(requests.get(body.idempotencyKey)!)!) })
      if (!body.name?.trim()) return fail(400, 'bad_request', 'name is required')
      const email = body.email?.trim().toLowerCase()
      const other = email && all<PersonRecordData>('contact').find((c) => c.data.email?.toLowerCase() === email)
      if (other) return fail(409, 'conflict', `${other.data.name} already has the email ${email}`)
      const id = mockId('con', 200 + map('contact').size)
      const c = write<PersonRecordData>('contact', id, {
        name: body.name.trim(),
        kind: 'person',
        access: body.access ?? 'viewer',
        ...(email ? { email } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(body.team ? { team: body.team } : {}),
        ...(body.manager ? { manager: body.manager } : {}),
        ...(body.handles?.length ? { handles: body.handles } : {}),
      })
      if (body.idempotencyKey) requests.set(body.idempotencyKey, id)
      return delay({ created: true, person: personDetail(c), ...(body.sendSignInLink ? { signInLink: link(c, true) } : {}) })
    },
    updatePerson: (id, body) => {
      const c = contact(id)
      if (!c) return fail(404, 'not_found', `person ${id} not found`)
      if (body.access !== undefined && !isAdmin()) return fail(403, 'denied', "only admins can change someone's access")
      if (body.version !== undefined && body.version !== c.version)
        return fail(409, 'conflict', 'someone else changed them meanwhile')
      const { version: _v, ...patch } = body
      const next = { ...c.data } as Record<string, unknown>
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') delete next[k]
        else next[k] = v
      }
      return delay(personDetail(write<PersonRecordData>('contact', id, next as PersonRecordData)))
    },
    personSignInLink: (id, opts = {}) => {
      const c = contact(id)
      if (!c) return fail(404, 'not_found', `person ${id} not found`)
      if (c.data.deactivatedAt) return fail(422, 'validation', 'they are deactivated: reactivate them first')
      return delay(link(c, opts.send !== false))
    },
    deactivatePerson: (id) => {
      const c = contact(id)
      if (!c) return fail(404, 'not_found', `person ${id} not found`)
      if (id === me.id) return fail(422, 'validation', "you can't deactivate yourself: ask another admin")
      for (const t of h.tokens) if (t.contactId === id) t.revoked = true
      return delay(
        personDetail(write<PersonRecordData>('contact', id, { ...c.data, deactivatedAt: iso(), deactivatedBy: me.id })),
      )
    },
    reactivatePerson: (id) => {
      const c = contact(id)
      if (!c) return fail(404, 'not_found', `person ${id} not found`)
      const { deactivatedAt: _a, deactivatedBy: _b, ...rest } = c.data
      return delay(personDetail(write<PersonRecordData>('contact', id, rest as PersonRecordData)))
    },
  }
}
