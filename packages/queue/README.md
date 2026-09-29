# @mp/queue

The queue port: named queues of jobs that carry only ids (Postgres is the source
of truth), with job-id dedupe, delays (timers), priorities, retries with
exponential backoff and repeatable jobs (pollers). See `docs/execution.md`.

## API

- `Queue` (`src/types.ts`): `add(queue, data, opts)`, `process(queue, handler, { concurrency })`,
  `removeRepeatable(queue, jobId)`, `counts(queue)`, `idle()`, `close()`.
- `JobOptions`: `jobId` (dedupe while waiting, delayed or active; reusable after the job
  finished), `delayMs`, `priority` (higher first, FIFO within a priority, default 0),
  `attempts` (default 1), `backoffMs` (retry n waits `backoffMs * 2^(n-1)`, default 1000),
  `repeatEveryMs` (needs `jobId`; first run right away or after `delayMs`).
- `QueueTopics` / `QueueJobEvent`: `queue.completed` after each successful job, `queue.failed`
  after a job's last failed attempt, published when the queue was given a bus.
- `memoryQueue({ bus?, logger? })`: in-process implementation with real timers. Jobs added
  before any `process()` wait for a processor. `idle()` ignores delayed jobs. `close()`
  stops timers, drops pending retries and waits for active jobs; `add()` then throws
  `UnavailableError`.
- `@mp/queue/contract`: `queueContract(name, make, { timeScale })`, the vitest suite every
  implementation must pass. `make({ bus })` returns a fresh queue.

## Tests

`test/memory.test.ts` runs the contract against `memoryQueue`; `test/memory-unit.test.ts`
covers memory-only details. The whole suite takes about 2 seconds (delays of 20-100 ms).

## Replacing it

Write a package implementing `Queue`, run `queueContract` against it, and switch the
composition root in `@mp/server`. `@mp/queue-bullmq` is the Redis adapter.
