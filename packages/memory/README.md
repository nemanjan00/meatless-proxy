# @mp/memory

Memory that lasts beyond a session: one fact per `memory` record (`mem_`), scoped, linked and recallable.

## API

`createMemory({ records, clock? })` registers the `memory` kind and returns:

- `remember(input)`: creates a memory, or updates the one with the same normalized summary in the same scope and employee
  workspace (enforced with a record key, so concurrent remembers don't duplicate). `id` updates (or creates) that memory.
  `about: Ref[]` links it with role `about`; project/contact scopes are linked automatically. Returns `{ memory, created }`.
- `get`, `require`, `update` (the dedupe key follows summary/scope changes). `memoryKey(data)` is that key, for callers
  that check for the existing memory first (the server's Memory page does, before a person adds one).
- `recall({ text?, refs?, kinds?, context?, limit? })`: keyword scoring (summary 3, content 1 per keyword) plus 5 per matching
  ref (linked or scoped to it). Without text or refs it lists the most recent. With `context: { employeeId, projectIds,
  contactIds }` only visible memories come back: shared or the employee's own, company-scoped or scoped to one of the given
  projects/contacts. Without `context` nothing is filtered (for admin tools and the UI).
- `visible(memory, context)`, `link(memoryId, ref, role = 'about')`, `unlink`, `links`, `forget` (deletes with links), `verify`.

## Tests

`test/memory.test.ts` with `memoryStore()` and `ManualClock`: dedupe, scopes, concurrency, visibility, link recall, verify, forget.

## Replacing it

Same `MemoryService` interface (e.g. with embeddings for recall), same kind.
