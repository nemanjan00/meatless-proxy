// ─── Schedules: scheduled tasks and follow-ups ─────────────────────────────────────
//
// Served by packages/server/src/schedules (docs/spec.md#scheduled-tasks). Everyone signed in sees them
// (a task of a private, DM session only its members); creating one is for members; running, pausing,
// editing and deleting one is for admins and the person who asked for it (`canManage`).

import type { EmployeeSummary } from './resources.ts'

/** A task the employee carries out, or a follow-up a session left for itself. */
export type ScheduleKind = 'task' | 'follow_up'

/** When it fires, as stored: once at an ISO time, or on a cron schedule in `timezone`. */
export type ScheduleWhen = { type: 'once'; at: string } | { type: 'cron'; cron: string }

/** When, as a person gives it: exactly one of these. */
export interface ScheduleWhenInput {
  /** Once: ISO with an offset, or a wall-clock time in the time zone (`2026-10-02 16:00`, `friday 16:00`). */
  at?: string
  /** Once, after a delay: `2 hours`. */
  in?: string
  /** Recurring, in words: `weekday at 09:00`, `monday, thursday at 9am`, `month on the 1st at 09:00`. */
  every?: string
  /** Recurring, as a 5-field cron expression. */
  cron?: string
}

/** The state of a task's last firing (`missed`: its time passed while the harness was down). */
export type ScheduleRunState = 'queued' | 'running' | 'suspended' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'missed'

export interface ScheduleLastRun {
  at: string
  state: ScheduleRunState
  runId?: string
  sessionId?: string
  /** The start of the run's final answer or error. */
  output?: string
  /** Run now, not on schedule. */
  manual?: boolean
}

export interface ScheduleReportTarget {
  /** e.g. `thread in #finance`, `#finance`, `slack:C123/1700.1`. */
  label: string
  channelId?: string
  threadId?: string
  subject?: { system: string; ref: string }
}

export interface ScheduledTask {
  id: string
  kind: ScheduleKind
  /** The instruction; for a follow-up, its note. */
  instruction: string
  when: ScheduleWhen
  timezone: string
  /** In words, with the time zone: `every weekday 09:00 Europe/Belgrade`, `once, Fri 2026-10-02 16:00 Europe/Belgrade`. */
  description: string
  enabled: boolean
  /** A one-off that already ran (or was missed). */
  done: boolean
  nextRunAt: string | null
  employee: EmployeeSummary
  requester: { id: string; name: string } | null
  /** Where its runs happen: the task's own session, or the session a follow-up wakes. */
  session: { id: string; title: string; slug: string } | null
  /** `continue`: every run in the same session; `fresh`: a new fork of it each time. */
  sessionMode: 'continue' | 'fresh'
  report: ScheduleReportTarget | null
  lastRun: ScheduleLastRun | null
  fired: number
  createdAt: string
  /** Whether the viewer may run, pause, edit and delete it: admins, and the person who asked. */
  canManage: boolean
}

export interface ScheduleQuery {
  employeeId?: string
  kind?: ScheduleKind
  /** Only those that run in this session (its follow-ups, or the task it belongs to). */
  sessionId?: string
}

/** `POST /api/schedules`. */
export interface ScheduleCreateBody {
  employeeId: string
  instruction: string
  when: ScheduleWhenInput
  /** IANA name. Default: the company time zone. */
  timezone?: string
  /** Where it reports: a harness chat thread or channel. Default: nowhere (the result is kept on the task). */
  report?: { threadId?: string; channelId?: string }
  sessionMode?: 'continue' | 'fresh'
}

/** `PATCH /api/schedules/:id`. */
export interface SchedulePatchBody {
  instruction?: string
  when?: ScheduleWhenInput
  timezone?: string
  enabled?: boolean
  sessionMode?: 'continue' | 'fresh'
  /** `null` removes it. */
  report?: { threadId?: string; channelId?: string } | null
}

/** `GET /api/schedules/preview`: what a schedule means, and when it would fire. */
export interface SchedulePreview {
  when: ScheduleWhen
  timezone: string
  description: string
  /** The next firings (ISO), at most five; one for a one-off. */
  next: string[]
}

/** The routes of this section (merged into `ROUTES`). */
export const SCHEDULE_ROUTES = {
  schedules: ['GET', '/api/schedules'],
  createSchedule: ['POST', '/api/schedules'],
  previewSchedule: ['GET', '/api/schedules/preview'],
  updateSchedule: ['PATCH', '/api/schedules/:id'],
  deleteSchedule: ['DELETE', '/api/schedules/:id'],
  runSchedule: ['POST', '/api/schedules/:id/run'],
} as const

/** The client methods of this section (part of `ApiClient`). */
export interface SchedulesApi {
  /** `GET /api/schedules?employeeId=&kind=&sessionId=` → scheduled tasks and follow-ups, next to fire first, then the finished ones. */
  schedules(query?: ScheduleQuery): Promise<{ items: ScheduledTask[] }>
  /** `POST /api/schedules` → a new task, with its own session; the caller is who asked (members). */
  createSchedule(body: ScheduleCreateBody): Promise<ScheduledTask>
  /** `GET /api/schedules/preview?at=|in=|every=|cron=&timezone=` → the schedule in words and its next firings (400 when it's invalid). */
  previewSchedule(when: ScheduleWhenInput & { timezone?: string }): Promise<SchedulePreview>
  /** `PATCH /api/schedules/:id` → changes it: instruction, when, time zone, report, pause (`enabled: false`) and resume. */
  updateSchedule(id: string, patch: SchedulePatchBody): Promise<ScheduledTask>
  /** `DELETE /api/schedules/:id` → deletes it (a task's session is marked done). 204. */
  deleteSchedule(id: string): Promise<void>
  /** `POST /api/schedules/:id/run` → runs it now, outside its schedule. Not for follow-ups. */
  runSchedule(id: string): Promise<{ task: ScheduledTask; eventId: string }>
}

type Call = <T>(
  route: keyof typeof SCHEDULE_ROUTES,
  params?: Record<string, string>,
  query?: Record<string, string | number | boolean | undefined | null>,
  body?: unknown,
) => Promise<T>

/** The `SchedulesApi` half of `createApiClient`. */
export function schedulesMethods(call: Call): SchedulesApi {
  return {
    schedules: (q = {}) => call('schedules', undefined, { ...q }),
    createSchedule: (body) => call('createSchedule', undefined, undefined, body),
    previewSchedule: (w) => call('previewSchedule', undefined, { ...w }),
    updateSchedule: (id, patch) => call('updateSchedule', { id }, undefined, patch),
    deleteSchedule: (id) => call('deleteSchedule', { id }),
    runSchedule: (id) => call('runSchedule', { id }, undefined, {}),
  }
}
