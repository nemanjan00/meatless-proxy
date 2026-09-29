# @mp/events

Durable events, triggers and subscriptions (docs/spec.md#triggers, docs/execution.md#events).

- **event** (`evt_…`, record key = dedupe key): `source`, `type`, `subject {system, id}`, `actorContactId`, `employeeId`, untrusted `payload`, short `text`, `routed`/`routedAt`, `receivedAt`. A derived `subjectKey` (`system:id`) is stored for queries.
- **trigger** (`trg_…`): routes new events for an employee to a target (`session`, `procedure` or `router`), with `match` (source/type globs, subject globs, `where` dot paths into the event), `priority`, `fork`, `mode`, and a firing counter. A **schedule trigger** has `schedule: { cron, timezone?, graceSeconds? }` instead of a match (docs/spec.md#schedules), and `lastScheduledAt`.
- **scheduled_task** (`tsk_…`): a scheduled task or follow-up (docs/spec.md#scheduled-tasks): `kind` (`task` or `follow_up`), `instruction`, `when` (`{type:'once', at}` or `{type:'cron', cron}`), `timezone`, `graceSeconds`, `employeeId`, `requesterId`, `sessionId` (where firings run), `sessionMode` (`continue` or `fresh`), `report` (`{type:'chat', channelId, threadId?}` or `{type:'subject', subject}`), `enabled`, `done`, `lastScheduledAt`, `fired`, `lastFiredAt`, `lastRun`.
- **subscription** (`sub_…`, record key = `sessionId|subjectKey`): a session's interest in a subject, optionally filtered by event type globs, with a `primary` flag (expected to act on untagged events).

## API

- `createEvents({ records, clock?, bus? })` -> `Events`
  - `ingest(input)` -> `{ event, created }`. Dedupes on `dedupeKey`; without one the key is `source:type:<sha256 of {subject, payload, text}>`. Publishes `event.ingested` `{ eventId, created }`.
  - `get`, `require`, `markRouted(id)` (idempotent), `query({ source?, type?, routed?, subjectKey?, since?, limit? })` (oldest first).
  - `triggers`: `create`, `get`, `update` (`schedule: null` removes a schedule), `list({ employeeId?, enabled? })`, `remove`, `match(event)` (enabled, priority desc then oldest; restricted to `event.employeeId` when set), `recordFired(id)` (CAS, safe under concurrency), `dueSchedules(now?)`, `markScheduled(id, at)`.
  - `subscriptions`: `subscribe` (idempotent, reactivates), `unsubscribe`, `forSubject(subject, eventType?)`, `forSession`, `transfer(from, to)`, `endForSubject(subject, reason)`, `endForSession(sessionId, reason)`. Ended subscriptions stay as records (`active: false`, `endedReason`).
- Schedules: `checkSchedule`, `nextFirings(schedule, from, until, limit?)`, `latestFiring(schedule, now)`, `dueFiring(schedule, last, now)`, `scheduleDedupeKey(triggerId, at)`, `scheduledTriggerId(event)`, `SCHEDULE_SOURCE` / `SCHEDULE_FIRED`.
- Scheduled tasks: `createScheduledTasks({ records, clock? })` -> `ScheduledTasks`: `create`, `get`, `require`, `list({ employeeId?, kind?, sessionId?, requesterId?, enabled? })`, `update` (a new time re-arms a one-off and starts from now; resuming skips passed slots), `remove`, `due(now?)` (read-only; one-offs past their grace come back `missed`), `markFired(id, at, eventId?)` (forward only, a one-off is done), `markMissed`, `markRunNow(id, eventId)`, `recordRun(id, run)` (newest firing wins, the same firing is updated), `nextRun(task, now?)`. `scheduledTaskEvent(task, at, opts?)` builds the `scheduled_task.fired` ingest input (instruction first, who asked, where to report; dedupe key `scheduled_task:<id>:<ISO time>`), `scheduledTaskId(event)`, `describeWhen`, `reportHint`, `checkWhen`, `checkReport`.
- Times (`when.ts`): `parseAt(input, tz, now)` (ISO with an offset, a wall-clock time in `tz`, `today|tomorrow|<weekday> [at] <time>`; future only, at most 400 days ahead), `parseDuration` (`2 hours`, `1h30m`, `in 3 days`), `parseEvery` (`weekday at 09:00`, `monday, thursday at 9am`, `month on the 1st`, `30 minutes` → cron), `describeCron` (the way back), `zonedTime` (a wall-clock time in a zone; skipped DST times move forward, repeated ones are the first), `formatLocal`, `parseClock`, `checkTimeZone`.
- Helpers: `subjectKey`, `internalSubject(id)` (`{ system: 'mp', id }`), `defaultDedupeKey`, `triggerMatches(match, eventData)`, schemas, `EventTopics`.

## Schedule triggers

- `schedule.cron` is a 5-field (or 6-field, seconds first) cron expression or a preset like `@daily`, parsed with `cron-parser`, read in `schedule.timezone` (an IANA name, default `UTC`). Invalid expressions or time zones are a `ValidationError` on create and update. A schedule trigger's `match` must be empty.
- `dueSchedules(now)` is read-only. For each enabled schedule trigger it returns the latest firing in `(lastScheduledAt, now]` if it is at most `graceSeconds` (default 300) old. Older missed firings are never replayed. `lastScheduledAt` starts at creation, and is reset to now when the schedule changes or the trigger is enabled again, so past slots don't fire then.
- To fire, ingest a `schedule.fired` event (source `schedule`, `payload.triggerId`) with `dedupeKey: scheduleDedupeKey(triggerId, at)` (`schedule:<triggerId>:<ISO time>`), then call `markScheduled(id, at)`, which only moves forward. The dedupe key makes racing ticks, restarts and second instances fire once. The server's scheduler does this (`packages/server/src/scheduler.ts`).
- Routing: `match()` never returns schedule triggers for ordinary events. A `schedule.fired` event from source `schedule` returns exactly its trigger (when it is enabled and has the event's employee), so the router needs no special case.
- DST: a wall-clock time that doesn't exist fires at the first valid moment after it. One that happens twice fires once, because firings are iterated forward from the last one.

Globs are `globMatch` from `@mp/core` (`*` within a dot segment, `**` across).

## Tests

`npx vitest run --project node packages/events`, against `memoryStore()`.

## Replacing it

Implement the `Events` interface in a new package at the same layer and switch the composition root.
