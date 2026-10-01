# @mp/checklists

What "done" means for a session (layer L3, domain, after `@mp/sessions`). See
[Checklists in the spec](../../docs/spec.md#checklists).

## API

`createChecklists({ records, sessions, clock?, bus? }): Checklists`. Registers
the kind `checklist` (`chk_`, one per session, record key = session id).

- `forSession(sessionId)`: the checklist, created empty on first use.
- `fromTemplate(sessionId, items)`, `addItem(sessionId, { text, required = true, review = false, addedBy? })`.
  Item ids are short and never reused (`i1`, `i2`, …).
- `check(sessionId, itemId, evidenceEntryIds, { runId? })`: every evidence id
  must be on `sessions.runHistory(runId)` (the run must belong to the session)
  or, without a run, on the session's committed history, and must be a
  `tool_result`, `event` or `user` entry (`EVIDENCE_KINDS`), or a pointer
  standing for one (an offloaded tool result). Anything else is a
  `ValidationError` naming each bad id. Checking again with new evidence
  clears an earlier review verdict.
- `requestReview(sessionId, itemId)` (the item must be checked; it then needs
  review), `recordReview(sessionId, itemId, { passed, notes?, reviewerSessionId })`
  (the reviewer must be an existing, different session; `DeniedError`
  otherwise).
- `uncheck`, `removeItem(sessionId, itemId, { force?, actor? })`. Required items
  need `force: true` and an `actor`, recorded in the revision. **Whether that
  actor (the requester or owner) may do it is the caller's check**, e.g. the
  stdlib tool's.
- `status(sessionId)` → `{ complete, total, done, missing }`. An item is done
  when it is checked and, if it needs review, the review passed (`isItemDone`).
  `complete` means every required item is done. `missing` lists the required
  items that aren't.
- Every change publishes `checklist.changed` `{ sessionId, checklistId }`
  (`ChecklistTopics.changed`).

Changes are compare-and-swap on the checklist record, retried when they lose a
race, so concurrent edits are never lost.

## Tests

`npx vitest run --project node packages/checklists`, with the in-memory store
and the real `@mp/sessions`.

## Replacing it

Implement `Checklists` from `src/checklists.ts` in a new package with the same
tests, and switch the composition root to it.
