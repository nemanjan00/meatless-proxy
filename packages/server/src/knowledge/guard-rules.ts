import { DeniedError, NotFoundError } from '@mp/core'
import type { GuardContext, GuardRule } from '../auth/guard.ts'
import { canSeeMemoryRecord } from './memory-access.ts'

/** A memory record through the generic records API: 404 unless the caller may see it (memory-access.ts). */
const visibleMemory = async ({ principal, params, s }: GuardContext) => {
  const m = await s.records.get('memory', params.id ?? '')
  if (m && !(await canSeeMemoryRecord(s, principal, m))) throw new NotFoundError('memory', params.id ?? '')
}

/** An admin, or the person the route is about (`:id`), whatever their access. */
const selfOrAdmin = async ({ principal, params }: GuardContext) => {
  if (principal.access !== 'admin' && principal.contactId !== params.id)
    throw new DeniedError('only an admin or the person themself decides on suggestions about them')
}

/**
 * What the knowledge routes need (src/knowledge), merged into `GUARD_RULES` before the generic
 * record rules. The handlers check the rest: access changes are admins', and a person may
 * correct or forget a memory about themselves whatever their access.
 */
export const KNOWLEDGE_GUARD_RULES: GuardRule[] = [
  // Memory: members teach employees; anyone may correct or forget what's about them (the handler checks).
  { method: 'POST', path: '/api/memories', need: 'member' },
  { method: 'PATCH', path: '/api/memories/:id', need: 'viewer' },
  { method: 'POST', path: '/api/memories/:id/verify', need: 'viewer' },
  { method: 'DELETE', path: '/api/memories/:id', need: 'viewer' },
  // Memories are personal data: the generic records API serves them to admins only, and a single one to whoever may see it.
  { method: 'GET', path: '/api/records/memory', need: 'admin' },
  { method: 'GET', path: '/api/records/memory/:id', need: 'viewer', check: visibleMemory },
  { method: 'GET', path: '/api/records/memory/:id/*', need: 'viewer', check: visibleMemory },
  { method: '*', path: '/api/records/memory', need: 'admin' },
  { method: '*', path: '/api/records/memory/*', need: 'admin' },
  // Skills are knowledge: members write them.
  { method: 'POST', path: '/api/skills', need: 'member' },
  { method: 'PATCH', path: '/api/skills/:id', need: 'member' },
  { method: 'POST', path: '/api/skills/:id/restore', need: 'member' },
  { method: 'DELETE', path: '/api/skills/:id', need: 'member' },
  // People: admins add them, send sign-in links and deactivate; members edit profiles (access: admins, checked by the handler).
  { method: 'POST', path: '/api/people', need: 'admin' },
  { method: 'PATCH', path: '/api/people/:id', need: 'member' },
  { method: 'POST', path: '/api/people/:id/sign-in-link', need: 'admin' },
  { method: 'POST', path: '/api/people/:id/deactivate', need: 'admin' },
  { method: 'POST', path: '/api/people/:id/reactivate', need: 'admin' },
  // What employees suggest about a person: that person (any access) or an admin accepts or rejects it.
  { method: 'POST', path: '/api/people/:id/suggestions/:suggestionId/accept', need: 'viewer', check: selfOrAdmin },
  { method: 'POST', path: '/api/people/:id/suggestions/:suggestionId/reject', need: 'viewer', check: selfOrAdmin },
]
