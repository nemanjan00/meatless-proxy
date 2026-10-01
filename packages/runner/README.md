# @mp/runner

Executes runs, as described in [docs/execution.md](../../docs/execution.md).

- **Context assembly** (`renderMessages`): the history is rendered as OpenAI
  chat messages, the same way every time, so cached prefixes stay valid.
  Untrusted events are marked. Tool calls without a result get a synthetic
  answer.
- **Step loop:**
  1. Take inbox items (continuing runs only).
  2. Context management (below): compact automatically near the limit, or
     note how full the context is.
  3. Check `beforeModelCall` (budgets can pause here).
  4. Call the model, streaming `model.delta` on the bus.
  5. Record the assistant entry, and the context size on the run
     (`run.data.context`: prompt tokens, window, characters, threshold noted).
  6. Execute its tool calls at the top of the next iteration, so a crash
     between steps can be recovered.
- **Tools:**
  - allow and deny lists, and the session's fixed toolset
  - `beforeToolCall` (can deny)
  - secret variables injected at call time and redacted from outputs
  - `afterToolCall` (transform)
  - control signals: suspend, commit, discard, rewind, offload, restore,
    compact, end
- **Context window** (`src/context-window.ts`):
  - The window comes from `contextWindow(model)` (the server passes
    `MODEL_CONTEXT_TOKENS`), else `contextWindowOf` in `@mp/model` (a table of
    known models, else 128k).
  - Before each model call the runner estimates the request's tokens from its
    characters, calibrated by the ratio the previous call of the run measured
    (prompt tokens per character; 3.5 characters a token before the first).
  - **Notes:** at `contextNotes` (50% and 75%) a short `system` entry
    (`meta.contextNote`) tells the model its size and what to do. Once per
    threshold per crossing: `run.data.context.noted` keeps the highest one noted, and
    falling back below it (a rewind, offload or compaction) arms it again. A
    new run starts from the notes in its history since the last summary, so a
    continuing session isn't told twice. Never added while tool calls are open.
  - **Automatic compaction** at `compactAt` (85%; 0 = off), or when the
    provider says the request is too long: one model call without tools asks
    for a summary (`COMPACTION_PROMPT`, `compactSummaryMaxTokens` 8000), then
    `sessions.compact(run, summary, { keepFrom, meta: { automatic: true } })`
    keeps the latest entries verbatim (`compactKeep`, 15% of the window or of
    the request if smaller; a turn is kept whole or summarised whole). Usage
    of the summary call goes through `afterModelCall`. `context.compacted` or
    `context.compact_failed` on the bus. A failed summary never fails the run;
    if the request then can't fit (the estimate is over the window, or the
    provider refuses it again) the run pauses with `context full: …`.
  - **Oversized tool results:** a result whose text is over
    `toolResultMaxChars` (20,000; 0 = off) is stored in full (its entry) and
    offloaded at once: a pointer (`meta.automatic`) with its head and tail and
    how to read the rest (`sessions.restore`, in pieces or whole) answers the
    call. Results with images are left alone. `context.result_offloaded`.
  - A pointer standing for a tool result (`toolCallId`) is rendered as that
    call's tool message, so the history stays a valid tool exchange.
- **Images:** a tool may return `images` (`ImageRef`s); the tool result entry
  keeps them, never the bytes. Before each model call the image resolver
  (`createImageResolver`, `src/images.ts`) loads them with `loadImage` (a small
  in-memory cache of hits). Without `vision`, tools tagged `vision` aren't
  offered or run ("this model can't see images"), and images in the history
  become a short note.
- **Crash recovery:** the run resumes from its journal. Read and idempotent
  calls without a result are run again. Non-idempotent calls are marked
  *uncertain*, so the model checks before retrying.
- **Finishing:**
  - `beforeFinish` can block, like a Stop hook, so policies such as docs
    maintenance or the checklist gate plug in there. After `maxFinishBlocks`
    blocks the run pauses for a person.
  - Continuing runs commit. Ephemeral runs commit only when asked to.
  - If the session's head moved in the meantime, the run commits a summary on
    top of the new head.
- **Limits** (`limitsFor(run, session)`, read before a run starts and before
  every model call; the server takes them from `@mp/usage`):
  - `maxSteps` (default `opts.maxSteps`, 60): model calls per run, then it
    pauses. Resuming gives another allowance (`stepsFrom`).
  - `maxWallMs` (default `opts.maxWallMs`, none): time the run has worked
    (`activeMs` plus the time since `runningSince`; time suspended, paused or
    queued doesn't count). Checked between steps, so a tool call in progress
    is never cut off; the run pauses with the reason (`limitPaused: 'wall'`),
    and resuming gives a fresh allowance.
  - `maxConcurrentRuns`: a queued run whose employee already has that many
    runs `running` stays queued and is tried again after
    `concurrencyRetryMs` (3 s); `run.deferred` on the bus. It's a soft cap:
    two workers starting at the same moment can both get through.
- **Waiting:** a suspended run holds no worker. Children finishing, deliveries
  and timers (delayed queue jobs) wake it, and it resumes with the results.
- **Errors:** `unavailable` errors (e.g. the provider is down) are rethrown, so
  the queue retries the job and the run resumes. Any other error fails the run.

## API

- `createRunner(opts)` returns `{ execute(runId), wake(runId), enqueue(runId, opts) }`.
- Hook points: `beforeModelCall`, `afterModelCall`, `beforeToolCall`,
  `afterToolCall`, `beforeFinish`, `afterRun`.
- `renderMessages`, `lastAssistantText`, `answeredCall`, `RUNS_QUEUE`, `RunLimits`.
- Context: `ContextTopics`, `contextNoteDecision`, `notedInHistory`,
  `compactionCut`, `COMPACTION_PROMPT`, `isContextOverflow`, `requestChars`,
  `estimateTokens`.

## Tests

`test/runner.test.ts` covers full scenarios with the scripted model and the
in-memory stack: tools, ephemeral and committed runs, summary commits,
children and waits, budgets, policies, secrets, crash recovery, retries,
inbox, max steps and bus events. `test/limits.test.ts` covers the wall clock
(manual clock: paused between steps, not mid-tool; fresh allowance on resume;
time across a suspend), step allowances from `limitsFor`, and the concurrency
cap. `test/context.test.ts` covers context management: notes once each and
never between a call and its result, automatic compaction (kept turns, pairs
never split, the summary recorded, ephemeral versus continuing runs), a
failing summary call, overflow from the provider, pauses when nothing fits,
and oversized tool results (preview, pointer, restore). An opt-in live check
is `packages/server/test/context-live.test.ts` (`MP_LIVE_MODEL_TEST=1`).
