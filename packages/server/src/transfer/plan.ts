import { ValidationError, errorMessage, idPrefix, newId, validateRecord } from '@mp/core'
import { ProjectRoles, slugify, type ContactData, type Handle } from '@mp/directory'
import { normalizeSummary, type MemoryData } from '@mp/memory'
import type { StoredRecord } from '@mp/store'
import { comparable, listAll, remapIds, sameValue, skillKey } from './common.ts'
import { parseCsv, type CsvRow } from './csv.ts'
import { parseMarkdown } from './frontmatter.ts'
import {
  INDEX_FORMAT,
  KIND_ORDER,
  type FieldChange,
  type ImportPlan,
  type ImportSource,
  type IndexLink,
  type PlanCounts,
  type PlanIssue,
  type PlanItem,
  type TransferKind,
  type TransferServices,
  type Tree,
} from './types.ts'

type RecordKind = Exclude<TransferKind, 'link'>

/** Which field a file's markdown body is. */
export const BODY_FIELD: Record<RecordKind, string> = {
  contact: 'bio',
  employee: 'instructions',
  project: 'description',
  procedure: 'body',
  skill: 'body',
  doc: 'body',
  memory: 'content',
}

interface Member {
  /** A contact id from the source (a file id), or an existing contact id. */
  contact: string
  role: string
  data?: Record<string, unknown>
}

/** One record read from a source, before it's matched against the store. */
interface Incoming {
  kind: RecordKind
  source: string
  line?: number
  /** The id it had where it came from (folder imports); CSV rows get a synthetic one. */
  fileId: string
  data: Record<string, unknown>
  label: string
  /** CSV rows only set fields; handles are merged into the existing ones. */
  partial?: boolean
  members?: Member[]
  /** CSV contacts: the manager, resolved after every contact is matched. */
  managerEmail?: string
  /** CSV projects: owner and members by email. */
  memberEmails?: { email: string; role: string }[]
  /** Folder docs: the project folder they're in. */
  projectSlug?: string
  /** Folder skills: the scope folder they're in. */
  scopeFolder?: string
  /** Set once matched. */
  targetId?: string
  existing?: StoredRecord | null
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ─── Reading sources ───────────────────────────────────────────────────────

const PATTERNS: [RegExp, RecordKind][] = [
  [/^contacts\/[^/]+\.md$/, 'contact'],
  [/^employees\/[^/]+\.md$/, 'employee'],
  [/^projects\/[^/]+\.md$/, 'project'],
  [/^projects\/[^/]+\/docs\/.+\.md$/, 'doc'],
  [/^procedures\/[^/]+\.md$/, 'procedure'],
  [/^skills\/[^/]+\/[^/]+\.md$/, 'skill'],
  [/^memories\/[^/]+\.md$/, 'memory'],
]

const LABEL_FIELD: Record<RecordKind, string> = {
  contact: 'name',
  employee: 'name',
  project: 'name',
  procedure: 'name',
  skill: 'name',
  doc: 'title',
  memory: 'summary',
}

function readFolder(tree: Tree, errors: PlanIssue[], warnings: PlanIssue[]): { items: Incoming[]; links: IndexLink[] } {
  const items: Incoming[] = []
  let links: IndexLink[] = []
  let synthetic = 0
  for (const [path, text] of tree) {
    if (path === 'index.json') {
      try {
        const idx = JSON.parse(text)
        if (idx?.format !== INDEX_FORMAT)
          warnings.push({ source: path, message: `unknown format ${JSON.stringify(idx?.format)}` })
        links = Array.isArray(idx?.links) ? idx.links : []
      } catch (e) {
        errors.push({ source: path, message: `not valid JSON: ${errorMessage(e)}` })
      }
      continue
    }
    const kind = PATTERNS.find(([re]) => re.test(path))?.[1]
    if (!kind) {
      if (path.endsWith('.md')) warnings.push({ source: path, message: 'not a known place in the export folder: ignored' })
      continue
    }
    let doc: ReturnType<typeof parseMarkdown>
    try {
      doc = parseMarkdown(text, path)
    } catch (e) {
      errors.push({ source: path, message: errorMessage(e) })
      continue
    }
    const { id, members, ...data } = doc.fields as Record<string, unknown>
    for (const [k, v] of Object.entries(data)) if (v === null) delete data[k]
    if (doc.body) data[BODY_FIELD[kind]] = doc.body
    const item: Incoming = {
      kind,
      source: path,
      fileId: typeof id === 'string' && id ? id : `new_${++synthetic}`,
      data,
      label: String(data[LABEL_FIELD[kind]] ?? path),
    }
    if (kind === 'project' && members !== undefined) {
      if (!Array.isArray(members)) {
        errors.push({ source: path, message: 'members must be a list of {contact, role}' })
        continue
      }
      item.members = members.map((m: any) => ({
        contact: String(m?.contact ?? ''),
        role: String(m?.role ?? ProjectRoles.member),
        ...(m?.data && typeof m.data === 'object' ? { data: m.data } : {}),
      }))
    }
    if (kind === 'contact') data.kind ??= 'person'
    if (kind === 'doc') item.projectSlug = path.split('/')[1]
    if (kind === 'skill') item.scopeFolder = path.split('/')[1]
    items.push(item)
  }
  return { items, links }
}

function csvRows(text: string, source: string, required: string[], errors: PlanIssue[]): CsvRow[] {
  const { headers, rows } = parseCsv(text)
  const missing = required.filter((h) => !headers.includes(h))
  if (missing.length) {
    errors.push({ source, message: `missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}` })
    return []
  }
  return rows
}

const col = (r: CsvRow, ...names: string[]) => {
  for (const n of names) if (r.values[n]) return r.values[n]
  return undefined
}

function readContactsCsv(text: string, source: string, errors: PlanIssue[]): Incoming[] {
  const out: Incoming[] = []
  const seen = new Map<string, number>()
  for (const r of csvRows(text, source, ['name'], errors)) {
    const bad = (message: string) => errors.push({ source, line: r.line, message })
    const name = col(r, 'name')
    const email = col(r, 'email')?.toLowerCase()
    const slack = col(r, 'slackhandle', 'slack', 'slackid')?.replace(/^@/, '')
    const managerEmail = col(r, 'manageremail', 'manager')?.toLowerCase()
    if (!name) {
      bad('name is required')
      continue
    }
    if (email && !EMAIL.test(email)) {
      bad(`invalid email ${JSON.stringify(email)}`)
      continue
    }
    if (managerEmail && !EMAIL.test(managerEmail)) {
      bad(`invalid manager email ${JSON.stringify(managerEmail)}`)
      continue
    }
    if (slack && /\s/.test(slack)) {
      bad(`invalid slack handle ${JSON.stringify(slack)}`)
      continue
    }
    const dupKey = email ?? `name:${name.toLowerCase()}`
    if (seen.has(dupKey)) {
      bad(`duplicate of line ${seen.get(dupKey)} (${email ? `email ${email}` : `name ${name}`})`)
      continue
    }
    seen.set(dupKey, r.line)
    const data: Record<string, unknown> = { name }
    if (email) data.email = email
    for (const f of ['role', 'team', 'permissions']) {
      const v = col(r, f)
      if (v) data[f] = v
    }
    if (slack) data.handles = [{ system: 'slack', id: slack }]
    out.push({
      kind: 'contact',
      source,
      line: r.line,
      fileId: `csv_contact_${r.line}`,
      data,
      label: name,
      partial: true,
      ...(managerEmail ? { managerEmail } : {}),
    })
  }
  return out
}

function readProjectsCsv(text: string, source: string, errors: PlanIssue[]): Incoming[] {
  const out: Incoming[] = []
  const seen = new Map<string, number>()
  for (const r of csvRows(text, source, ['name'], errors)) {
    const bad = (message: string) => errors.push({ source, line: r.line, message })
    const name = col(r, 'name')
    if (!name) {
      bad('name is required')
      continue
    }
    if (seen.has(name.toLowerCase())) {
      bad(`duplicate of line ${seen.get(name.toLowerCase())} (project ${name})`)
      continue
    }
    seen.set(name.toLowerCase(), r.line)
    const memberEmails: { email: string; role: string }[] = []
    const owner = col(r, 'owneremail', 'owner')?.toLowerCase()
    if (owner) memberEmails.push({ email: owner, role: ProjectRoles.owner })
    let broken = false
    for (const part of (col(r, 'members') ?? '').split(/[;\n]/)) {
      const p = part.trim()
      if (!p) continue
      const [email, role] = p.split(':').map((x) => x.trim())
      const e = email?.toLowerCase()
      if (!e || !EMAIL.test(e)) {
        bad(`invalid member ${JSON.stringify(p)}: expected email:role`)
        broken = true
        break
      }
      memberEmails.push({ email: e, role: role || ProjectRoles.member })
    }
    if (broken) continue
    if (owner && !EMAIL.test(owner)) {
      bad(`invalid owner email ${JSON.stringify(owner)}`)
      continue
    }
    const data: Record<string, unknown> = { name }
    const description = col(r, 'description')
    if (description) data.description = description
    out.push({
      kind: 'project',
      source,
      line: r.line,
      fileId: `csv_project_${r.line}`,
      data,
      label: name,
      partial: true,
      memberEmails,
    })
  }
  return out
}

// ─── Planning ──────────────────────────────────────────────────────────────

const normHandle = (h: Handle): Handle => ({ system: String(h.system).trim().toLowerCase(), id: String(h.id).trim() })

/** Contact data as the directory stores it (lowercased email, normalised handles). */
function normalizeContact(d: Record<string, unknown>) {
  const out = { ...d }
  if (typeof d.email === 'string') out.email = d.email.trim().toLowerCase()
  if (Array.isArray(d.handles)) out.handles = (d.handles as Handle[]).map(normHandle)
  return out
}

const emptyCounts = (): PlanCounts => ({ create: 0, update: 0, unchanged: 0 })

/**
 * Plans an import without changing anything: every record is matched against
 * the store (by id, then email, then handle, then name, depending on the kind)
 * and becomes a create, an update (with the changed fields) or unchanged.
 * Rows and files that don't validate are reported in `errors` and left out.
 */
export async function planImport(s: TransferServices, source: ImportSource): Promise<ImportPlan> {
  const { records, directory } = s
  const errors: PlanIssue[] = []
  const warnings: PlanIssue[] = []
  const incoming: Incoming[] = []
  let indexLinks: IndexLink[] = []
  if (source.tree) {
    const f = readFolder(source.tree, errors, warnings)
    incoming.push(...f.items)
    indexLinks = f.links
  }
  if (source.contactsCsv !== undefined)
    incoming.push(...readContactsCsv(source.contactsCsv, source.names?.contacts ?? 'contacts.csv', errors))
  if (source.projectsCsv !== undefined)
    incoming.push(...readProjectsCsv(source.projectsCsv, source.names?.projects ?? 'projects.csv', errors))

  const idMap = new Map<string, string>()
  const claimed = new Map<string, Incoming>()
  const issue = (it: Incoming, message: string): PlanIssue => ({
    source: it.source,
    ...(it.line !== undefined ? { line: it.line } : {}),
    message,
  })
  const dropped = new Set<Incoming>()
  const drop = (it: Incoming, message: string) => {
    errors.push(issue(it, message))
    dropped.add(it)
  }
  const mapped = (id: unknown) => (typeof id === 'string' ? (idMap.get(id) ?? id) : id)

  // Duplicate ids within the source.
  const byFileId = new Map<string, Incoming>()
  for (const it of incoming) {
    if (byFileId.has(it.fileId)) drop(it, `duplicate id ${it.fileId} (also in ${byFileId.get(it.fileId)!.source})`)
    else byFileId.set(it.fileId, it)
  }

  const byId = async (it: Incoming) => (it.partial ? null : records.get(it.kind, it.fileId))
  const uniqueByName = async (kind: string, field: string, name: string) => {
    const n = name.trim().toLowerCase()
    if (!n) return null
    const { items } = await records.query(kind, { text: n })
    const hits = items.filter((r) => String(r.data[field] ?? '').toLowerCase() === n)
    return hits.length === 1 ? hits[0]! : null
  }
  let memoryCache: StoredRecord<MemoryData>[] | null = null

  const matchers: Record<RecordKind, (it: Incoming) => Promise<StoredRecord | null>> = {
    async contact(it) {
      const d = normalizeContact(it.data)
      if (!it.partial) {
        const r = await byId(it)
        if (r) return r
      }
      if (typeof d.email === 'string') {
        const r = await directory.contacts.byEmail(d.email)
        if (r) return r
      }
      for (const h of (d.handles as Handle[] | undefined) ?? []) {
        const r = await directory.contacts.byHandle(h.system, h.id)
        if (r) return r
      }
      return typeof d.name === 'string' ? uniqueByName('contact', 'name', d.name) : null
    },
    async employee(it) {
      const r = await byId(it)
      if (r) return r
      return typeof it.data.name === 'string' ? directory.employees.byHandle(it.data.name) : null
    },
    async project(it) {
      if (!it.partial) {
        const r = await byId(it)
        if (r) return r
      }
      return typeof it.data.name === 'string' ? directory.projects.byName(it.data.name) : null
    },
    async procedure(it) {
      const r = await byId(it)
      if (r) return r
      return typeof it.data.name === 'string' ? uniqueByName('procedure', 'name', it.data.name) : null
    },
    async skill(it) {
      const r = await byId(it)
      if (r) return r
      const scope = remapIds(it.data.scope, idMap) as any
      if (typeof it.data.name !== 'string' || !scope?.type) return null
      return records.getByKey('skill', skillKey({ name: it.data.name, scope }))
    },
    async doc(it) {
      const r = await byId(it)
      if (r) return r
      const owner = remapIds(it.data.owner, idMap) as any
      if (!owner?.id) return null
      const docs = await s.docs.forOwner(owner, typeof it.data.path === 'string' ? it.data.path : undefined)
      const hits = typeof it.data.path === 'string' ? docs : docs.filter((d) => d.data.title === it.data.title && !d.data.path)
      return hits[0] ?? null
    },
    async memory(it) {
      const r = await byId(it)
      if (r) return r
      if (typeof it.data.summary !== 'string') return null
      memoryCache ??= await listAll<MemoryData>(records, 'memory')
      const d = remapIds(it.data, idMap) as Partial<MemoryData>
      const want = normalizeSummary(it.data.summary)
      return (
        memoryCache.find(
          (m) =>
            normalizeSummary(m.data.summary) === want &&
            m.data.scope.type === (d.scope?.type ?? 'company') &&
            (m.data.scope.id ?? '') === (d.scope?.id ?? '') &&
            (m.data.employeeId ?? '') === (d.employeeId ?? ''),
        ) ?? null
      )
    },
  }

  const projectBySlug = new Map<string, Incoming>()
  for (const it of incoming)
    if (it.kind === 'project' && !it.partial) projectBySlug.set(it.source.replace(/^projects\//, '').replace(/\.md$/, ''), it)

  // Phase 1: match every record, kind by kind, so later kinds can use earlier ids.
  for (const kind of KIND_ORDER) {
    if (kind === 'link') continue
    for (const it of incoming.filter((x) => x.kind === kind && !dropped.has(x))) {
      if (kind === 'doc') {
        const project = projectBySlug.get(it.projectSlug ?? '')
        if (!project) {
          drop(it, `no project file projects/${it.projectSlug}.md for this doc`)
          continue
        }
        it.data.owner = { kind: 'project', id: project.fileId }
      }
      if (kind === 'skill' && !it.data.scope) {
        const project = it.scopeFolder === 'company' ? null : projectBySlug.get(it.scopeFolder ?? '')
        it.data.scope = project ? { type: 'project', projectId: project.fileId } : { type: 'company' }
      }
      let existing: StoredRecord | null
      try {
        existing = await matchers[kind](it)
      } catch (e) {
        drop(it, errorMessage(e))
        continue
      }
      if (existing && claimed.has(existing.id)) {
        drop(it, `matches the same ${kind} (${existing.id}) as ${claimed.get(existing.id)!.source}`)
        continue
      }
      let target = existing?.id
      if (!target) {
        const prefix = records.kinds.get(kind).prefix ?? kind.slice(0, 3)
        const free = !it.partial && idPrefix(it.fileId) === prefix && !(await records.find(it.fileId))
        target = free ? it.fileId : newId(prefix)
      }
      it.existing = existing
      it.targetId = target
      claimed.set(target, it)
      idMap.set(it.fileId, target)
    }
  }

  // Emails of planned and stored contacts, for CSV managers, owners and members.
  const plannedEmail = new Map<string, string>()
  for (const it of incoming)
    if (it.kind === 'contact' && it.targetId && !dropped.has(it)) {
      const e = normalizeContact(it.data).email
      if (typeof e === 'string') plannedEmail.set(e, it.targetId)
    }
  const contactByEmail = async (email: string) => plannedEmail.get(email) ?? (await directory.contacts.byEmail(email))?.id

  const items: PlanItem[] = []
  const planned = new Set<string>()

  // Phase 2: final data, validation and the diff against what's stored.
  for (const kind of KIND_ORDER) {
    if (kind === 'link') continue
    for (const it of incoming.filter((x) => x.kind === kind && x.targetId && !dropped.has(x))) {
      let data = remapIds(it.data, idMap)
      if (kind === 'contact') {
        data = normalizeContact(data)
        if (it.managerEmail) {
          const m = await contactByEmail(it.managerEmail)
          if (m) data.manager = m
          else warnings.push(issue(it, `manager ${it.managerEmail} is not a known contact: left unset`))
        }
        if (it.partial && Array.isArray(data.handles) && it.existing) {
          // A CSV row sets one handle per system: it replaces that system's handle in place and keeps the others.
          const fresh = new Map((data.handles as Handle[]).map((h) => [h.system, h]))
          const merged: Handle[] = []
          for (const h of (it.existing.data as ContactData).handles ?? []) {
            const n = fresh.get(h.system)
            if (!n) merged.push(h)
            else if (!merged.some((m) => m.system === h.system)) merged.push(n)
          }
          for (const h of fresh.values()) if (!merged.some((m) => m.system === h.system)) merged.push(h)
          data.handles = merged
        }
        if (!it.existing) data.kind ??= 'person'
        if (it.existing && it.existing.data.kind !== data.kind && !it.partial) {
          drop(it, `matches ${it.existing.id}, which is a ${String(it.existing.data.kind)} contact, not a ${String(data.kind)}`)
          continue
        }
      }
      if (kind === 'employee') {
        const contactId = mapped(data.contactId)
        if (typeof contactId !== 'string' || !(claimed.has(contactId) || (await records.get('contact', contactId)))) {
          drop(it, `its contact ${String(it.data.contactId)} is neither in the import nor stored`)
          continue
        }
        if (it.existing && it.existing.data.contactId !== contactId) {
          warnings.push(issue(it, `the employee keeps its contact ${String(it.existing.data.contactId)}`))
          delete data.contactId
        }
      }
      if (kind === 'project' && it.memberEmails) {
        const members: Member[] = []
        let missing: string | undefined
        for (const m of it.memberEmails) {
          const c = await contactByEmail(m.email)
          if (!c) {
            missing = m.email
            break
          }
          members.push({ contact: c, role: m.role })
        }
        if (missing) {
          drop(it, `${missing} is not a known contact`)
          continue
        }
        it.members = members
      }

      const schema = records.kinds.get(kind)
      const merged = it.existing ? { ...it.existing.data, ...data } : data
      try {
        validateRecord(schema, merged)
        if (kind === 'employee' && !slugify(String(merged.name ?? '')))
          throw new ValidationError('name must contain letters or digits')
        if (kind === 'skill') {
          const sc = merged.scope as any
          if (sc?.type === 'project' && !sc.projectId) throw new ValidationError('a project skill needs scope.projectId')
        }
      } catch (e) {
        drop(it, errorMessage(e))
        continue
      }

      const changes: FieldChange[] = []
      let patch: Record<string, unknown> = {}
      if (!it.existing) {
        for (const k of Object.keys(data).sort()) changes.push({ field: k, to: data[k] })
        patch = data
      } else {
        for (const k of Object.keys(data).sort()) {
          if (sameValue(it.existing.data[k], data[k])) continue
          changes.push({ field: k, from: it.existing.data[k], to: data[k] })
          patch[k] = data[k]
        }
      }
      const op = !it.existing ? 'create' : changes.length ? 'update' : 'unchanged'
      const key = kind === 'employee' ? slugify(String(merged.name)) : kind === 'skill' ? skillKey(merged as any) : undefined
      items.push({
        kind,
        op,
        id: it.targetId!,
        label: it.label,
        source: it.line !== undefined ? `${it.source}:${it.line}` : it.source,
        data: op === 'unchanged' ? {} : patch,
        changes,
        ...(op === 'create' && key ? { key } : {}),
      })
      planned.add(it.targetId!)
    }
  }

  const exists = async (kind: string, id: string) => planned.has(id) || !!(await records.get(kind, id))
  const labelOf = new Map(items.map((i) => [i.id, i.label]))
  const nameOf = async (kind: string, id: string) => {
    const l = labelOf.get(id)
    if (l) return l
    const r = await records.get(kind, id)
    return String(r?.data.name ?? r?.data.title ?? r?.data.summary ?? id)
  }

  // Memberships: added (never removed); an owner replaces the project's other owners.
  for (const it of incoming.filter((x) => x.kind === 'project' && x.members && planned.has(x.targetId ?? ''))) {
    const project = it.targetId!
    for (const m of it.members!) {
      const contact = mapped(m.contact) as string
      const src = it.line !== undefined ? `${it.source}:${it.line}` : it.source
      if (!(await exists('contact', contact))) {
        errors.push(issue(it, `member ${m.contact} (${m.role}) was not imported and isn't stored: that membership is skipped`))
        continue
      }
      const link: IndexLink = {
        from: { kind: 'contact', id: contact },
        to: { kind: 'project', id: project },
        role: m.role,
        ...(m.data ? { data: m.data } : {}),
      }
      const have = it.existing ? await records.links({ from: link.from, to: link.to, role: m.role }) : []
      const changes: FieldChange[] = []
      if (m.role === ProjectRoles.owner && it.existing) {
        const others = (await records.links({ to: link.to, role: ProjectRoles.owner })).filter((l) => l.from.id !== contact)
        for (const o of others)
          changes.push({ field: 'owner', from: await nameOf('contact', o.from.id), to: await nameOf('contact', contact) })
      }
      const op = have.length && !changes.length ? 'unchanged' : 'create'
      items.push({
        kind: 'link',
        op,
        id: contact,
        label: `${await nameOf('contact', contact)} -> ${await nameOf('project', project)} (${m.role})`,
        source: src,
        data: {},
        changes: op === 'unchanged' ? [] : changes.length ? changes : [{ field: 'role', to: m.role }],
        link,
      })
    }
  }

  // The other links from index.json.
  const seenLinks = new Set<string>()
  for (const raw of indexLinks) {
    const from = raw?.from
    const to = raw?.to
    if (!from?.kind || !from?.id || !to?.kind || !to?.id || typeof raw.role !== 'string') {
      errors.push({ source: 'index.json', message: `malformed link ${comparable(raw)}` })
      continue
    }
    const link: IndexLink = {
      from: { kind: from.kind, id: mapped(from.id) as string },
      to: { kind: to.kind, id: mapped(to.id) as string },
      role: raw.role,
      ...(raw.data ? { data: raw.data } : {}),
    }
    const k = `${link.from.id} ${link.role} ${link.to.id}`
    if (seenLinks.has(k)) continue
    seenLinks.add(k)
    if (!(await exists(link.from.kind, link.from.id)) || !(await exists(link.to.kind, link.to.id))) {
      warnings.push({ source: 'index.json', message: `link ${from.id} -${raw.role}-> ${to.id}: an end is missing, skipped` })
      continue
    }
    const have = await records.links({ from: link.from, to: link.to, role: link.role })
    const op = have.length ? 'unchanged' : 'create'
    items.push({
      kind: 'link',
      op,
      id: link.from.id,
      label: `${await nameOf(link.from.kind, link.from.id)} -${link.role}-> ${await nameOf(link.to.kind, link.to.id)}`,
      source: 'index.json',
      data: {},
      changes: op === 'create' ? [{ field: 'role', to: link.role }] : [],
      link,
    })
  }

  return { items, errors, warnings, ...countPlan(items) }
}

/** Totals and per-kind totals of a plan's items. */
export function countPlan(items: PlanItem[]): Pick<ImportPlan, 'counts' | 'byKind'> {
  const counts = emptyCounts()
  const byKind: ImportPlan['byKind'] = {}
  for (const i of items) {
    counts[i.op]++
    const k = (byKind[i.kind] ??= emptyCounts())
    k[i.op]++
  }
  return { counts, byKind }
}
