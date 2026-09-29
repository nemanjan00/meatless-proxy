import type { ApiEvent } from '@mp/api'

/**
 * Where an event went, from its routing facts:
 * - `pending`: not routed yet
 * - `matched`: a rule (tag, subscription, trigger) delivered it
 * - `unmatched`: no rule matched and it went to a fallback router
 * - `nowhere`: it was delivered to nobody, e.g. a session's own reply, which the router never sends back to it
 *
 * Servers that don't report `deliveries` are read the older way: an empty
 * (or fallback-only) `matched` counts as unmatched.
 */
export type RoutingOutcome = 'pending' | 'matched' | 'unmatched' | 'nowhere'

export function routingOutcome(e: ApiEvent): RoutingOutcome {
  const d = e.data
  if (!d.routed) return 'pending'
  const rules = (d.matched ?? []).filter((m) => m !== 'fallback')
  if (rules.length) return 'matched'
  if (d.deliveries === 0) return 'nowhere'
  return 'unmatched'
}

/** A one-line description of an event: its subject's title, else the text it carries (e.g. a chat message). */
export function eventTitle(e: ApiEvent): string | undefined {
  if (e.data.subject?.title) return e.data.subject.title
  const p = e.data.payload as { text?: unknown } | null
  const text = typeof p === 'object' && p && typeof p.text === 'string' ? p.text : (e.data as { text?: unknown }).text
  return typeof text === 'string' && text.trim() ? text.replace(/\s+/g, ' ').trim() : undefined
}
