import type { Json } from '@mp/core'

/** Who made a change. Recorded in revisions. */
export interface Actor {
  type: 'contact' | 'session' | 'system'
  id: string
}

export const SYSTEM: Actor = { type: 'system', id: 'system' }

/** A reference to a record. Ids are globally unique, the kind makes queries cheap. */
export interface Ref {
  kind: string
  id: string
}

export interface StoredRecord<T = Record<string, unknown>> {
  kind: string
  id: string
  /** Starts at 1 and goes up by one on every update. Used for compare-and-swap. */
  version: number
  /** Optional unique key within the kind, e.g. an event's dedupe key or a session slug. */
  key: string | null
  data: T
  createdAt: string
  updatedAt: string
}

export interface Revision<T = Record<string, unknown>> {
  kind: string
  id: string
  version: number
  op: 'create' | 'update' | 'delete'
  data: T | null
  actor: Actor
  at: string
}

/**
 * A condition on a record. `field` is `id`, `key`, `version`, `createdAt`,
 * `updatedAt`, or a dot path into `data` (e.g. `status`, `scope.projectId`).
 * Anything else, including `kind`, is a path into `data` (queries are per kind anyway).
 */
export type Condition =
  | { field: string; op: 'eq' | 'ne'; value: Json }
  | { field: string; op: 'in' | 'nin'; value: Json[] }
  | { field: string; op: 'gt' | 'gte' | 'lt' | 'lte'; value: number | string }
  /** The field is an array containing an element that deep-matches `value` (objects match partially). */
  | { field: string; op: 'contains'; value: Json }
  /** Case-insensitive substring match on a string field. */
  | { field: string; op: 'like'; value: string }
  | { field: string; op: 'exists'; value: boolean }

/** Shorthand: `{ status: 'active' }` means `[{ field: 'status', op: 'eq', value: 'active' }]`. */
export type Where = Condition[] | Record<string, Json>

export interface RecordQuery {
  where?: Where
  /** Case-insensitive substring search over the whole record data. */
  text?: string
  orderBy?: { field: string; dir?: 'asc' | 'desc' }
  limit?: number
  /** Skip this many results (simple paging). */
  offset?: number
}

export interface Page<T> {
  items: StoredRecord<T>[]
  total: number
}

export interface WriteOptions {
  actor?: Actor
}

export interface CreateOptions extends WriteOptions {
  /** Use this id instead of generating one. Must be unique across all kinds. */
  id?: string
  /** Id prefix when generating an id. Defaults to the first three letters of the kind. */
  prefix?: string
  /** Unique within the kind. Creating a second record with the same key throws `ConflictError`. */
  key?: string
}

export interface UpdateOptions extends WriteOptions {
  /** Compare-and-swap: fail with `ConflictError` unless the record is at this version. */
  expectedVersion?: number
  /** Replace `data` entirely instead of merging the patch into it. */
  replace?: boolean
  /** Change the record's key (null removes it). */
  key?: string | null
}

export interface DeleteOptions extends WriteOptions {
  expectedVersion?: number
  /** Also delete links to and from the record. Without it, a record with links can't be deleted. */
  cascade?: boolean
}

export interface RecordStore {
  create<T extends Record<string, unknown>>(kind: string, data: T, opts?: CreateOptions): Promise<StoredRecord<T>>
  /** Creates the record unless one with the same key exists, in which case that one is returned. */
  createOrGet<T extends Record<string, unknown>>(
    kind: string,
    key: string,
    data: T,
    opts?: Omit<CreateOptions, 'key'>,
  ): Promise<{ record: StoredRecord<T>; created: boolean }>
  get<T = Record<string, unknown>>(kind: string, id: string): Promise<StoredRecord<T> | null>
  getByKey<T = Record<string, unknown>>(kind: string, key: string): Promise<StoredRecord<T> | null>
  /** Finds a record by id alone, whatever its kind. */
  find<T = Record<string, unknown>>(id: string): Promise<StoredRecord<T> | null>
  /** Shallow-merges `patch` into `data` (keys set to `undefined` are removed), or replaces it with `replace`. */
  update<T = Record<string, unknown>>(kind: string, id: string, patch: Partial<T>, opts?: UpdateOptions): Promise<StoredRecord<T>>
  delete(kind: string, id: string, opts?: DeleteOptions): Promise<void>
  query<T = Record<string, unknown>>(kind: string, q?: RecordQuery): Promise<Page<T>>
  count(kind: string, where?: Where): Promise<number>
  /** Sum of a numeric field over the matching records. Missing values count as 0. */
  sum(kind: string, field: string, where?: Where): Promise<number>
  /** Every version of a record, oldest first, including its deletion. */
  revisions<T = Record<string, unknown>>(kind: string, id: string): Promise<Revision<T>[]>
  /** Distinct kinds that have at least one record. */
  kinds(): Promise<string[]>
}

export interface Link<T = Record<string, unknown>> {
  id: string
  from: Ref
  to: Ref
  role: string
  data: T
  createdAt: string
}

export interface LinkQuery {
  /** Links starting at this record, or at any record of this kind. */
  from?: Ref | { kind: string }
  /** Links ending at this record, or at any record of this kind. */
  to?: Ref | { kind: string }
  role?: string | string[]
  /** Links touching this record at either end. */
  touching?: Ref
}

export interface LinkStore {
  /**
   * Links two records. Both must exist (`NotFoundError` otherwise). Linking
   * the same pair with the same role twice returns the existing link.
   */
  link<T extends Record<string, unknown>>(from: Ref, to: Ref, role: string, data?: T, opts?: WriteOptions): Promise<Link<T>>
  get(id: string): Promise<Link | null>
  update<T extends Record<string, unknown>>(id: string, data: T, opts?: WriteOptions): Promise<Link<T>>
  unlink(id: string, opts?: WriteOptions): Promise<void>
  /** Removes the link between `from` and `to` with `role`, if there is one. */
  unlinkPair(from: Ref, to: Ref, role: string, opts?: WriteOptions): Promise<void>
  query(q: LinkQuery): Promise<Link[]>
}

export interface Entry<C = Json> {
  id: string
  /** The previous entry, or null for a root. */
  parent: string | null
  /** e.g. `system`, `user`, `assistant`, `tool_call`, `tool_result`, `event`, `summary`, `pointer`. */
  kind: string
  content: C
  /** sha256 of the canonical content. Identical content is stored once. */
  hash: string
  meta: Record<string, Json>
  createdAt: string
}

export interface AppendEntry<C = Json> {
  parent: string | null
  kind: string
  content: C
  meta?: Record<string, Json>
  /** Use this id instead of generating one. */
  id?: string
}

/** The append-only tree of session history. Entries are never modified or deleted. */
export interface EntryStore {
  append<C extends Json>(entry: AppendEntry<C>): Promise<Entry<C>>
  get<C = Json>(id: string): Promise<Entry<C> | null>
  getMany<C = Json>(ids: string[]): Promise<Entry<C>[]>
  /** The entries from the root down to `head`, inclusive, in order. */
  path<C = Json>(head: string): Promise<Entry<C>[]>
  children<C = Json>(id: string): Promise<Entry<C>[]>
  /** Content stored under a hash, if any. */
  blob<C = Json>(hash: string): Promise<C | null>
  /**
   * Full-text search over entry content: case-insensitive substring match on the
   * entry's JSON content, newest first. Filters by kinds and by meta fields
   * (e.g. `{ sessionId: 'ses_…' }` or `{ employeeId: 'emp_…' }`).
   */
  search<C = Json>(q: EntrySearch): Promise<{ items: Entry<C>[]; total: number }>
}

export interface EntrySearch {
  text: string
  kinds?: string[]
  /** Every listed meta field must equal the given value; an array value means "any of". */
  meta?: Record<string, Json | Json[]>
  limit?: number
  offset?: number
}

export interface Store {
  readonly records: RecordStore
  readonly links: LinkStore
  readonly entries: EntryStore
  /**
   * Runs `fn` with stores bound to one transaction: everything it writes is
   * committed together, or not at all if it throws. Change notifications are
   * published after the commit. Calling `transaction` inside `fn` reuses the
   * outer transaction.
   */
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/** Bus topics published by every store implementation. */
export const StoreTopics = {
  recordChanged: 'record.changed',
  linkChanged: 'link.changed',
  entryAppended: 'entry.appended',
} as const

export interface RecordChanged {
  kind: string
  id: string
  version: number
  op: 'create' | 'update' | 'delete'
  actor: Actor
}

export interface LinkChanged {
  id: string
  from: Ref
  to: Ref
  role: string
  op: 'link' | 'update' | 'unlink'
}

export interface EntryAppended {
  id: string
  parent: string | null
  kind: string
  /** The entry's meta, e.g. `sessionId`, `runId`, so listeners don't have to look the entry up. */
  meta: Record<string, Json>
}
