import type { Ref } from '@mp/store'
import type { Services } from '../services.ts'

/** What export and import need from the services. */
export type TransferServices = Pick<Services, 'records' | 'docs' | 'directory' | 'memory' | 'skills'>

/** An exported knowledge base: file contents by relative POSIX path (`contacts/ana.md`, `index.json`, …). */
export type Tree = Map<string, string>

/** Record kinds that are exported and imported. `link` stands for a link between two of them. */
export type TransferKind = 'contact' | 'employee' | 'project' | 'procedure' | 'skill' | 'doc' | 'memory' | 'link'

/** Apply order: every kind only refers to kinds before it. */
export const KIND_ORDER: TransferKind[] = ['contact', 'employee', 'project', 'procedure', 'skill', 'doc', 'memory', 'link']

/** The folder format's marker in `index.json`. */
export const INDEX_FORMAT = 'meatless-proxy.knowledge'
export const INDEX_VERSION = 1

export interface IndexEntry {
  kind: Exclude<TransferKind, 'link'>
  id: string
  path: string
}

export interface IndexLink {
  from: Ref
  to: Ref
  role: string
  data?: Record<string, unknown>
}

/** `index.json`: every exported record with its file, and the links that aren't shown in the files. */
export interface KnowledgeIndex {
  format: typeof INDEX_FORMAT
  version: number
  records: IndexEntry[]
  links: IndexLink[]
}

/** Where to import from. Several sources can be combined in one plan. */
export interface ImportSource {
  /** An exported folder, already read (see `readTree`). */
  tree?: Tree
  /** CSV text with a header row: name, email, role, team, manager email, slack handle, permissions. */
  contactsCsv?: string
  /** CSV text with a header row: name, description, owner email, members (`email:role;email:role`). */
  projectsCsv?: string
  /** Names used in messages for the CSV sources (default `contacts.csv` and `projects.csv`). */
  names?: { contacts?: string; projects?: string }
}

export type PlanOp = 'create' | 'update' | 'unchanged'

export interface FieldChange {
  field: string
  /** Absent on create. */
  from?: unknown
  to?: unknown
}

export interface PlanItem {
  kind: TransferKind
  op: PlanOp
  /** The record id it will have (for links: the `from` id). */
  id: string
  /** Human-readable name: a contact's name, a doc's path, `Ana -> Payments (owner)`. */
  label: string
  /** Where it came from: `contacts/ana.md` or `contacts.csv:4`. */
  source: string
  /** Create: the full data. Update: only the changed fields. Unchanged: empty. */
  data: Record<string, unknown>
  changes: FieldChange[]
  /** Record key on create (employees, skills). */
  key?: string
  /** For `link` items. `role: owner` replaces the project's other owners. */
  link?: IndexLink
}

export interface PlanIssue {
  source: string
  /** 1-based line of a CSV row. */
  line?: number
  message: string
}

export interface PlanCounts {
  create: number
  update: number
  unchanged: number
}

export interface ImportPlan {
  items: PlanItem[]
  /** Rows or files that were skipped. */
  errors: PlanIssue[]
  /** Things that were imported with a caveat (e.g. an unknown manager). */
  warnings: PlanIssue[]
  counts: PlanCounts
  byKind: Partial<Record<TransferKind, PlanCounts>>
}

export interface ApplyResult {
  counts: PlanCounts
  /** Items that failed while applying (the rest were applied). */
  errors: PlanIssue[]
}
