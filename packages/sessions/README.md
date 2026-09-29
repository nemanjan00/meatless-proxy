# @mp/sessions

Sessions, the entry tree and its operations, runs and their state machine,
waits, the inbox and templates (layer L3, domain). The design is in
[docs/execution.md](../../docs/execution.md): history is an append-only tree of
entries, a session is a pointer (`head`) into it, and a run is one piece of
work in a session with its own `base` and `tip`.

## API

`createSessions({ records, clock?, bus? }): Sessions`. The full contract is in
[`src/types.ts`](src/types.ts). Record kinds registered on `records.kinds`:
`session` (`ses_`, key `${employeeId}:${slug}`), `run` (`run_`), `inbox`
(`inb_`, key `${sessionId}:${eventId}`), `template` (`tpl_`). Deployments can
extend them with `records.kinds.extend`.

- **Sessions:** `create`, `get`, `require`, `bySlug`, `query`, `update`,
  `history`, `tree`, `children`. Slugs come from the title and are made unique
  per employee (`-2`, `-3`, …). `query` filters by employee, status, root,
  text, `ids` and `excludeRoles` (`meta.role`s to leave out; sessions without
  a role stay), and orders by `createdAt` (default, newest first), `updatedAt`
  or `title`, ties broken by id.
- **Fork and loop:** `fork(sessionId, { atEntry })`, `loop(sessionId, items)`.
  A fork point may be any entry on the session's committed history, any entry
  written by one of the session's runs (including rewound-away branches and
  uncommitted run entries), or any entry on the current path of one of its
  runs. `atEntry: null` forks an empty history. Anything else is a
  `ValidationError`. Forks get a `forked_from` link to their parent.
- **Runs:** `createRun`, `getRun`, `requireRun`, `runs`, `activeContinuingRun`,
  `transition` (compare-and-swap over `RUN_TRANSITIONS`), `updateRun` (never the
  state), `runHistory`, `append`. At most one non-terminal continuing run per
  session: enforced by a unique record key (`continuing:<sessionId>`) that is
  cleared when the run ends, so it holds under concurrency on any store.
- **Commit:** `commit` (CAS: head must still be the run's base, otherwise
  `ConflictError`; idempotent; no-op for a run without entries) and
  `commitSummary` (a `summary` entry on the current head). Both record
  `run.data.committed`.
- **Context management:** `rewind`, `offload`, `restore`, `compact`. They only
  append entries and move the run's tip; old paths keep resolving. Offload and
  restore re-create the entries after the changed one with the same content
  (and `meta.copiedFrom`). `restore` reuses the original entry when it hangs
  off the same parent as the pointer, and re-creates it otherwise. The first
  entry of a history can't be offloaded.
- **Waiting:** `suspend` (running → suspended; `runs` waits also create
  `waits_on` links run → run, removed when the run leaves `suspended`),
  `waitersOf`, `isWaitSatisfied` (a reached `timeoutAt` counts as satisfied),
  `waitResults` (each awaited run's state, result, session document and
  `done`). `run.data.wait` is kept after waking so the resumed run can read the
  results; clear it with `updateRun` if needed.
- **Inbox:** `addToInbox` (idempotent per session and event), `inbox`,
  `takeInbox` (atomic; concurrent takers never get the same item).
- **Templates:** `createTemplate`, `getTemplate`, `templates`,
  `updateTemplate`, `fromTemplate` (fills `{{param}}` in name, instructions and
  document; missing required params are a `ValidationError`). Copying the
  template's checklist is up to the caller (`@mp/checklists`).
- **Search:** `search({ text, employeeId?, sessionIds?, kinds? })` searches
  entry content. Every entry this package appends carries `meta.sessionId`,
  `meta.employeeId` and, for run entries, `meta.runId` (these win over
  caller-supplied meta), so an entry inherited by a fork is attributed to the
  session that wrote it. Session titles and documents are searched separately
  with `searchSessions(text)`.
- Bus topics (`SessionTopics`): `session.created`, `session.head`, `run.state`,
  `inbox.added`, published after the transaction commits.
- Helpers: `slugify`, `fillPlaceholders`, `placeholders`, `snippet`,
  `contentText`, the kind schemas and `SessionRoles`.

Operations that write more than one thing run in one store transaction. CAS
writes that lose a race are retried from scratch, re-checking their
preconditions. A precondition that no longer holds is a `ConflictError`.

## Tests

`npx vitest run --project node packages/sessions`. The behaviour suite lives in
`test/suite.ts` (`sessionsSuite(name, makeStore)`) and runs against the
in-memory store. It also passes against `@mp/store-postgres`, but that run
isn't checked in because domain packages may not import adapters.

## Replacing it

Write a package that implements `Sessions` from `src/types.ts` and passes
`test/suite.ts`, then switch the composition root to it.
