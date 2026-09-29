# @mp/events

Durable events, triggers and subscriptions (docs/spec.md#triggers, docs/execution.md#events).

- **event** (`evt_…`, record key = dedupe key): `source`, `type`, `subject {system, id}`, `actorContactId`, `employeeId`, untrusted `payload`, short `text`, `routed`/`routedAt`, `receivedAt`. A derived `subjectKey` (`system:id`) is stored for queries.
- **trigger** (`trg_…`): routes new events for an employee to a target (`session`, `procedure` or `router`), with `match` (source/type globs, subject globs, `where` dot paths into the event), `priority`, `fork`, `mode`, and a firing counter. A **schedule trigger** has `schedule: { cron, timezone?, graceSeconds? }` instead of a match (docs/spec.md#schedules), and `lastScheduledAt`.
- **subscription** (`sub_…`, record key = `sessionId|subjectKey`): a session's interest in a subject, optionally filtered by event type globs, with a `primary` flag (expected to act on untagged events).

## API

- `createEvents({ records, clock?, bus? })` -> `Events`
  - `ingest(input)` -> `{ event, created }`. Dedupes on `dedupeKey`; without one the key is `source:type:<sha256 of {subject, payload, text}>`. Publishes `event.ingested` `{ eventId, created }`.
  - `get`, `require`, `markRouted(id)` (idempotent), `query({ source?, type?, routed?, subjectKey?, since?, limit? })` (oldest first).
  - `triggers`: `create`, `get`, `update` (`schedule: null` removes a schedule), `list({ employeeId?, enabled? })`, `remove`, `match(event)` (enabled, priority desc then oldest; restricted to `event.employeeId` when set), `recordFired(id)` (CAS, safe under concurrency), `dueSchedules(now?)`, `markScheduled(id, at)`.
  - `subscriptions`: `subscribe` (idempotent, reactivates), `unsubscribe`, `forSubject(subject, eventType?)`, `forSession`, `transfer(from, to)`, `endForSubject(subject, reason)`, `endForSession(sessionId, reason)`. Ended subscriptions stay as records (`active: false`, `endedReason`).
- Schedules: `checkSchedule`, `nextFirings(schedule, from, until, limit?)`, `latestFiring(schedule, now)`, `dueFiring(schedule, last, now)`, `scheduleDedupeKey(triggerId, at)`, `scheduledTriggerId(event)`, `SCHEDULE_SOURCE` / `SCHEDULE_FIRED`.
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
