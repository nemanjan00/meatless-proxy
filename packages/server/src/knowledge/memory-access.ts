import type { ContactData } from '@mp/directory'
import type { Memory } from '@mp/memory'
import type { Link, StoredRecord } from '@mp/store'
import type { Access } from '../auth/access.ts'
import type { Services } from '../services.ts'

/**
 * Who may see and change a memory (docs/spec.md "Memory", "Who sees a memory"):
 *
 * - A memory is **personal** when it's about a person: scoped to their contact, or linked to it
 *   with role `about` (either way round). Only that person and admins see a personal memory.
 * - Every other memory (about a project, the company, an AI employee) is seen by everyone signed in.
 * - Admins may change any memory. Members may change the memories they see. Anyone may correct
 *   or forget a memory about themselves, even a viewer: it's their own data.
 *
 * The same rule serves the memory pages (src/knowledge/memories.ts) and the generic records API,
 * where memory records are admins' only and links to memories are left out for everyone else
 * unless they may see them.
 */

export interface MemoryViewer {
  contactId: string
  access: Access
}

const ABOUT = 'about'

/** Contact ids a memory is about (its contact scope, and `about` links to contacts), from its links. */
export function contactsAbout(m: Memory, links: Link[]): string[] {
  const ids = new Set<string>()
  if (m.data.scope?.type === 'contact' && m.data.scope.id) ids.add(m.data.scope.id)
  for (const l of links) {
    if (l.role !== ABOUT) continue
    if (l.from.kind === 'memory' && l.from.id === m.id && l.to.kind === 'contact') ids.add(l.to.id)
    if (l.to.kind === 'memory' && l.to.id === m.id && l.from.kind === 'contact') ids.add(l.from.id)
  }
  return [...ids]
}

/** The people (contacts of kind `person`) among contact ids. An unknown contact counts as a person, to be safe. */
export function peopleAmong(ids: string[], contacts: Map<string, StoredRecord<ContactData>>): string[] {
  return ids.filter((id) => {
    const c = contacts.get(id)
    return !c || c.data.kind === 'person'
  })
}

/** Whether the viewer may see a memory about these people. */
export function canSeeMemory(viewer: MemoryViewer, people: string[]): boolean {
  return viewer.access === 'admin' || people.length === 0 || people.includes(viewer.contactId)
}

/** Whether the viewer may change (edit, correct, forget) a memory about these people. */
export function canChangeMemory(viewer: MemoryViewer, people: string[]): boolean {
  if (viewer.access === 'admin') return true
  if (people.includes(viewer.contactId)) return true
  return viewer.access === 'member' && people.length === 0
}

/** The people one memory is about, looked up on their own (for single-record checks). */
export async function peopleAboutMemory(s: Pick<Services, 'records'>, m: Memory): Promise<string[]> {
  const links = await s.records.links({ touching: { kind: 'memory', id: m.id } })
  const ids = contactsAbout(m, links)
  const contacts = new Map<string, StoredRecord<ContactData>>()
  for (const id of ids) {
    const c = await s.records.get<ContactData>('contact', id)
    if (c) contacts.set(id, c)
  }
  return peopleAmong(ids, contacts)
}

/** Whether the viewer may see a record, as far as memories go: true for anything that isn't a memory. */
export async function canSeeMemoryRecord(
  s: Pick<Services, 'records'>,
  viewer: MemoryViewer,
  r: { kind: string } | null | undefined,
): Promise<boolean> {
  if (r?.kind !== 'memory' || viewer.access === 'admin') return true
  return canSeeMemory(viewer, await peopleAboutMemory(s, r as Memory))
}
