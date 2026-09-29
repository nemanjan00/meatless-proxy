# @mp/events

Durable events, triggers and subscriptions (docs/spec.md#triggers, docs/execution.md#events).

- **event** (`evt_…`, record key = dedupe key): `source`, `type`, `subject {system, id}`, `actorContactId`, `employeeId`, untrusted `payload`, short `text`, `routed`/`routedAt`, `receivedAt`. A derived `subjectKey` (`system:id`) is stored for queries.
- **trigger** (`trg_…`): routes new events for an employee to a target (`session`, `procedure` or `router`), with `match` (source/type globs, subject globs, `where` dot paths into the event), `priority`, `fork`, `mode`, and a firing counter.
- **subscription** (`sub_…`, record key = `sessionId|subjectKey`): a session's interest in a subject, optionally filtered by event type globs, with a `primary` flag (expected to act on untagged events).

## API

- `createEvents({ records, clock?, bus? })` -> `Events`
  - `ingest(input)` -> `{ event, created }`. Dedupes on `dedupeKey`; without one the key is `source:type:<sha256 of {subject, payload, text}>`. Publishes `event.ingested` `{ eventId, created }`.
  - `get`, `require`, `markRouted(id)` (idempotent), `query({ source?, type?, routed?, subjectKey?, since?, limit? })` (oldest first).
  - `triggers`: `create`, `get`, `update`, `list({ employeeId?, enabled? })`, `remove`, `match(event)` (enabled, priority desc then oldest; restricted to `event.employeeId` when set), `recordFired(id)` (CAS, safe under concurrency).
  - `subscriptions`: `subscribe` (idempotent, reactivates), `unsubscribe`, `forSubject(subject, eventType?)`, `forSession`, `transfer(from, to)`, `endForSubject(subject, reason)`, `endForSession(sessionId, reason)`. Ended subscriptions stay as records (`active: false`, `endedReason`).
- Helpers: `subjectKey`, `internalSubject(id)` (`{ system: 'mp', id }`), `defaultDedupeKey`, `triggerMatches(match, eventData)`, schemas, `EventTopics`.

Globs are `globMatch` from `@mp/core` (`*` within a dot segment, `**` across).

## Tests

`npx vitest run --project node packages/events`, against `memoryStore()`.

## Replacing it

Implement the `Events` interface in a new package at the same layer and switch the composition root.
