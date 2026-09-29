# @mp/router

Turns events into **deliveries**, and deliveries into runs or inbox items. It's
plain code with no model calls, as described in
[docs/execution.md](../../docs/execution.md#routing).

For each event, in order:

1. **Session tags** (`@employee#slug`) go to that session.
2. **Subscriptions** to the event's subject (with their `types` and sift
   `filter`) go straight to the subscribed sessions. With tags, only tagged
   sessions are expected to act; without, the primary subscriber is.
3. **Resolvers**, registered by higher layers (e.g. chat channel members), add
   recipients.
4. **Employee tags** (`@employee`) go to the employee's router session, unless
   one of its sessions already acts.
5. **Triggers** take work nobody has claimed, into their context (or a fork
   of it).
6. The **fallback** is the employee's router session, or the default router.

Deliveries through subscriptions and tags are *trusted* (expected input).
Triggers and the fallback deliver *untrusted* input, which the receiving
context treats critically.

A delivery for a session that has a continuing run in progress goes into its
**inbox**. If that run is suspended waiting for a delivery, it's woken.
Otherwise a new run is created and queued. The `router.beforeDeliver` hook can
skip or pause deliveries, which is how AI-to-AI streak limits plug in.

## API

- `createRouter(opts)` returns `{ plan(event), route(eventId), deliver(event, delivery) }`.
- `chatTags(event)` and `renderEvent(event)`.
- `beforeDeliver` (hook point), `QUEUES`.

## Tests

`test/router.test.ts` runs full routing scenarios on the in-memory store and
queue.
