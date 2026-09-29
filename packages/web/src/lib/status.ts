import type { RunState, SessionStatus } from '@mp/api'

/**
 * Status language from the stylebook: a small coloured icon in front of the
 * title, never a coloured row. Sessions map to the run states they're in;
 * an active session with no live run (a long-lived context) is `idle`.
 */
export type StatusKey = RunState | 'waiting' | 'idle'

export interface StatusStyle {
  label: string
  /** CSS colour (a token). */
  color: string
  icon: 'circle' | 'circle-dashed' | 'circle-dot' | 'circle-pause' | 'circle-alert' | 'circle-check' | 'circle-x' | 'circle-slash'
  animated?: boolean
}

export const STATUS: Record<StatusKey, StatusStyle> = {
  idle: { label: 'Idle', color: 'var(--fg-tertiary)', icon: 'circle' },
  queued: { label: 'Queued', color: 'var(--fg-quaternary)', icon: 'circle-dashed' },
  running: { label: 'Running', color: 'var(--status-running)', icon: 'circle-dot', animated: true },
  suspended: { label: 'Waiting', color: 'var(--status-waiting)', icon: 'circle-pause' },
  waiting: { label: 'Waiting', color: 'var(--status-waiting)', icon: 'circle-pause' },
  paused: { label: 'Paused', color: 'var(--status-paused)', icon: 'circle-alert' },
  completed: { label: 'Completed', color: 'var(--status-completed)', icon: 'circle-check' },
  failed: { label: 'Failed', color: 'var(--status-failed)', icon: 'circle-x' },
  cancelled: { label: 'Cancelled', color: 'var(--fg-tertiary)', icon: 'circle-slash' },
}

/** The status to show for a session: its live run's state, else its own status. */
export function sessionStatusKey(status: SessionStatus, runState: RunState | null): StatusKey {
  if (runState && ['queued', 'running', 'suspended', 'paused'].includes(runState)) return runState
  switch (status) {
    case 'active':
      return runState === 'failed' ? 'failed' : 'idle'
    case 'waiting':
      return 'waiting'
    case 'done':
      return runState === 'failed' ? 'failed' : 'completed'
    case 'abandoned':
      return 'cancelled'
  }
}

/** Order for grouping lists: live first. */
export const STATUS_ORDER: StatusKey[] = [
  'running',
  'paused',
  'suspended',
  'waiting',
  'queued',
  'idle',
  'failed',
  'completed',
  'cancelled',
]
