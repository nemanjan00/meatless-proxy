# Execution model

**Status: draft for review.** Nothing here is implemented yet. It proposes how
the features in the [spec](spec.md) actually run: how events come in, how work
is scheduled, how sessions and their history are stored, and what happens when
something crashes. The [decisions to review](#decisions-to-review) are listed
first. The rest of the document explains them.

## Decisions to review

| #  | Decision | Section |
|----|----------|---------|
| 1  | Postgres is the database and the source of truth. **BullMQ** (on Redis) is the job queue and the timer. Queue state can always be rebuilt from Postgres. | [Storage](#storage-and-processes) |
| 2  | Session history is an append-only **tree of entries**, like git commits. A session is a pointer to one entry (its head). | [History](#history-as-an-entry-tree) |
| 3  | Fork, rewind, offload and commit are pointer operations on that tree, and none of them copy or delete history. | [History](#history-operations) |
| 4  | A **run** is the unit of scheduling. Each runnable run is a BullMQ job. Workers are stateless, and BullMQ's job locks and stalled-job detection hand crashed runs to another worker. | [Runs](#runs) |
| 5  | Every step is journaled before and after it happens, so a crashed run resumes from its last step, not from the start. | [Steps](#steps-and-journaling) |
| 6  | Waiting (for children, people, containers or time) **suspends** the run and frees the worker. A completion event wakes it up again. | [Suspending](#suspending-and-waking) |
| 7  | Side effects go through an **outbox** with idempotency keys. After a crash, an effect whose outcome is unknown is never blindly retried. | [Side effects](#side-effects) |
| 8  | Routing is **deterministic code**, not a model call. The model only gets involved in the router session, for input that nothing else claims. | [Routing](#routing) |
| 9  | One continuing run per session at a time. Ephemeral runs of the same session can run in parallel. New events wait in the session's inbox and are injected at the next step. | [Concurrency](#concurrency-per-session) |
| 10 | Commit is compare-and-swap on the session head. If the head moved in the meantime, the run commits a summary on top of the new head. | [Commit](#commit) |
| 11 | The context sent to the model is assembled in a fixed order, and only grows at the end, so prefixes stay cacheable. | [Context assembly](#context-assembly) |
| 12 | Limits are checked before every model call and at every fork or loop. Pause and kill are flags checked at step boundaries. | [Limits](#limits-pause-and-kill) |
| 13 | Everything runs in Docker in deployment: one app container (API, web UI and the agent loop) with the Docker socket, plus Postgres and Redis. Development needs no Docker. | [Deployment](#deployment) |

## Overview

```
  sources                ingest           route             queue            execute
 ─────────              ────────         ───────           ───────          ─────────
 MCP notifications ─┐
 MCP pollers ───────┤                  subscriptions
 webhooks ──────────┼──► events ──────► tags         ──►   runs    ──────►  workers ──► model (OpenAI API)
 harness chat ──────┤    (deduped)     triggers            (queued)          │     ──► tools (stdlib, MCP)
 schedules/timers ──┤                  router session                        │     ──► containers, git
 web UI ────────────┘                                                        │
                                                                             ▼
                                  new events (completions, replies, results) ◄── journal, outbox, usage
```

Everything in the diagram is a table, a queue, or a process that reads and
writes them. Nothing lives only in a process's memory.

## Storage and processes

**Postgres** holds all state ([database first](spec.md#database-first)).
Extension fields on contacts, projects and the rest are `jsonb`, validated
against the schema the deployment declared. `LISTEN/NOTIFY` pushes changes to
the web UI for live updates.

**BullMQ**, on Redis, is the job queue. It was chosen because it's easy to
test and gives us retries, delays, priorities and rate limits out of the box.

- **Queues:** `events` (to route), `runs` (to execute), `effects` (outbox
  deliveries), `pollers` (MCP pollers, as repeatable jobs).
- **Timers:** schedules, timeouts, retry backoff and `wait` timeouts are
  delayed or repeatable BullMQ jobs, so there's no separate scheduler.
- **Postgres stays the source of truth.** A job only carries ids, e.g. "run
  `r42`". The worker loads the actual state from Postgres. Rows are written
  before their job is enqueued, so a job never refers to something that
  doesn't exist yet.
- **Rebuildable.** If Redis loses its data, the queues are rebuilt from
  Postgres: every run in `queued`, every event not yet routed, and every effect
  not yet delivered is enqueued again. Duplicate jobs are harmless, because
  job ids are the row ids and state changes in Postgres are guarded (a run
  can only move from `queued` to `running` once).

The harness has a few process roles:

| Role      | Does                                                               |
|-----------|--------------------------------------------------------------------|
| ingest    | receives webhooks, MCP notifications, runs MCP pollers, writes `events` |
| router    | turns events into runs, deterministically                          |
| worker    | executes runs: model calls, tool calls, containers                 |
| web       | the [web UI](spec.md#web-ui) and its API, live updates via `NOTIFY` |

**For now the loop stays local:** all roles run in one Node process, together
with the API and the web UI. That host also has the
[git cache](spec.md#git-repositories) and Docker. BullMQ workers are what
would move to other processes or hosts later. That doesn't change the model,
but runs that need a checkout will need to stick to the host that holds it.

## Events

Every input is first written as a row in `events`, before anything acts on it:

| Field        | Notes                                                        |
|--------------|--------------------------------------------------------------|
| `id`         |                                                              |
| `source`     | e.g. `mcp:linear`, `mcp:slack`, `chat`, `timer`, `ui`, `git`, `run` |
| `type`       | e.g. `task.assigned`, `message.posted`, `run.completed`      |
| `dedupe_key` | unique; source + external id, so the same notification delivered twice is stored once |
| `subject`    | the thing it's about: a task, thread, PR, session…           |
| `actor`      | the contact who caused it, resolved through `handles`, if known |
| `payload`    | the raw content, kept as untrusted data                      |
| `received`   |                                                              |

- **MCP inbound** (an open question in the spec). The proposal is to support
  all three ways, each normalised into `events` by an adapter: MCP
  notifications where the server sends them, pollers where it doesn't
  (a poller calls a list tool periodically and diffs the result against what
  it saw last time), and webhooks received by the ingest role.
- **The harness's own events.** Run completed, run failed, child finished,
  container job done, timer fired, limit reached. These are events too, so
  waking a parent is the same mechanism as receiving a Slack message.

## Routing

The router takes each new event and decides, **in code**, which session or
sessions get it. The first rule that matches wins, except that subscriptions
and tags combine as described below:

1. **Session tag.** `@employee#slug` delivers to that session.
2. **Subscriptions.** Every session subscribed to the event's `subject`
   receives it, if the subscription's event-type globs and its optional
   **filter** match. A filter is a MongoDB-style JSON query evaluated with
   [sift](https://github.com/crcn/sift.js), e.g.
   `{ "payload.author.kind": "contact" }`. Triggers take the same kind of
   filter, so both stay plain data. If the event carries tags, only
   tagged sessions are marked *expected to act*. Without tags, the subscriber
   marked **primary** at subscribe time is expected to act. The others get it
   as context. This is the proposed answer to "which subscriber handles each
   event".
   **Resolvers** registered by higher layers add recipients. For example, the
   sessions that are members of a chat channel get its messages, but aren't
   expected to act.
3. **Employee tag.** `@employee` delivers to that employee's router session,
   unless one of that employee's sessions already acts on the event.
   **Follow-ups** count as a tag: a person's untagged reply in a chat thread
   goes to the employees whose sessions already posted in it (their router
   session, unless one of their sessions already acts), so nobody has to tag
   an employee again to continue a conversation. Replies from AIs don't, so
   this can't loop.
4. **Triggers.** The first matching trigger, by source, type and filters,
   delivers to its assigned context.
5. **Fallback.** Anything left over goes to the router session of the employee
   whose scope covers the subject, or to the deployment's default router
   session.

Only the router sessions in steps 3 and 5 involve a model. That's where
[untrusted input](spec.md#untrusted-input) is judged critically, and where
work nobody has claimed gets assigned.

A session never receives its own messages back. Each delivery also carries
whether the input is **trusted**: it is when it came through a subscription,
a direct tag or membership, and it isn't when it came through a trigger or
the fallback. Untrusted input is marked when it's rendered for the model.

The router's output is a **delivery** per receiving session, which either
becomes a new run or goes into the inbox of a run that's already going (see
[concurrency](#concurrency-per-session)).

## History as an entry tree

A session's history is stored as **entries**. An entry is one item in the
history (a message, a tool call, a tool result, an event, a summary, or a
pointer), and it points to its parent entry:

| Field       | Notes                                                           |
|-------------|-----------------------------------------------------------------|
| `id`        |                                                                 |
| `parent`    | previous entry, or none for a root                              |
| `kind`      | `system`, `user`, `assistant`, `tool_call`, `tool_result`, `event`, `summary`, `pointer` |
| `content`   | a hash into a content-addressed `blobs` table                   |
| `run`       | the run that created it                                         |
| `usage`     | tokens, for entries produced by a model call                    |

- Entries are **never modified or deleted**. That's how "no context is lost"
  is guaranteed.
- Content is stored once by hash, so a 200 KB tool output that appears in 50
  forks is stored once.
- A **session** has a `head`: the entry its history currently ends at. Its
  history is the path from the root to `head`.
- A **"point" in history** (an open question in the spec) is simply any entry.

### History operations

All of them create entries or move pointers. None of them rewrite or delete
anything.

| Operation | What happens in the tree |
|-----------|--------------------------|
| fork      | a new session whose `head` is the chosen entry. Nothing is copied. |
| loop      | *n* forks from the same entry, each with one `user` entry for its item on top |
| commit    | the session's `head` moves to the run's last entry ([compare-and-swap](#commit)) |
| ephemeral | the run's entries stay in the tree for the log and the UI, but `head` never moves to them |
| rewind    | a new `summary` entry whose parent is the earlier entry, and `head` moves to it. The detailed branch stays in the tree. |
| offload   | a new `pointer` entry replaces the message. The entries after it are re-created on top with the same content hashes, so it's cheap, but the cached prefix is invalid from that point on. |
| restore   | the same thing in reverse: the original entry goes back into the path |
| compact   | the same as rewind to the root, with a summary of everything. It's done only when required and recorded like any other operation. |

The web UI can show all of this as a tree. Every summary and pointer links to
the branch or entry it stands for.

## Runs

A **run** is the unit of scheduling: one piece of work in one session.

| Field     | Notes                                                              |
|-----------|--------------------------------------------------------------------|
| `id`      |                                                                    |
| `session` |                                                                    |
| `mode`    | `continuing` (committed by default) or `ephemeral`                 |
| `base`    | the session's `head` when the run started                          |
| `tip`     | the run's latest entry                                             |
| `state`   | see below                                                          |
| `cause`   | the event or delivery that started it                              |
| `worker`  | which worker holds it, while running                               |
| `wait`    | what it's waiting for, while suspended                             |

The default mode comes from how the run started: a subscription or a direct
tag gives `continuing`, and a trigger or loop item gives `ephemeral`. A
template or trigger can override it. This is the proposed answer to "can a
trigger or template set the default".

```
            ┌───────────── resume ──────────────┐
            ▼                                   │
 queued ──► running ──► suspended ──(event)──► queued
   ▲          │   │
   │          │   └──► completed | failed | cancelled
   │          ▼
   └─resume─ paused   (limit reached, supervisor, person, kill switch)
```

- **Claiming.** A run in `queued` has a job in the `runs` queue. A worker picks
  up the job, and moves the run to `running` in Postgres, but only if it's
  still `queued`.
- **Crash.** BullMQ holds a lock on the job while the worker renews it. If the
  worker dies, BullMQ detects the stalled job and gives it to another worker,
  which resumes the run from its journal.
- **Priority.** Runs caused by a person, such as a chat reply or a UI action,
  get a higher job priority than background runs. There's a concurrency cap
  per employee (BullMQ groups or rate limits), so one busy employee can't
  starve the others.

## Steps and journaling

A run is a loop of **steps**. A step is one model call, or one tool call. Each
step is journaled:

1. **Before:** write the step's intent: the request, or the tool name and
   arguments.
2. **Do it.**
3. **After:** write the result as an entry and move the run's `tip`.

On resume, the worker reads the journal:

- A step with a result is done, so it moves on.
- A **model call** with no result is simply made again. The only cost is
  tokens.
- A **tool call** with no result goes through the
  [side effects](#side-effects) rules.

## Suspending and waking

Anything that takes a while **suspends** the run instead of holding a worker:

| Waiting for                     | Wakes on event          |
|---------------------------------|-------------------------|
| `wait` on children (one, some, all) | `run.completed` / `run.failed` of the children |
| a person's reply or approval    | `message.posted` in the thread, or an approval event |
| a container job (build, tests)  | `job.finished`          |
| a timeout or a delay            | `timer.fired`           |

- A suspended run holds no memory and no worker. Thousands of them cost nothing
  but rows in a table.
- The wake condition is stored on the run (e.g. `all of [r1, r2, r3]`, with an
  optional timeout). When the condition is met, the run goes back to `queued`.
  When it resumes, it gets the results as a `tool_result` entry for its
  `wait` call.
- Long tools such as container jobs are asynchronous: the tool returns a
  handle straight away, and the model can `wait` on it or keep working.
- **Timeouts and cancelling children** (an open question in the spec): `wait`
  takes an optional timeout, and a parent can cancel any of its children.
  Cancelling is a flag the child sees at its next step.

## Side effects

Every tool is registered with an **effect class**:

| Class          | Examples                                  | After a crash                      |
|----------------|-------------------------------------------|------------------------------------|
| read           | read a doc, search, list tasks            | retry                              |
| idempotent     | post in harness chat, set metadata, update a ticket field | retry with the same idempotency key |
| non-idempotent | post in Slack, create a ticket, send email | **don't retry**: mark it *uncertain* |

- Writes go through an **outbox**: the intent is stored with an idempotency key
  (run id plus step number) before the call is made, and the outcome after.
- For **uncertain** effects, the run resumes with a note in its history
  ("this call may or may not have happened"). The model then checks, e.g. by
  reading the thread or searching for the ticket, before deciding to retry.
  This is what a person would do after a network error.
- The harness's own systems (chat, database, git branches, containers) are
  designed to be idempotent, so uncertainty only comes from outside systems.
- Transient failures are retried with backoff. After the retry limit, the step
  fails, the model sees the error, and it decides what to do.

## Concurrency per session

The spec asks what happens when events arrive faster than a context can handle
them. The proposal:

- **One `continuing` run per session at a time.** It is the only kind of run
  that normally moves `head`, and running them one at a time keeps a
  continuing conversation coherent.
- **The inbox.** A delivery for a session that already has a `continuing` run
  goes into the session's inbox. At the next step boundary, the worker appends
  all pending inbox items as `event` entries, so the model sees them mid-task,
  like a person noticing a new message. If no run is going, the delivery
  starts one.
- **Ephemeral runs in parallel.** Ephemeral runs don't move `head`, so several
  can run at once from the same `head`, up to a per-session limit, e.g. an
  intake context handling ten new tasks at once. Beyond the limit, they queue.
- **Ordering.** Deliveries to one session are processed in the order they were
  received.

## Commit

Commit moves the session's `head` from the run's `base` to its `tip`, as a
**compare-and-swap**:

- If `head` is still `base`, it simply moves. This is the normal case.
- If `head` moved in the meantime (another run committed first), the run's
  history no longer follows on from the current head. The run then commits a
  **summary** instead: it produces a `summary` entry (one extra model call) and
  appends it on top of the new head. Its full branch stays in the tree.
- Committing a run as a summary on purpose uses the same path.

## Context assembly

The request sent to the model is built in a fixed order, so that the prefix
stays the same across calls, runs and forks:

1. **Employee prompt**: identity, personality and interaction rules. This is
   the same for every session of that employee.
2. **Tool definitions**, in a fixed order. The tool set is fixed when the
   session is created, because changing it in the middle breaks the cache.
3. **Session history**, from the root to `base`. It's shared with every fork
   and every earlier run.
4. **Run entries**, from `base` to `tip`.
5. **New inbox events**, appended at the end.

- Anything that changes per call, like the current time, a budget warning or an
  uncertain-effect note, goes at the end, never earlier.
- Relevant memories and linked docs are loaded **once**, as entries when the
  session or run starts, not re-injected in every call.
- Entries are rendered to OpenAI messages the same way every time, byte for
  byte.

## Limits, pause and kill

- **Budget ledger.** Every model call writes its `usage`. Before each model
  call, the worker checks the budgets that apply (run, session, tree, then
  the day or month of the requester, the employee and the deployment) against
  the ledger. Deployment defaults apply without configuration; limit records
  override them per target, the most specific winning.
- **Step and wall-clock limits.** Before each model call the worker also
  checks the run's steps and the time it has worked (`activeMs` plus the time
  since it last started running; waits, pauses and queue time don't count).
  Over either, it pauses between steps, never in the middle of a tool call.
  Resuming gives a fresh allowance.
- **Runs at once.** A queued run whose employee already has its cap of runs
  `running` isn't started: its job is re-queued with a short delay.
- **Fork and loop checks.** Depth, fan-out and the number of sessions running
  at once are checked when a fork or loop is created. A loop that would go over
  the limit isn't started at all.
- **AI-to-AI streak.** The router counts messages between employees in a thread
  since a person last took part. Past the limit, deliveries in that thread
  pause.
- **Reaching a limit** puts the run in `paused` and posts to the requester or
  owner. They can resume it (optionally with a higher limit) or cancel it.
- **Pause and kill** are flags at the run, session, tree, employee and global
  level. Workers check them at every step boundary. Kill also aborts a model
  call or container job that's in progress. The global flag is the kill switch
  the spec asks about.
- **Supervisor hooks.** Lifecycle events (a run finishing, a tree growing past
  *n* sessions, budgets at 80 % (also posted in `#alerts`), AI-to-AI streaks, uncertain effects,
  suspicious input) are published as events that the
  [supervisor](spec.md#supervisor)'s triggers subscribe to. The supervisor
  pauses things by setting the same flags. It has its own budget.

## Checkouts and environments

- A git **checkout** (worktree) belongs to a **session**, not to a run. It's
  created when the session first needs it and removed when the session ends.
  Its forks get their own worktree from the same commit.
- A container **environment** also belongs to a session. It's torn down when
  the session ends, or when it has been idle for a set time.
- Both are recorded in the database, so a crashed worker's checkouts and
  containers can be found and cleaned up, or reattached when the run resumes.

## What this proposes for open questions in the spec

| Spec question | Proposed answer |
|---------------|-----------------|
| How are MCP inbound events delivered? | All three: notifications, pollers, webhooks, normalised into `events`. |
| What is a "point" in history? | Any entry. |
| Can two sessions in a tree be merged? | Not as a tree operation. One session reads the other's result or summary and commits that. |
| Does `wait` take a timeout, can children be cancelled? | Yes and yes. |
| Can a trigger or template set the run mode default? | Yes. It defaults from how the run started. |
| Events faster than a context can handle? | Inbox for continuing runs, parallel ephemeral runs up to a limit. |
| Which of several subscribers handles an event? | Tagged ones, else the primary subscriber. The others get it as context. |
| Global kill switch? | Yes, as the global pause/kill flag. |

## Secrets and tools at call time

- The worker resolves a tool call against the [tool registry](spec.md#tool-registry)
  and checks it against the employee's whitelist and blacklist again. A call to a
  tool that isn't allowed fails without running.
- It then injects the tool's [secret variables](spec.md#secrets) that are in
  scope, like env vars, only for the duration of the call. The values never go
  into entries, the journal or the outbox.
- Outputs are redacted for secret values before they're stored as entries.

## Deployment

**Everything runs in Docker containers** when deployed:

| Container | Contains                                                          |
|-----------|-------------------------------------------------------------------|
| app       | the API, the web UI and the agent loop (all roles), in one Node process |
| postgres  | the database                                                      |
| redis     | BullMQ's queues                                                   |

- The **app** container mounts the host's **full Docker socket**, with no
  proxy in between. It uses it to start and stop the
  [project environments](spec.md#docker-orchestration) as sibling containers
  on the host, not nested inside itself.
- This is an accepted risk: full socket access means the app has root-level
  control of the host. That's why the host should be dedicated to the
  harness, and why the model never gets raw Docker access. It only reaches
  Docker through the harness's own environment tools, which set the limits,
  networks and mounts.
- The git cache and harness data live in volumes mounted into the app
  container.
- Project environments get their own networks, separate from the harness's
  network, so a project container can't reach Postgres or Redis.
- It ships as one `compose.yaml`.

**Development doesn't need Docker.** The app runs directly with Node, against
a local Postgres and Redis installed through **asdf** and pinned in
`.tool-versions` (see the [README](../README.md#development)). Docker is only needed to work on the Docker
orchestration itself, and for the deployed setup. Tests for every other part
run without it.

## Not covered here yet

- **Language and framework.** BullMQ means the back end is Node, presumably in
  TypeScript. The web UI is React, Tailwind and shadcn/ui
  ([stylebook](stylebook.md)). Frameworks (API server, ORM or query builder)
  are still to be chosen.
