import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Json } from '@mp/core'
import type { IntegrationEvent } from '@mp/mcp'

export const SOURCE = 'integration:linear'
export const SYSTEM = 'linear'
/** How far `webhookTimestamp` may be from now. */
export const MAX_SKEW_MS = 60_000

/** True when `signature` is the hex HMAC-SHA256 of `body` with `secret`. Constant time. */
export function verifySignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest()
  const given = /^[0-9a-f]+$/i.test(signature.trim()) ? Buffer.from(signature.trim(), 'hex') : Buffer.alloc(0)
  // Compare equal-length buffers only; a length mismatch still does a constant-time compare of the expected value.
  if (given.length !== expected.length) {
    timingSafeEqual(expected, expected)
    return false
  }
  return timingSafeEqual(given, expected)
}

/** The webhook body as Linear sends it (the fields used here). */
export interface LinearWebhookPayload {
  action: 'create' | 'update' | 'remove' | string
  type: string
  data: Record<string, any>
  actor?: { id?: string; type?: string; name?: string; email?: string } | null
  updatedFrom?: Record<string, any> | null
  url?: string
  createdAt?: string
  webhookTimestamp?: number
  webhookId?: string
  organizationId?: string
}

/** Looks up what a webhook body doesn't carry (an issue's identifier, a user's email). Best effort. */
export interface WebhookLookups {
  issue?(id: string): Promise<{ identifier: string; title: string; url: string } | null>
  user?(id: string): Promise<{ id: string; name: string; email?: string | null } | null>
}

export const bodyHash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 40)

type Person = { id: string; name: string | null; email: string | null } | null

const person = (p: any): Person => (p?.id ? { id: p.id, name: p.name ?? null, email: p.email ?? null } : null)

const identifierOf = (d: Record<string, any>): string | undefined =>
  d.identifier ?? (d.team?.key && typeof d.number === 'number' ? `${d.team.key}-${d.number}` : undefined)

const quote = (s: string | undefined) => (s ? ` "${s.length > 80 ? `${s.slice(0, 79)}…` : s}"` : '')

/**
 * Maps one verified Linear webhook to events. `deliveryKey` is the dedupe key base
 * (the delivery id, else a body hash); derived events get a suffix, so each is stored once.
 */
export async function mapWebhook(
  p: LinearWebhookPayload,
  deliveryKey: string,
  lookups: WebhookLookups = {},
): Promise<IntegrationEvent[]> {
  const d = p.data ?? {}
  const actorId: string | undefined = p.actor?.id ?? d.creatorId ?? d.userId
  const actorName = p.actor?.name ?? d.user?.name ?? d.creator?.name ?? null
  const by = actorName ? ` by ${actorName}` : ''
  const actor = actorId ? { system: SYSTEM, id: actorId } : undefined
  const base = { source: SOURCE, ...(actor ? { actor } : {}) }
  const key = (suffix?: string) => `linear:${deliveryKey}${suffix ? `:${suffix}` : ''}`

  if (p.type === 'Issue') {
    const identifier = identifierOf(d) ?? (d.id ? ((await safe(() => lookups.issue?.(d.id)))?.identifier ?? d.id) : undefined)
    const assignee = await withEmail(person(d.assignee), lookups)
    const issue = {
      id: d.id ?? null,
      identifier: identifier ?? null,
      title: d.title ?? null,
      state: d.state?.name ?? null,
      stateType: d.state?.type ?? null,
      assignee,
      priority: typeof d.priority === 'number' ? d.priority : null,
      priorityLabel: d.priorityLabel ?? null,
      labels: (d.labels ?? []).map((l: any) => l.name).filter(Boolean),
      team: d.team?.key ?? null,
      url: p.url ?? d.url ?? null,
    }
    const payload = (extra: Record<string, Json> = {}): Json => ({
      action: p.action,
      ...issue,
      actor: actorId ? { id: actorId, name: actorName } : null,
      ...extra,
    })
    const subject = identifier ? { subject: { system: SYSTEM, id: identifier } } : {}
    const head = `Linear ${identifier ?? 'issue'}${quote(d.title)}`
    const events: IntegrationEvent[] = []
    const push = (type: string, what: string, extra?: Record<string, Json>, suffix?: string) =>
      events.push({ ...base, ...subject, type, dedupeKey: key(suffix), text: `${head}: ${what}${by}`, payload: payload(extra) })
    const assignedText = assignee ? `assigned to ${assignee.name ?? assignee.email ?? assignee.id}` : 'unassigned'

    if (p.action === 'create') {
      push('issue.created', 'created')
      if (assignee) push('issue.assigned', assignedText, { previousAssigneeId: null }, 'assigned')
    } else if (p.action === 'remove') {
      push('issue.removed', 'removed')
    } else if (p.action === 'update') {
      const from = p.updatedFrom ?? {}
      const changed = Object.keys(from).filter((k) => k !== 'updatedAt' && k !== 'sortOrder' && k !== 'boardOrder')
      const changes: Record<string, Json> = {}
      for (const k of changed) changes[k] = { from: toJson(from[k]), to: toJson(d[k]) }
      const what = describeChanges(changed, issue.state, assignedText)
      push('issue.updated', what, { changed: changed as Json, changes })
      if ('assigneeId' in from && from.assigneeId !== d.assigneeId) {
        push(
          assignee ? 'issue.assigned' : 'issue.unassigned',
          assignedText,
          { previousAssigneeId: from.assigneeId ?? null },
          'assigned',
        )
      }
      if ('stateId' in from && from.stateId !== d.stateId) {
        push(
          'issue.state_changed',
          `moved to ${issue.state ?? 'another state'}`,
          { previousStateId: from.stateId ?? null },
          'state',
        )
      }
      if ('labelIds' in from) {
        const before = new Set<string>(from.labelIds ?? [])
        const after = new Set<string>(d.labelIds ?? [])
        const added = [...after].filter((x) => !before.has(x))
        const removed = [...before].filter((x) => !after.has(x))
        if (added.length || removed.length) {
          const names = new Map<string, string>((d.labels ?? []).map((l: any) => [l.id, l.name]))
          const addedNames = added.map((x) => names.get(x) ?? x)
          const parts = [
            addedNames.length ? `labeled ${addedNames.join(', ')}` : '',
            removed.length ? `${removed.length} label(s) removed` : '',
          ]
          push('issue.labeled', parts.filter(Boolean).join('; '), { addedLabels: addedNames, removedLabelIds: removed }, 'labels')
        }
      }
    } else {
      push(`issue.${p.action}`, p.action)
    }
    return events
  }

  if (p.type === 'Comment') {
    const issueId: string | undefined = d.issueId ?? d.issue?.id
    const looked = !d.issue?.identifier && issueId ? await safe(() => lookups.issue?.(issueId)) : null
    const identifier: string | undefined = d.issue?.identifier ?? identifierOf(d.issue ?? {}) ?? looked?.identifier ?? issueId
    const title: string | undefined = d.issue?.title ?? looked?.title
    const verb =
      p.action === 'create' ? 'created' : p.action === 'update' ? 'updated' : p.action === 'remove' ? 'removed' : p.action
    const body = typeof d.body === 'string' ? d.body : ''
    const author = person(d.user) ?? (actorId ? { id: actorId, name: actorName, email: p.actor?.email ?? null } : null)
    return [
      {
        ...base,
        type: `comment.${verb}`,
        dedupeKey: key(),
        ...(identifier ? { subject: { system: SYSTEM, id: identifier } } : {}),
        text: `Linear ${identifier ?? 'issue'}${quote(title)}: comment ${verb}${by}${body && verb !== 'removed' ? `: ${clip(body, 200)}` : ''}`,
        payload: {
          action: p.action,
          commentId: d.id ?? null,
          body,
          identifier: identifier ?? null,
          issueId: issueId ?? null,
          issueTitle: title ?? null,
          author,
          parentCommentId: d.parentId ?? null,
          url: p.url ?? d.url ?? looked?.url ?? null,
        },
      },
    ]
  }

  if (p.type === 'IssueLabel') {
    const verb =
      p.action === 'create' ? 'created' : p.action === 'update' ? 'updated' : p.action === 'remove' ? 'removed' : p.action
    return [
      {
        ...base,
        type: `label.${verb}`,
        dedupeKey: key(),
        text: `Linear label "${d.name ?? d.id}" ${verb}${by}`,
        payload: {
          action: p.action,
          labelId: d.id ?? null,
          name: d.name ?? null,
          color: d.color ?? null,
          teamId: d.teamId ?? null,
        },
      },
    ]
  }

  if (p.type === 'Reaction') {
    const issueId: string | undefined = d.issueId ?? d.comment?.issueId ?? d.issue?.id
    const looked = issueId && !d.issue?.identifier ? await safe(() => lookups.issue?.(issueId)) : null
    const identifier: string | undefined = d.issue?.identifier ?? looked?.identifier ?? issueId
    const verb = p.action === 'create' ? 'added' : p.action === 'remove' ? 'removed' : p.action
    return [
      {
        ...base,
        type: `reaction.${verb}`,
        dedupeKey: key(),
        ...(identifier ? { subject: { system: SYSTEM, id: identifier } } : {}),
        text: `Linear ${identifier ?? 'issue'}: reaction ${d.emoji ?? ''} ${verb}${d.commentId ? ' on a comment' : ''}${by}`.replace(
          /\s+/g,
          ' ',
        ),
        payload: {
          action: p.action,
          emoji: d.emoji ?? null,
          identifier: identifier ?? null,
          commentId: d.commentId ?? d.comment?.id ?? null,
          url: p.url ?? null,
        },
      },
    ]
  }

  // Other resource types (projects, cycles, …) pass through generically.
  const type = `${(p.type ?? 'unknown').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}.${p.action ?? 'event'}`
  return [
    {
      ...base,
      type,
      dedupeKey: key(),
      text: `Linear ${p.type ?? 'event'}${quote(d.name ?? d.title)} ${p.action ?? ''}${by}`.trim(),
      payload: { action: p.action ?? null, entity: p.type ?? null, id: d.id ?? null, url: p.url ?? null },
    },
  ]
}

function describeChanges(changed: string[], state: string | null, assignedText: string): string {
  const parts: string[] = []
  for (const k of changed) {
    if (k === 'stateId') parts.push(`moved to ${state ?? 'another state'}`)
    else if (k === 'assigneeId') parts.push(assignedText)
    else if (k === 'labelIds') parts.push('labels changed')
    else if (k === 'priority') parts.push('priority changed')
    else if (k === 'title') parts.push('title changed')
    else if (k === 'description') parts.push('description edited')
    else parts.push(`${k.replace(/Id$/, '')} changed`)
  }
  return parts.length ? parts.join(', ') : 'updated'
}

async function withEmail(p: Person, lookups: WebhookLookups): Promise<Person> {
  if (!p || p.email || !lookups.user) return p
  const u = await safe(() => lookups.user!(p.id))
  return u ? { id: p.id, name: p.name ?? u.name, email: u.email ?? null } : p
}

async function safe<T>(f: () => Promise<T> | undefined): Promise<T | null> {
  try {
    return (await f()) ?? null
  } catch {
    return null
  }
}

function toJson(v: unknown): Json {
  if (v === undefined) return null
  if (typeof v === 'string') return v.length > 500 ? `${v.slice(0, 499)}…` : v
  return JSON.parse(JSON.stringify(v)) as Json
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}
