import type { ApiRecord, ApiRef, Channel, ChatSearchResult, ContactData, EmployeeData, Message, SessionData } from '@mp/api'

/**
 * Pure helpers for harness chat: channel labels, tag suggestions for `@`
 * autocomplete, reactions and search grouping. Everything comes from real
 * records; nothing here knows any names.
 */

/** The reactions offered in the picker. */
export const REACTIONS = ['✅', '👀', '👍', '❤️', '🎉', '❌'] as const

/**
 * A channel's display name. A DM is named after its members other than you
 * (`meId`); a DM with only you in it, or without members, falls back to its name.
 */
export function channelLabel(ch: Channel, meId?: string): string {
  if (!ch.data.dm) return ch.data.name
  const others = ch.data.members.filter((m) => m.id !== meId)
  const employees = others.filter((m) => m.type === 'employee')
  const list = employees.length && !meId ? employees : others
  return list.map((m) => m.label).join(', ') || ch.data.name
}

/** Whether a DM's other side is an employee (for its avatar). */
export function dmWithEmployee(ch: Channel, meId?: string): boolean {
  return ch.data.members.some((m) => m.type === 'employee' && m.id !== meId)
}

/** The `@name` a contact is tagged with: its `mp` handle (not the web UI's own `web` handle when it has another). */
export function mpHandle(c: ApiRecord<ContactData>): string | undefined {
  const mp = (c.data.handles ?? []).filter((h) => h.system === 'mp')
  return mp.find((h) => h.id !== 'web')?.id ?? mp[0]?.id
}

const isAi = (c: ApiRecord<ContactData>) => c.data.kind === 'ai' || c.data.ai === true

/** One `@` suggestion. `insert` is what replaces the typed `@…` (with the `@`). */
export interface TagSuggestion {
  type: 'employee' | 'session' | 'person'
  id: string
  insert: string
  label: string
  detail?: string
}

/** Everything that can be tagged: employees, their active sessions, and people with a chat handle (not you). */
export function tagCandidates(
  employees: ApiRecord<EmployeeData>[],
  sessions: { session: ApiRecord<SessionData> }[],
  contacts: ApiRecord<ContactData>[],
  meId?: string,
): TagSuggestion[] {
  const handle = new Map(employees.map((e) => [e.id, e.key ?? '']))
  const out: TagSuggestion[] = []
  for (const e of employees)
    if (e.key) out.push({ type: 'employee', id: e.id, insert: `@${e.key}`, label: e.data.name, detail: 'employee' })
  for (const { session: s } of sessions) {
    const h = handle.get(s.data.employeeId)
    if (!h || (s.data.status !== 'active' && s.data.status !== 'waiting')) continue
    out.push({ type: 'session', id: s.id, insert: `@${h}#${s.data.slug}`, label: s.data.title, detail: 'session' })
  }
  for (const c of contacts) {
    const h = mpHandle(c)
    if (!h || isAi(c) || c.id === meId) continue
    out.push({ type: 'person', id: c.id, insert: `@${h}`, label: c.data.name, detail: c.data.role })
  }
  return out
}

/** The `@…` being typed just before the caret, if any: its start offset and the text after `@`. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = /(^|[\s(])@([A-Za-z0-9._-]*(?:#[A-Za-z0-9_-]*)?)$/.exec(before)
  if (!m) return null
  return { start: before.length - m[2]!.length - 1, query: m[2]! }
}

/** Suggestions matching a query (after `@`), best first: handle prefix, then name words, then anywhere. */
export function matchSuggestions(all: TagSuggestion[], query: string, limit = 8): TagSuggestion[] {
  const q = query.toLowerCase()
  const score = (s: TagSuggestion) => {
    const handle = s.insert.slice(1).toLowerCase()
    const name = s.label.toLowerCase()
    if (!q) return s.type === 'employee' ? 0 : s.type === 'person' ? 1 : 2
    if (handle.startsWith(q)) return 0
    if (name.split(/\s+/).some((w) => w.startsWith(q))) return 1
    if (handle.includes(q) || name.includes(q)) return 2
    return -1
  }
  return all
    .map((s) => ({ s, n: score(s) }))
    .filter((x) => x.n >= 0)
    .sort((a, b) => a.n - b.n || a.s.insert.length - b.s.insert.length)
    .slice(0, limit)
    .map((x) => x.s)
}

/** Replaces the `@…` at `start` (up to the caret) with a suggestion; returns the text and the new caret. */
export function applySuggestion(text: string, start: number, caret: number, s: TagSuggestion): { text: string; caret: number } {
  const insert = `${s.insert} `
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length }
}

/** Tag examples for the composer hint: the channel's employee (else any), a session placeholder, and a person. */
export function tagExamples(channel: Channel | undefined, candidates: TagSuggestion[]): string[] {
  const inChannel = new Set(channel?.data.members.map((m) => m.id) ?? [])
  const emp =
    candidates.find((c) => c.type === 'employee' && inChannel.has(c.id)) ?? candidates.find((c) => c.type === 'employee')
  const people = candidates.filter((c) => c.type === 'person')
  const person = people.find((c) => inChannel.has(c.id)) ?? people[0]
  const out: string[] = []
  if (emp) out.push(emp.insert, `${emp.insert}#session-slug`)
  if (person) out.push(person.insert)
  return out
}

/** Reactions of a message as chips: emoji, count, and whether you reacted. */
export function reactionChips(m: Message, me?: ApiRef): { emoji: string; count: number; mine: boolean }[] {
  return Object.entries(m.data.reactions ?? {})
    .filter(([, who]) => who.length > 0)
    .map(([emoji, who]) => ({
      emoji,
      count: who.length,
      mine: !!me && who.some((r) => r.id === me.id && (r.kind === me.kind || r.kind === 'contact')),
    }))
}

/** Search results grouped by channel, in the order channels first appear (newest hit first). */
export function groupByChannel(
  results: ChatSearchResult[],
): { channel: ChatSearchResult['channel']; hits: ChatSearchResult[] }[] {
  const groups = new Map<string, { channel: ChatSearchResult['channel']; hits: ChatSearchResult[] }>()
  for (const r of results) {
    if (!groups.has(r.channel.id)) groups.set(r.channel.id, { channel: r.channel, hits: [] })
    groups.get(r.channel.id)!.hits.push(r)
  }
  return [...groups.values()]
}

/** Replaces a message in a list by id (live edits, deletions and reactions); appends it if it's new. */
export function upsertMessage(list: Message[], m: Message): Message[] {
  const i = list.findIndex((x) => x.id === m.id)
  if (i < 0) return [...list, m]
  const next = list.slice()
  // Keep the thread summary the list already has; a live update may carry none.
  next[i] = { ...m, data: { ...list[i]!.data, ...m.data } }
  return next
}
