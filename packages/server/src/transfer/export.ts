import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ValidationError } from '@mp/core'
import { APPLIES_TO, IDENTITY, type ContactData, type EmployeeData, type ProcedureData, type ProjectData } from '@mp/directory'
import type { MemoryData } from '@mp/memory'
import { MENTIONS, type DocData } from '@mp/records'
import type { SkillData } from '@mp/skills'
import type { Link, StoredRecord } from '@mp/store'
import { assignSlugs, exportable, listAll, orderedFields, safeDocPath } from './common.ts'
import { stringifyMarkdown } from './frontmatter.ts'
import {
  INDEX_FORMAT,
  INDEX_VERSION,
  type IndexEntry,
  type IndexLink,
  type KnowledgeIndex,
  type TransferServices,
  type Tree,
} from './types.ts'

/** Top-level entries of an export folder, the only ones `exportKnowledge` replaces. */
export const MANAGED_PATHS = ['contacts', 'employees', 'projects', 'procedures', 'skills', 'memories', 'index.json']

/** Link roles kept automatically from record data, so they aren't exported as links. */
const DERIVED_ROLES = new Set([MENTIONS, IDENTITY, APPLIES_TO])

const pick = (kind: string, data: Record<string, unknown>, omit: string[]) =>
  Object.fromEntries(Object.entries(data).filter(([k]) => !omit.includes(k) && exportable(kind, k)))

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/**
 * The knowledge base as a tree of markdown files with frontmatter, plus
 * `index.json`. The output is deterministic: files and fields are sorted, and
 * the only timestamps are record fields (no created/updated times, no versions).
 */
export async function exportTree(s: TransferServices): Promise<Tree> {
  const { records } = s
  const files: { path: string; content: string }[] = []
  const index: IndexEntry[] = []
  const add = (kind: IndexEntry['kind'], id: string, path: string, content: string) => {
    files.push({ path, content })
    index.push({ kind, id, path })
  }

  const contacts = await listAll<ContactData>(records, 'contact')
  const employees = await listAll<EmployeeData>(records, 'employee')
  const projects = await listAll<ProjectData>(records, 'project')
  const procedures = await listAll<ProcedureData>(records, 'procedure')
  const skills = await listAll<SkillData>(records, 'skill')
  const memories = await listAll<MemoryData>(records, 'memory')
  const docs = await listAll<DocData>(records, 'doc')

  const contactSlugs = assignSlugs(contacts, (c) => c.data.name, 'contact')
  for (const c of contacts) {
    const fields = orderedFields(c.id, pick('contact', c.data, ['bio']))
    add('contact', c.id, `contacts/${contactSlugs.get(c.id)}.md`, stringifyMarkdown(fields, c.data.bio ?? ''))
  }

  const employeeSlugs = assignSlugs(employees, (e) => e.key ?? e.data.name, 'employee')
  for (const e of employees) {
    const fields = orderedFields(e.id, pick('employee', e.data, ['instructions']))
    add('employee', e.id, `employees/${employeeSlugs.get(e.id)}.md`, stringifyMarkdown(fields, e.data.instructions ?? ''))
  }

  const projectSlugs = assignSlugs(projects, (p) => p.data.name, 'project')
  const projectIds = new Set(projects.map((p) => p.id))
  for (const p of projects) {
    const slug = projectSlugs.get(p.id)!
    const links = await records.links({ to: { kind: 'project', id: p.id } })
    const members = links
      .filter((l) => l.from.kind === 'contact' && !DERIVED_ROLES.has(l.role))
      .map((l) => ({ contact: l.from.id, role: l.role, ...(Object.keys(l.data ?? {}).length ? { data: l.data } : {}) }))
      .sort((a, b) => (a.contact < b.contact ? -1 : a.contact > b.contact ? 1 : a.role < b.role ? -1 : a.role > b.role ? 1 : 0))
    const fields = orderedFields(p.id, { ...pick('project', p.data, ['description']), ...(members.length ? { members } : {}) })
    add('project', p.id, `projects/${slug}.md`, stringifyMarkdown(fields, p.data.description ?? ''))

    const own = docs.filter((d) => d.data.owner?.kind === 'project' && d.data.owner.id === p.id)
    const used = new Set<string>()
    for (const d of own) {
      const base = safeDocPath(d.data.path, d.data.title, d.id)
      let path = base
      for (let n = 2; used.has(path); n++) path = `${base}-${n}`
      used.add(path)
      const docFields = orderedFields(d.id, pick('doc', d.data, ['body', 'owner']))
      add('doc', d.id, `projects/${slug}/docs/${path}.md`, stringifyMarkdown(docFields, d.data.body))
    }
  }

  const procedureSlugs = assignSlugs(procedures, (p) => p.data.name, 'procedure')
  for (const p of procedures) {
    const fields = orderedFields(p.id, pick('procedure', p.data, ['body']))
    add('procedure', p.id, `procedures/${procedureSlugs.get(p.id)}.md`, stringifyMarkdown(fields, p.data.body ?? ''))
  }

  const skillScope = (sk: StoredRecord<SkillData>) =>
    sk.data.scope.type === 'company'
      ? 'company'
      : projectIds.has(sk.data.scope.projectId ?? '')
        ? projectSlugs.get(sk.data.scope.projectId!)!
        : `project-${sk.data.scope.projectId}`
  const scopes = new Map<string, StoredRecord<SkillData>[]>()
  for (const sk of skills) scopes.set(skillScope(sk), [...(scopes.get(skillScope(sk)) ?? []), sk])
  for (const [scope, list] of scopes) {
    const slugs = assignSlugs(list, (sk) => sk.data.name, 'skill')
    for (const sk of list) {
      const fields = orderedFields(sk.id, pick('skill', sk.data, ['body']))
      add('skill', sk.id, `skills/${scope}/${slugs.get(sk.id)}.md`, stringifyMarkdown(fields, sk.data.body))
    }
  }

  for (const m of memories) {
    const fields = orderedFields(m.id, pick('memory', m.data, ['content']))
    add('memory', m.id, `memories/${m.id}.md`, stringifyMarkdown(fields, m.data.content ?? ''))
  }

  // Links between exported records that no file shows: memory "about" links and anything else.
  const exported = new Set(index.map((e) => e.id))
  const seen = new Set<string>()
  const links: IndexLink[] = []
  for (const e of index) {
    for (const l of await records.links({ from: { kind: e.kind, id: e.id } })) {
      if (seen.has(l.id) || !exported.has(l.to.id) || DERIVED_ROLES.has(l.role)) continue
      if (l.from.kind === 'contact' && l.to.kind === 'project') continue // in the project's members
      seen.add(l.id)
      links.push(indexLink(l))
    }
  }
  links.sort((a, b) => {
    const ka = `${a.from.id} ${a.role} ${a.to.id}`
    const kb = `${b.from.id} ${b.role} ${b.to.id}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

  const idx: KnowledgeIndex = { format: INDEX_FORMAT, version: INDEX_VERSION, records: index.sort(byPath), links }
  files.push({ path: 'index.json', content: `${JSON.stringify(idx, null, 2)}\n` })
  return new Map(files.sort(byPath).map((f) => [f.path, f.content]))
}

const indexLink = (l: Link): IndexLink => ({
  from: { kind: l.from.kind, id: l.from.id },
  to: { kind: l.to.kind, id: l.to.id },
  role: l.role,
  ...(Object.keys(l.data ?? {}).length ? { data: l.data } : {}),
})

/** Whether a folder may be (re)written: missing, empty, or a previous export. */
function writable(dir: string): boolean {
  if (!existsSync(dir)) return true
  if (readdirSync(dir).length === 0) return true
  const idx = join(dir, 'index.json')
  if (!existsSync(idx)) return false
  try {
    return JSON.parse(readFileSync(idx, 'utf8')).format === INDEX_FORMAT
  } catch {
    return false
  }
}

/** Writes a tree into `dir`. The folder's managed entries are replaced, so records deleted since the last export disappear. */
export function writeTree(tree: Tree, dir: string, opts: { force?: boolean } = {}) {
  if (!opts.force && !writable(dir))
    throw new ValidationError(`${dir} is not empty and is not a previous export (no index.json): refusing to write into it`)
  mkdirSync(dir, { recursive: true })
  for (const p of MANAGED_PATHS) rmSync(join(dir, p), { recursive: true, force: true })
  for (const [path, content] of tree) {
    const full = join(dir, ...path.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

/** Exports the knowledge base into `dir` (see `exportTree` and `writeTree`). Returns the number of files written. */
export async function exportKnowledge(
  s: TransferServices,
  dir: string,
  opts: { force?: boolean } = {},
): Promise<{ files: number }> {
  const tree = await exportTree(s)
  writeTree(tree, dir, opts)
  return { files: tree.size }
}

/** Reads every file under `dir` into a tree (POSIX paths, sorted). */
export function readTree(dir: string): Tree {
  const tree: Tree = new Map()
  const walk = (rel: string) => {
    const full = rel ? join(dir, ...rel.split('/')) : dir
    for (const e of readdirSync(full, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith('.')) continue
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) tree.set(p, readFileSync(join(full, e.name), 'utf8'))
    }
  }
  walk('')
  return new Map([...tree].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}
