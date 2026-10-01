import {
  ConflictError,
  DeniedError,
  NotFoundError,
  ValidationError,
  systemClock,
  type Clock,
  type EventBus,
  type KindSchema,
} from '@mp/core'
import type { Records } from '@mp/records'
import type { EntryKind, Sessions } from '@mp/sessions'
import { SYSTEM, type Actor, type Entry, type StoredRecord } from '@mp/store'

export const CHECKLIST_KIND = 'checklist'

export const ChecklistTopics = {
  /** Payload: `ChecklistChanged`. */
  changed: 'checklist.changed',
} as const

export interface ChecklistChanged {
  sessionId: string
  checklistId: string
}

export type ReviewState = 'none' | 'requested' | 'passed' | 'failed'

export interface ChecklistItem {
  /** Short, stable within the checklist: `i1`, `i2`, … */
  id: string
  text: string
  required: boolean
  checked: boolean
  /** Entry ids the item was checked with. */
  evidence: string[]
  /** Whether a fresh-context reviewer has to pass the item before it counts as done. */
  needsReview: boolean
  review: ReviewState
  reviewNotes?: string
  reviewerSessionId?: string
  reviewedAt?: string
  /** Who added the item (a session id, or a template). */
  addedBy?: string
  checkedAt?: string
  /** The run whose history the evidence was checked against, if any. */
  checkedInRun?: string
}

export interface ChecklistData extends Record<string, unknown> {
  sessionId: string
  items: ChecklistItem[]
  /** Counter for item ids. */
  seq: number
}

export type Checklist = StoredRecord<ChecklistData>

export interface NewItem {
  text: string
  /** Default true. */
  required?: boolean
  /** Needs a fresh-context review to count as done. Default false. */
  review?: boolean
  addedBy?: string
}

export interface ChecklistStatus {
  /** Every required item is done. */
  complete: boolean
  total: number
  /** Items that are done (checked, and passed review when they need it). */
  done: number
  /** Required items that are not done yet. */
  missing: ChecklistItem[]
}

/** Entry kinds that count as something the session observed. */
export const EVIDENCE_KINDS: readonly EntryKind[] = ['tool_result', 'event', 'user']

export interface Checklists {
  /** The session's checklist, created empty on first use. */
  forSession(sessionId: string): Promise<Checklist>
  /** Adds items copied from a template (procedure or session template). */
  fromTemplate(sessionId: string, items: NewItem[]): Promise<Checklist>
  addItem(sessionId: string, item: NewItem): Promise<Checklist>
  /**
   * Checks an item with evidence. Every evidence id must be an entry the run
   * can see (`runId` given) or on the session's history, of a kind in
   * `EVIDENCE_KINDS`. Items that need review stay not done until a review passes.
   */
  check(sessionId: string, itemId: string, evidence: string[], opts?: { runId?: string }): Promise<Checklist>
  uncheck(sessionId: string, itemId: string): Promise<Checklist>
  requestReview(sessionId: string, itemId: string): Promise<Checklist>
  /** Records a reviewer's verdict. The reviewer must be another session than the one doing the work. */
  recordReview(
    sessionId: string,
    itemId: string,
    review: { passed: boolean; notes?: string; reviewerSessionId: string },
  ): Promise<Checklist>
  /**
   * Removes an item. Required items need `{ force: true, actor }`. Whether that
   * actor (the requester or owner) is allowed to is the caller's check.
   */
  removeItem(sessionId: string, itemId: string, opts?: { force?: boolean; actor?: Actor }): Promise<Checklist>
  status(sessionId: string): Promise<ChecklistStatus>
}

export interface ChecklistsOptions {
  records: Records
  sessions: Sessions
  clock?: Clock
  bus?: EventBus
}

export const checklistSchema: KindSchema = {
  kind: CHECKLIST_KIND,
  prefix: 'chk',
  description: 'What "done" means for a session: items checked with evidence, some needing review.',
  core: [
    { name: 'sessionId', type: 'ref', ref: 'session', required: true },
    {
      name: 'items',
      type: 'list',
      required: true,
      of: {
        type: 'object',
        fields: [
          { name: 'id', type: 'string', required: true },
          { name: 'text', type: 'string', required: true },
          { name: 'required', type: 'boolean', required: true },
          { name: 'checked', type: 'boolean', required: true },
          { name: 'evidence', type: 'list', of: { type: 'string' }, required: true },
          { name: 'needsReview', type: 'boolean', required: true },
          { name: 'review', type: 'enum', values: ['none', 'requested', 'passed', 'failed'], required: true },
          { name: 'reviewNotes', type: 'string' },
          { name: 'reviewerSessionId', type: 'string' },
          { name: 'reviewedAt', type: 'timestamp' },
          { name: 'addedBy', type: 'string' },
          { name: 'checkedAt', type: 'timestamp' },
          { name: 'checkedInRun', type: 'string' },
        ],
      },
    },
    { name: 'seq', type: 'number', required: true },
  ],
}

/** An item counts as done when it's checked and, if it needs review, the review passed. */
export const isItemDone = (item: ChecklistItem) => item.checked && (!item.needsReview || item.review === 'passed')

const MAX_ATTEMPTS = 10

/**
 * Checklists on top of records and sessions. One checklist per session
 * (record key = session id). Every change is a compare-and-swap on the
 * checklist record, retried when it loses a race.
 */
export function createChecklists(opts: ChecklistsOptions): Checklists {
  const { records, sessions } = opts
  const clock = opts.clock ?? systemClock
  records.kinds.define(checklistSchema)
  const now = () => new Date(clock.now()).toISOString()

  const changed = (c: Checklist) =>
    opts.bus?.publish(ChecklistTopics.changed, { sessionId: c.data.sessionId, checklistId: c.id } satisfies ChecklistChanged)

  async function forSession(sessionId: string): Promise<Checklist> {
    const existing = await records.getByKey<ChecklistData>(CHECKLIST_KIND, sessionId)
    if (existing) return existing
    await sessions.require(sessionId)
    try {
      const c = await records.create<ChecklistData>(CHECKLIST_KIND, { sessionId, items: [], seq: 0 }, { key: sessionId })
      changed(c)
      return c
    } catch (e) {
      const raced = e instanceof ConflictError ? await records.getByKey<ChecklistData>(CHECKLIST_KIND, sessionId) : null
      if (raced) return raced
      throw e
    }
  }

  /** Read-modify-write with CAS; `fn` returns the new data (it may throw to refuse). */
  async function change(
    sessionId: string,
    fn: (data: ChecklistData) => ChecklistData,
    actor: Actor = SYSTEM,
  ): Promise<Checklist> {
    for (let attempt = 1; ; attempt++) {
      const cur = await forSession(sessionId)
      const next = fn(structuredClone(cur.data))
      try {
        const c = await records.update<ChecklistData>(CHECKLIST_KIND, cur.id, next, {
          expectedVersion: cur.version,
          replace: true,
          actor,
        })
        changed(c)
        return c
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt >= MAX_ATTEMPTS) throw e
      }
    }
  }

  const itemIn = (data: ChecklistData, itemId: string): ChecklistItem => {
    const item = data.items.find((i) => i.id === itemId)
    if (!item) throw new NotFoundError('checklist item', itemId, { sessionId: data.sessionId })
    return item
  }

  const newItems = (data: ChecklistData, items: NewItem[]) => {
    for (const [n, it] of items.entries()) {
      if (typeof it?.text !== 'string' || !it.text.trim()) throw new ValidationError(`checklist item ${n + 1} needs a text`)
      data.seq += 1
      data.items.push({
        id: `i${data.seq}`,
        text: it.text.trim(),
        required: it.required ?? true,
        checked: false,
        evidence: [],
        needsReview: it.review ?? false,
        review: 'none',
        ...(it.addedBy ? { addedBy: it.addedBy } : {}),
      })
    }
    return data
  }

  /** Throws a `ValidationError` explaining every piece of evidence that doesn't count. */
  async function checkEvidence(sessionId: string, evidence: string[], runId?: string): Promise<void> {
    if (!Array.isArray(evidence) || !evidence.length)
      throw new ValidationError(
        'checking an item needs evidence: the ids of entries (tool results, events or user messages) that show it',
      )
    let history: Entry[]
    let where: string
    if (runId) {
      const run = await sessions.requireRun(runId)
      if (run.data.sessionId !== sessionId) throw new ValidationError(`run ${runId} does not belong to session ${sessionId}`)
      history = await sessions.runHistory(runId)
      where = `the history of run ${runId}`
    } else {
      history = await sessions.history(sessionId)
      where = `the history of session ${sessionId}`
    }
    const byId = new Map(history.map((e) => [e.id, e]))
    const problems: string[] = []
    for (const id of evidence) {
      const e = byId.get(id)
      // A pointer counts as what it stands for (an offloaded tool result is still something observed).
      const kind = e?.kind === 'pointer' && typeof e.meta.offloadedKind === 'string' ? e.meta.offloadedKind : e?.kind
      if (!e) problems.push(`${id} is not in ${where}`)
      else if (!EVIDENCE_KINDS.includes(kind as EntryKind))
        problems.push(`${id} is a ${e.kind} entry; evidence must be something observed (${EVIDENCE_KINDS.join(', ')})`)
    }
    if (problems.length) throw new ValidationError('invalid evidence', problems)
  }

  return {
    forSession,

    fromTemplate: (sessionId, items) => change(sessionId, (d) => newItems(d, items)),

    addItem: (sessionId, item) => change(sessionId, (d) => newItems(d, [item])),

    async check(sessionId, itemId, evidence, o = {}) {
      itemIn((await forSession(sessionId)).data, itemId)
      await checkEvidence(sessionId, evidence, o.runId)
      return change(sessionId, (d) => {
        const item = itemIn(d, itemId)
        item.checked = true
        item.evidence = [...new Set(evidence)]
        item.checkedAt = now()
        if (o.runId) item.checkedInRun = o.runId
        else delete item.checkedInRun
        // New evidence means an earlier verdict no longer applies.
        if (item.review === 'passed' || item.review === 'failed') {
          item.review = 'none'
          delete item.reviewNotes
          delete item.reviewerSessionId
          delete item.reviewedAt
        }
        return d
      })
    },

    uncheck: (sessionId, itemId) =>
      change(sessionId, (d) => {
        const item = itemIn(d, itemId)
        item.checked = false
        item.evidence = []
        delete item.checkedAt
        delete item.checkedInRun
        if (item.review !== 'requested') item.review = 'none'
        return d
      }),

    requestReview: (sessionId, itemId) =>
      change(sessionId, (d) => {
        const item = itemIn(d, itemId)
        if (!item.checked) throw new ValidationError(`item ${itemId} must be checked with evidence before it can be reviewed`)
        item.needsReview = true
        item.review = 'requested'
        return d
      }),

    async recordReview(sessionId, itemId, review) {
      if (review.reviewerSessionId === sessionId) throw new DeniedError("a session can't review its own checklist items")
      await sessions.require(review.reviewerSessionId)
      return change(
        sessionId,
        (d) => {
          const item = itemIn(d, itemId)
          if (!item.checked) throw new ValidationError(`item ${itemId} is not checked, there is nothing to review`)
          item.needsReview = true
          item.review = review.passed ? 'passed' : 'failed'
          item.reviewerSessionId = review.reviewerSessionId
          item.reviewedAt = now()
          if (review.notes) item.reviewNotes = review.notes
          else delete item.reviewNotes
          return d
        },
        { type: 'session', id: review.reviewerSessionId },
      )
    },

    async removeItem(sessionId, itemId, o = {}) {
      return change(
        sessionId,
        (d) => {
          const item = itemIn(d, itemId)
          if (item.required) {
            if (!o.force) throw new DeniedError(`item ${itemId} is required; removing it needs the requester or owner (force)`)
            if (!o.actor) throw new ValidationError('removing a required item needs the actor who allowed it')
          }
          d.items = d.items.filter((i) => i.id !== itemId)
          return d
        },
        o.actor ?? SYSTEM,
      )
    },

    async status(sessionId) {
      const { items } = (await forSession(sessionId)).data
      const missing = items.filter((i) => i.required && !isItemDone(i))
      return { complete: missing.length === 0, total: items.length, done: items.filter(isItemDone).length, missing }
    },
  }
}
