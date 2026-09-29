# @mp/queue-bullmq

BullMQ (Redis) adapter for the `@mp/queue` port. Only `@mp/server` may import it.

## API

- `bullmqQueue({ connection, prefix?, bus?, logger?, defaultAttempts?, worker?, idlePollMs? }): Queue`
  - `connection`: Redis URL or ioredis options. The adapter owns one ioredis client
    (`maxRetriesPerRequest: null`), shared by its BullMQ queues and workers (workers
    duplicate it for blocking calls), and quits it on `close()`.
  - `prefix`: Redis key prefix, default `mp`.
  - `worker`: `lockDurationMs`, `stalledIntervalMs`, `maxStalledCount` (BullMQ defaults 30 s,
    30 s, 1). A worker that dies leaves its job active; once the lock expires, another
    worker's stalled check moves it back to waiting.
- `toBullPriority`, `encodeName`, `decodeName`: the mappings below, exported for tests.

## Mapping

| Port | BullMQ |
|------|--------|
| `priority` (higher first, default 0) | `priority = clamp(2^20 - p, 1, 2^21)`. Every job is prioritized, also default ones: BullMQ serves its plain wait list before the prioritized set, so leaving priority-0 jobs unprioritized would let them overtake jobs with a positive priority. |
| `delayMs` | `delay` |
| `attempts`, `backoffMs` | `attempts`, `backoff: { type: 'exponential', delay }` |
| `jobId` dedupe | custom `jobId`; `removeOnComplete` / `removeOnFail` so the id can be reused once finished |
| `repeatEveryMs` | job scheduler (`upsertJobScheduler` with `every`, `startDate` for a delay); a registered id is left alone; `removeRepeatable` is `removeJobScheduler`. Iterations report the repeatable's id. |
| `counts()` | `getJobCounts` (waiting = wait + prioritized). Since finished jobs are removed, completed and failed come from a per-queue hash `<prefix>:mp-counts:<queue>`, incremented on the worker's `completed` / final `failed` events. |
| `idle()` | polls counts of every queue this instance has touched until two polls in a row show nothing waiting or active |

Ids and queue names are escaped reversibly (`:` and `%`, and all-digit ids, which
BullMQ refuses). Job data must be JSON-serialisable.

## Tests

`test/contract.test.ts` runs the `@mp/queue` contract, and `test/adapter.test.ts` covers
many jobs, several instances on one prefix, escaping, `defaultAttempts`, `close()` with
active jobs, and stalled-job recovery (a raw BullMQ worker takes a job and stops renewing
its lock; about 0.5 s). Both need `REDIS_URL` and skip otherwise. Each file uses a
unique key prefix and deletes its keys afterwards.

## Replacing it

Implement `Queue` from `@mp/queue` in a new package, run `queueContract`, and switch
`@mp/server`.
