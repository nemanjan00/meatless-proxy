# @mp/runner

Executes runs, as described in [docs/execution.md](../../docs/execution.md).

- **Context assembly** (`renderMessages`): the history is rendered as OpenAI
  chat messages, the same way every time, so cached prefixes stay valid.
  Untrusted events are marked. Tool calls without a result get a synthetic
  answer.
- **Step loop:**
  1. Take inbox items (continuing runs only).
  2. Check `beforeModelCall` (budgets can pause here).
  3. Call the model, streaming `model.delta` on the bus.
  4. Record the assistant entry.
  5. Execute its tool calls at the top of the next iteration, so a crash
     between steps can be recovered.
- **Tools:**
  - allow and deny lists, and the session's fixed toolset
  - `beforeToolCall` (can deny)
  - secret variables injected at call time and redacted from outputs
  - `afterToolCall` (transform)
  - control signals: suspend, commit, discard, rewind, offload, restore,
    compact, end
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
- **Waiting:** a suspended run holds no worker. Children finishing, deliveries
  and timers (delayed queue jobs) wake it, and it resumes with the results.
- **Errors:** `unavailable` errors (e.g. the provider is down) are rethrown, so
  the queue retries the job and the run resumes. Any other error fails the run.

## API

- `createRunner(opts)` returns `{ execute(runId), wake(runId), enqueue(runId, opts) }`.
- Hook points: `beforeModelCall`, `afterModelCall`, `beforeToolCall`,
  `afterToolCall`, `beforeFinish`, `afterRun`.
- `renderMessages`, `lastAssistantText`, `RUNS_QUEUE`.

## Tests

`test/runner.test.ts` covers full scenarios with the scripted model and the
in-memory stack: tools, ephemeral and committed runs, summary commits,
children and waits, budgets, policies, secrets, crash recovery, retries,
inbox, max steps and bus events.
