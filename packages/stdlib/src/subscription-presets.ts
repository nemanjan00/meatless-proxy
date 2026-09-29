import type { Json } from '@mp/core'

/**
 * What a subscription listens to when nobody says otherwise, per kind of
 * subject. A session that owns a thread, an issue or a merge request wants
 * the conversation and the outcomes, not every event about it. Subscribing to
 * everything is an explicit choice (`all: true`).
 */
export const DEFAULT_SUBSCRIPTION_TYPES: Record<string, string[]> = {
  // Harness chat threads.
  mp: ['message.replied', 'message.edited', 'message.deleted', 'reaction.added'],
  slack: ['message.replied', 'message.edited', 'message.deleted', 'message.mentioned', 'reaction.added'],
  linear: ['comment.*', 'issue.state_changed', 'issue.assigned', 'issue.unassigned', 'issue.removed', 'issue.updated'],
  gitlab: ['comment.created', 'pipeline.*', 'job.failed', 'merge_request.*', 'issue.*'],
}

/** Named filters a session can apply instead of writing one. */
export const SUBSCRIPTION_PRESETS: Record<string, { description: string; types?: string[]; filter?: Json }> = {
  people_only: {
    description: 'Only events caused by people, not by AI sessions.',
    filter: {
      $or: [{ 'payload.author.kind': 'contact' }, { 'payload.by.kind': 'contact' }, { actorContactId: { $exists: true } }],
    },
  },
  conversation: {
    description: 'Replies, edits and reactions in the thread or on the ticket.',
    types: ['message.replied', 'message.edited', 'reaction.added', 'comment.*'],
  },
  outcomes: {
    description: 'Only results: pipelines and jobs, state changes, merges and closes.',
    types: ['pipeline.*', 'job.failed', 'issue.state_changed', 'issue.removed', 'merge_request.merged', 'merge_request.closed'],
  },
  failures: {
    description: 'Only failures: failed pipelines and jobs.',
    types: ['pipeline.failed', 'job.failed'],
  },
}

export interface SubscriptionScope {
  /** `null`: every event type (clears types on an existing subscription). */
  types?: string[] | null
  /** `null`: no filter (clears it on an existing subscription). */
  filter?: Json | null
}

/**
 * The event types and filter for a subscription: an explicit `types`/`filter` wins, then a named
 * preset, then the defaults for the subject's system. `all` subscribes to everything on purpose.
 */
export function subscriptionScope(
  system: string,
  opts: { types?: string[]; filter?: Json; preset?: string; all?: boolean } = {},
): SubscriptionScope {
  if (opts.all) return { types: null, filter: opts.filter ?? null }
  const preset = opts.preset ? SUBSCRIPTION_PRESETS[opts.preset] : undefined
  if (opts.preset && !preset)
    throw new Error(`unknown subscription preset ${opts.preset} (one of ${Object.keys(SUBSCRIPTION_PRESETS).join(', ')})`)
  const types = opts.types ?? preset?.types ?? DEFAULT_SUBSCRIPTION_TYPES[system]
  const filter = opts.filter ?? preset?.filter
  return { ...(types ? { types } : {}), ...(filter !== undefined ? { filter } : {}) }
}
