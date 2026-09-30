import { ConflictError, NotFoundError, ValidationError, isMpError, type Clock } from '@mp/core'
import type { Records } from '@mp/records'
import type { Actor, StoredRecord } from '@mp/store'
import {
  LEARNABLE_FIELDS,
  type ContactData,
  type ContactSuggestionData,
  type LearnableField,
  type LearnedFact,
} from './schemas.ts'

/**
 * What AI employees learn about people (docs/spec.md "What employees learn about people"):
 * an empty role, team or manager is filled, with where it came from; a field that already has a
 * value is never overwritten, the employee's value becomes a suggestion for an admin or the
 * person to accept or reject; bio notes are appended as dated lines with their source.
 */

export type ContactSuggestion = StoredRecord<ContactSuggestionData>

export interface LearnInput {
  contactId: string
  /** The AI employee that learned it. */
  employeeId: string
  /** Where it was learned: a message, thread, ticket or event reference, or a one-line quote. */
  source: string
  role?: string
  team?: string
  /** A contact id. */
  manager?: string
  /** A short, work-relevant note appended to the bio. */
  bioNote?: string
}

export interface LearnResult {
  contactId: string
  /** Empty fields that were filled. */
  filled: { field: LearnableField; value: string }[]
  /** Fields that already had another value: suggestions for an admin or the person. */
  suggested: { field: LearnableField; suggestionId: string; current: string; proposed: string; repeated: boolean }[]
  /** Fields left as they were, and why (already that value, or rejected before). */
  unchanged: { field: LearnableField; reason: string }[]
  /** The bio note: appended, or already said by a line of the bio. */
  bio?: 'added' | 'duplicate'
}

export interface ContactLearning {
  /** Fills empty fields, suggests changes to set ones and appends a bio note. Throws `ValidationError` for bad input. */
  learn(input: LearnInput, opts?: { actor?: Actor }): Promise<LearnResult>
  /** A contact's suggestions, newest first (default: pending only). */
  suggestions(contactId: string, opts?: { status?: ContactSuggestionData['status'] | 'all' }): Promise<ContactSuggestion[]>
  getSuggestion(id: string): Promise<ContactSuggestion | null>
  /** Applies the proposed value and records who accepted it. `ConflictError` once it was decided. */
  accept(id: string, by: string, opts?: { actor?: Actor }): Promise<ContactSuggestion>
  /** Dismisses it. The same employee suggesting the same value again doesn't reopen it. */
  reject(id: string, by: string, opts?: { actor?: Actor }): Promise<ContactSuggestion>
  /** The learned facts that still hold: a field's value unchanged since, a bio note still in the bio. */
  facts(contact: StoredRecord<ContactData>): LearnedFact[]
}

/** Longest role or team. */
export const MAX_LEARNED_FIELD = 120
/** Longest bio note. */
export const MAX_BIO_NOTE = 280
/** Longest source (longer ones are cut). */
export const MAX_SOURCE = 200
/** The bio doesn't grow past this: a note that would make it longer is refused. */
export const MAX_BIO = 4000

const SUGGESTION = 'contact_suggestion'
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)
/** For comparing values and notes: lowercase letters and digits, single spaces. */
const norm = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** A bio line without its `- 2026-09-30:` date and `[source: …]`, to compare with a new note. */
const noteText = (line: string) =>
  line
    .replace(/^\s*[-•*]\s*/, '')
    .replace(/^\d{4}-\d{2}-\d{2}:\s*/, '')
    .replace(/\s*\[source: [^\]]*\]\s*$/, '')

/** Whether a note says the same thing as a bio line (equal, or one contains the other). */
function sameNote(a: string, b: string): boolean {
  const x = norm(a)
  const y = norm(noteText(b))
  if (!x || !y) return false
  if (x === y) return true
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return short.length >= 12 && long.includes(short)
}

export interface ContactLearningDeps {
  records: Records
  clock: Clock
}

export function createContactLearning({ records, clock }: ContactLearningDeps): ContactLearning {
  const suggestionKey = (contactId: string, field: string, employeeId: string, proposed: string) =>
    `${contactId}:${field}:${employeeId}:${norm(proposed).slice(0, MAX_LEARNED_FIELD)}`

  const requirePerson = async (id: string) => {
    const c = await records.get<ContactData>('contact', id)
    if (!c) throw new NotFoundError('contact', id)
    if (c.data.kind !== 'person')
      throw new ValidationError(`${c.data.name} is an AI employee or agent: only people's contacts are learned about`)
    return c
  }

  const facts = (c: StoredRecord<ContactData>): LearnedFact[] => {
    const bio = c.data.bio ?? ''
    return (c.data.learned ?? []).filter((f) =>
      f.field === 'bio' ? !!f.line && bio.split('\n').includes(f.line) : c.data[f.field] === f.value,
    )
  }

  /** Keeps a field's newest fact and every bio note that's still in the bio. */
  const withFact = (c: ContactData, fact: LearnedFact, bio = c.bio): LearnedFact[] => {
    const lines = new Set((bio ?? '').split('\n'))
    const kept = (c.learned ?? []).filter((f) =>
      f.field === 'bio' ? !!f.line && lines.has(f.line) : f.field !== fact.field && c[f.field] === f.value,
    )
    return [...kept, fact].slice(-100)
  }

  const clean = (v: unknown, name: string, max: number): string | undefined => {
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'string') throw new ValidationError(`${name} must be a string`)
    const t = oneLine(v)
    if (!t) return undefined
    if (t.length > max) throw new ValidationError(`${name} must be at most ${max} characters: keep it to one short line`)
    return t
  }

  const learning: ContactLearning = {
    async learn(input, opts) {
      const source = typeof input.source === 'string' ? cut(oneLine(input.source), MAX_SOURCE) : ''
      if (!source)
        throw new ValidationError('source is required: where you learned it (a message, thread or ticket, or a one-line quote)')
      const wanted: Partial<Record<LearnableField, string>> = {}
      for (const f of LEARNABLE_FIELDS) {
        const v = clean(input[f], f, MAX_LEARNED_FIELD)
        if (v) wanted[f] = v
      }
      const bioNote = clean(input.bioNote, 'bio_note', MAX_BIO_NOTE)
      if (!Object.keys(wanted).length && !bioNote) throw new ValidationError('give role, team, manager or bio_note')
      if (!(await records.get('employee', input.employeeId))) throw new NotFoundError('employee', input.employeeId)

      const contact0 = await requirePerson(input.contactId)
      if (wanted.manager) {
        if (wanted.manager === contact0.id) throw new ValidationError('someone cannot be their own manager')
        const m = await records.get<ContactData>('contact', wanted.manager)
        if (!m) throw new ValidationError(`manager ${wanted.manager} is not a contact: look them up with directory.find_contact`)
        if (m.data.kind !== 'person') throw new ValidationError(`manager ${wanted.manager} is not a person`)
      }

      const at = clock.iso()
      const act = opts?.actor ? { actor: opts.actor } : {}
      // Fill empty fields and append the note in one compare-and-swap write, retried if the contact changed meanwhile.
      for (let attempt = 1; ; attempt++) {
        const c = attempt === 1 ? contact0 : await requirePerson(input.contactId)
        const result: LearnResult = { contactId: c.id, filled: [], suggested: [], unchanged: [] }
        const toSuggest: { field: LearnableField; current: string; proposed: string }[] = []
        const patch: Partial<ContactData> = {}
        let data: ContactData = { ...c.data }
        for (const f of LEARNABLE_FIELDS) {
          const v = wanted[f]
          if (!v) continue
          const cur = typeof c.data[f] === 'string' ? (c.data[f] as string).trim() : ''
          if (!cur) {
            patch[f] = v
            data = { ...data, [f]: v }
            data.learned = withFact(data, { field: f, value: v, employeeId: input.employeeId, source, at })
            result.filled.push({ field: f, value: v })
          } else if (f === 'manager' ? cur === v : norm(cur) === norm(v)) {
            result.unchanged.push({ field: f, reason: 'already set to that' })
          } else toSuggest.push({ field: f, current: cur, proposed: v })
        }
        if (bioNote) {
          const bio = c.data.bio ?? ''
          if (bio.split('\n').some((l) => sameNote(bioNote, l))) result.bio = 'duplicate'
          else {
            const line = `- ${at.slice(0, 10)}: ${bioNote} [source: ${source}]`
            const next = bio.trim() ? `${bio.replace(/\s+$/, '')}\n${line}` : line
            if (next.length > MAX_BIO)
              throw new ValidationError(
                `the bio is full (${MAX_BIO} characters): remember this with memory.remember (scope {type: contact, id}) instead`,
              )
            patch.bio = next
            data = { ...data, bio: next }
            data.learned = withFact(data, { field: 'bio', value: bioNote, employeeId: input.employeeId, source, at, line }, next)
            result.bio = 'added'
          }
        }
        if (Object.keys(patch).length) {
          patch.learned = data.learned ?? []
          try {
            await records.update<ContactData>('contact', c.id, patch, { ...act, expectedVersion: c.version })
          } catch (e) {
            if (isMpError(e, 'conflict') && attempt < 5) continue
            throw e
          }
        }
        for (const s of toSuggest) {
          const r = await suggest(c.id, s.field, s.current, s.proposed, input.employeeId, source, at, act)
          if (r.rejected) result.unchanged.push({ field: s.field, reason: 'suggested before and rejected' })
          else
            result.suggested.push({
              field: s.field,
              suggestionId: r.suggestion.id,
              current: s.current,
              proposed: s.proposed,
              repeated: r.repeated,
            })
        }
        return result
      }
    },

    async suggestions(contactId, opts) {
      const status = opts?.status ?? 'pending'
      const where: Record<string, string> = status === 'all' ? { contactId } : { contactId, status }
      const { items } = await records.query<ContactSuggestionData>(SUGGESTION, { where, limit: 200 })
      return items.sort((a, b) =>
        a.data.suggestedAt < b.data.suggestedAt ? 1 : a.data.suggestedAt > b.data.suggestedAt ? -1 : 0,
      )
    },

    getSuggestion: (id) => records.get<ContactSuggestionData>(SUGGESTION, id),

    async accept(id, by, opts) {
      const s = await records.require<ContactSuggestionData>(SUGGESTION, id)
      if (s.data.status !== 'pending') throw new ConflictError(`this suggestion was already ${s.data.status}`)
      const act = opts?.actor ? { actor: opts.actor } : {}
      const at = clock.iso()
      if (s.data.field === 'manager') {
        const m = await records.get<ContactData>('contact', s.data.proposed)
        if (!m) throw new ValidationError('the suggested manager is no longer in the directory: reject it instead')
        if (s.data.proposed === s.data.contactId) throw new ValidationError('someone cannot be their own manager')
      }
      for (let attempt = 1; ; attempt++) {
        const c = await records.require<ContactData>('contact', s.data.contactId)
        const fact: LearnedFact = {
          field: s.data.field,
          value: s.data.proposed,
          employeeId: s.data.employeeId,
          source: s.data.source,
          at: s.data.suggestedAt,
          acceptedBy: by,
          acceptedAt: at,
        }
        const data = { ...c.data, [s.data.field]: s.data.proposed }
        try {
          await records.update<ContactData>(
            'contact',
            c.id,
            { [s.data.field]: s.data.proposed, learned: withFact(data, fact) },
            { ...act, expectedVersion: c.version },
          )
          break
        } catch (e) {
          if (isMpError(e, 'conflict') && attempt < 5) continue
          throw e
        }
      }
      const decided = { decidedBy: by, decidedAt: at }
      const updated = await records.update<ContactSuggestionData>(SUGGESTION, id, { status: 'accepted', ...decided }, act)
      // Other employees' pending suggestions of the same value are settled by this too.
      for (const o of await learning.suggestions(s.data.contactId))
        if (o.id !== id && o.data.field === s.data.field && norm(o.data.proposed) === norm(s.data.proposed))
          await records.update<ContactSuggestionData>(SUGGESTION, o.id, { status: 'accepted', ...decided }, act)
      return updated
    },

    async reject(id, by, opts) {
      const s = await records.require<ContactSuggestionData>(SUGGESTION, id)
      if (s.data.status !== 'pending') throw new ConflictError(`this suggestion was already ${s.data.status}`)
      return records.update<ContactSuggestionData>(
        SUGGESTION,
        id,
        { status: 'rejected', decidedBy: by, decidedAt: clock.iso() },
        opts?.actor ? { actor: opts.actor } : {},
      )
    },

    facts,
  }

  /** One suggestion per employee, contact, field and value (its key): a repeat updates it, a rejected one stays rejected. */
  async function suggest(
    contactId: string,
    field: LearnableField,
    current: string,
    proposed: string,
    employeeId: string,
    source: string,
    at: string,
    act: { actor?: Actor },
  ): Promise<{ suggestion: ContactSuggestion; repeated: boolean; rejected?: boolean }> {
    const key = suggestionKey(contactId, field, employeeId, proposed)
    for (let attempt = 1; ; attempt++) {
      const prev = await records.getByKey<ContactSuggestionData>(SUGGESTION, key)
      if (prev?.data.status === 'rejected') return { suggestion: prev, repeated: true, rejected: true }
      if (prev) {
        // Pending: say it again. Accepted earlier and changed since: open it again.
        const updated = await records.update<ContactSuggestionData>(
          SUGGESTION,
          prev.id,
          {
            status: 'pending',
            current,
            proposed,
            source,
            suggestedAt: at,
            times: (prev.data.times ?? 1) + 1,
            ...(prev.data.status === 'accepted' ? { decidedBy: undefined, decidedAt: undefined } : {}),
          },
          act,
        )
        return { suggestion: updated, repeated: true }
      }
      try {
        const created = await records.create<ContactSuggestionData>(
          SUGGESTION,
          { contactId, field, current, proposed, employeeId, source, status: 'pending', times: 1, suggestedAt: at },
          { key, ...act },
        )
        return { suggestion: created, repeated: false }
      } catch (e) {
        if (e instanceof ConflictError && attempt < 3) continue
        throw e
      }
    }
  }

  return learning
}
