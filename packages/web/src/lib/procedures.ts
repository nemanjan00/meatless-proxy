import type { ProcedureContextState, ProcedureStart, ProcedureStartKind } from '@mp/api'

/** The steps template a new procedure starts from: the four sections every procedure answers. */
export const STEPS_TEMPLATE = `## When to use

Who asks for this, and how you can tell it applies.

## Steps

1. First step.
2. Second step.
3. Third step.

## Done when

What is true when the work is finished, and who is told.

## Escalate if

When to stop and ask the owner instead.
`

/** A context state, for people: what it means and what to do about it. */
export const CONTEXT_STATE: Record<ProcedureContextState, { label: string; color: string; hint: string }> = {
  ready: { label: 'Ready', color: 'var(--green)', hint: 'Runs start with the current steps already read.' },
  stale: {
    label: 'Out of date',
    color: 'var(--orange)',
    hint: 'The procedure changed after its context was built. New runs still follow the old steps until you rebuild it.',
  },
  missing: { label: 'Not built', color: 'var(--fg-quaternary)', hint: 'Built on the first run, or when you rebuild it.' },
}

/** The kinds of start the "How it starts" form offers, in order. */
export const START_KINDS: { kind: Exclude<ProcedureStartKind, 'custom'>; label: string; hint: string }[] = [
  { kind: 'manual', label: 'Manually', hint: 'Someone presses Run now, or an employee starts it from its work.' },
  { kind: 'channel', label: 'A chat channel', hint: 'Every new message from a person in the channel starts a run.' },
  { kind: 'tag', label: 'An @tag', hint: 'A chat message that tags it, e.g. @access-request, starts a run.' },
  { kind: 'schedule', label: 'A schedule', hint: 'It runs by itself at set times.' },
  { kind: 'integration', label: 'An integration event', hint: 'GitLab, Linear or Slack: a merge request, an issue, a message.' },
]

/** Common schedules, as cron expressions. */
export const SCHEDULE_PRESETS: { label: string; cron: string }[] = [
  { label: 'Every weekday at 09:00', cron: '0 9 * * 1-5' },
  { label: 'Every Monday at 09:00', cron: '0 9 * * 1' },
  { label: 'Every Friday at 16:00', cron: '0 16 * * 5' },
  { label: 'Every day at 02:00', cron: '0 2 * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'On the 1st of every month at 09:00', cron: '0 9 1 * *' },
]

/** A tag from a name: `Access request` → `access-request`. */
export function tagFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

/** An empty start of a kind, for the form. */
export function emptyStart(kind: ProcedureStartKind, name = ''): ProcedureStart | null {
  switch (kind) {
    case 'manual':
      return null
    case 'channel':
      return { kind: 'channel', channelId: '' }
    case 'tag':
      return { kind: 'tag', tag: tagFor(name) }
    case 'schedule':
      return { kind: 'schedule', cron: '0 9 * * 1' }
    case 'integration':
      return { kind: 'integration', source: 'integration:gitlab', type: 'merge_request.opened' }
    case 'custom':
      return { kind: 'custom' }
  }
}

/** A random idempotency key for one form submission. */
export function newKey(): string {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
