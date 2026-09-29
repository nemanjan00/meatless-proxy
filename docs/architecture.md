# Architecture

This is how the code is organised. [spec.md](spec.md) says *what* the harness
does, and [execution.md](execution.md) says *how it runs*. This document says
*where each piece lives* and how pieces are allowed to depend on each other.

The architecture is built for one thing above all: **we are experimenting**.
Any component can be thrown away and written again from scratch without
touching the rest.

## Rules

1. **Components are packages.** Each component is an npm workspace package
   under `packages/`, with its own public API (`src/index.ts`) and its own
   tests. Nothing imports another package's internals, only its index.
2. **Dependencies flow one way: down.** Every package has a layer. A package
   may only depend on packages in **lower** layers. High-level code depends on
   low-level code, never the other way around, and there are no cycles. This
   is enforced by `npm run check:deps`, which fails the build.
3. **Feedback goes up through hooks and the event bus.** When low-level code
   has to tell high-level code something (a run finished, a record changed, a
   tool is about to be called), it publishes on the **event bus** or calls a
   **hook**. Both are defined in `@mp/core`. The high-level code registers
   handlers. The low-level code never knows who is listening.
4. **Ports and adapters.** Everything outside the process (database, queue,
   model provider, MCP servers, Docker, git, secrets) is reached through a
   **port**: a generic interface in its own package, which also ships an
   in-memory implementation and a **contract test suite**. Real
   implementations are **adapters** in separate packages. Only the composition
   root (the server) knows which adapter is used.
5. **Generic interfaces.** Ports are shaped around what the harness needs,
   not around one product. For example, `RecordStore` stores any kind of
   record with an extendable schema, not "contacts". A new module usually
   needs no new storage code.
6. **Replaceable means: same interface, same contract tests.** To rewrite a
   component, write a new package that implements the same interface and
   passes the same contract tests. Then switch the composition root to it.

## Layers

```
 L6  app          server (API, WebSocket, workers, composition root) · web (UI)
                    │
 L5  stdlib       stdlib: the model's tools (sessions.*, chat.*, docs.*, …)
                    │
 L4  engine       router · runner
                    │
 L3  domain       records · directory · memory · skills · files · events · sessions · checklists · chat · tools · usage
                    │
 L2  adapters     store-postgres · queue-bullmq · model-openai · mcp-sdk · containers-docker · git-cli · secrets-store
                    │   (only the server may depend on adapters)
 L1  ports        store · queue · model · mcp · containers · git · secrets · api
                    │
 L0  foundation   core: ids, errors, clock, logger, event bus, hooks, schema
```

| Layer | Package | Responsibility |
|-------|---------|----------------|
| L0 | `@mp/core` | ids, typed errors, clock, logger, **event bus**, **hooks**, schema definitions for extendable records |
| L1 | `@mp/store` | `RecordStore`, `LinkStore`, `EntryStore` + in-memory implementation + contract tests |
| L1 | `@mp/queue` | `Queue` (jobs, delays, priorities, repeat) + in-memory implementation + contract tests |
| L1 | `@mp/model` | `ModelClient` (OpenAI-compatible chat completions shape) + scripted fake |
| L1 | `@mp/mcp` | `McpHub` (servers, tools, calls, notifications) + fake |
| L1 | `@mp/containers` | `ContainerRuntime` (environments, jobs, logs) + fake |
| L1 | `@mp/git` | `GitCache` (mirrors, fetch, worktrees, push) + protected-branch guard + fake |
| L1 | `@mp/secrets` | `SecretStore`, injection and redaction helpers + in-memory implementation |
| L1 | `@mp/api` | HTTP and WebSocket contract types shared by server and web |
| L2 | `@mp/store-postgres` | Postgres adapter for `@mp/store`, with SQL migrations |
| L2 | `@mp/queue-bullmq` | BullMQ adapter for `@mp/queue` |
| L2 | `@mp/model-openai` | OpenAI-compatible HTTP adapter for `@mp/model` (Kimi first) |
| L2 | `@mp/mcp-sdk` | MCP adapter using the official MCP SDK |
| L2 | `@mp/containers-docker` | Docker adapter (dockerode) for `@mp/containers` |
| L2 | `@mp/git-cli` | git CLI adapter for `@mp/git` |
| L2 | `@mp/secrets-store` | encrypted secrets stored through `@mp/store` |
| L3 | `@mp/records` | generic extendable records: kinds, schemas, validation, links with roles, docs with id links, backlinks, revisions |
| L3 | `@mp/directory` | contacts, employees (identity, personality, scope, tool lists), projects, procedures |
| L3 | `@mp/memory` | memory entries, recall, scoping |
| L3 | `@mp/sessions` | sessions, the entry tree and its operations (fork, loop, commit, rewind, offload, restore, compact), runs and their state machine, templates, waits |
| L3 | `@mp/chat` | harness chat: channels, threads, messages, members, tags |
| L3 | `@mp/events` | events (ingest, dedupe), triggers, subscriptions |
| L3 | `@mp/tools` | tool registry, effect classes, allow and deny lists, the tool handler interface and control signals |
| L3 | `@mp/usage` | usage ledger, limits and budgets |
| L3 | `@mp/checklists` | checklists, evidence rules, review requests |
| L3 | `@mp/skills` | company-level and project-level skills |
| L3 | `@mp/files` | each employee's filesystem, and sharing |
| L4 | `@mp/router` | events → deliveries → runs or inbox items, deterministically |
| L4 | `@mp/runner` | executes a run: context assembly, model calls, tool calls, journal, outbox, secrets, redaction, suspend and wake, commit |
| L5 | `@mp/stdlib` | the model's standard library of tools, built on the domain packages |
| L6 | `@mp/server` | composition root, config, HTTP API, WebSocket, webhook ingest, workers, migrations at startup, health checks, seed data |
| L6 | `@mp/web` | the web UI (React, Tailwind, shadcn/ui), see [stylebook.md](stylebook.md) |

### Allowed dependencies

| From \ may use | L0 | L1 ports | L2 adapters | L3 domain | L4 engine | L5 stdlib |
|----------------|----|----------|-------------|-----------|-----------|-----------|
| L1 ports       | ✓  | –        |             |           |           |           |
| L2 adapters    | ✓  | ✓        | –           |           |           |           |
| L3 domain      | ✓  | ✓        |             | lower domain only (see below) |  |           |
| L4 engine      | ✓  | ✓        |             | ✓         | –         |           |
| L5 stdlib      | ✓  | ✓        |             | ✓         |           | –         |
| L6 server      | ✓  | ✓        | ✓           | ✓         | ✓         | ✓         |
| L6 web         | ✓  | `@mp/api` only |       |           |           |           |

- Within the domain layer, `@mp/records` is the base. The others may depend on
  `@mp/records` and on the domain packages listed before them in
  `scripts/layers.json`, so the order is explicit and cycles can't form.
- The two L4 packages don't depend on each other, and neither depends on
  `@mp/stdlib`. The runner calls tools only through the `ToolRegistry`
  interface from `@mp/tools`. The stdlib provides the handlers, and the server
  registers them.
- Ports never depend on each other, so each one can be replaced on its own.

## Storage model

Almost everything is stored through three generic stores from `@mp/store`.

| Store | Holds | Key operations |
|-------|-------|----------------|
| `RecordStore` | **records**: every kind of thing (contact, project, procedure, memory, session, run, event, trigger, subscription, channel, message, checklist, usage, effect, …), as `{kind, id, version, key?, data}` | create (optionally unique by `key`), get, update with an expected `version` (compare-and-swap), delete, query by fields and text, sum, and the revision history of every change with its actor |
| `LinkStore` | **links** between any two records, with a role and extra fields | link, unlink, query from either end, filter by role, with referential integrity |
| `EntryStore` | the **entry tree** of session history, with content-addressed blobs | append, get, path from root to an entry, children |

- **Extendable schemas** live in `@mp/records`. Each kind declares its core
  fields, and a deployment adds extension fields. Validation happens in the
  domain layer, so the stores stay generic.
- **Transactions:** `store.transaction(fn)` runs a function with all three
  stores bound to one transaction.
- **Changes are published** on the event bus (`record.changed`,
  `link.changed`, `entry.appended`), which is how the WebSocket gets live
  updates.
- The Postgres adapter maps them onto a handful of tables (`records`,
  `record_revisions`, `links`, `entries`, `blobs`), created by numbered
  migrations. See [Migrations](#migrations).

## Event bus and hooks

Both are in `@mp/core` and in-process.

- **Event bus:** `bus.publish(topic, payload)` and
  `bus.subscribe(topic | pattern, handler)`. It's fire-and-forget, for
  notifications that flow upwards: `record.changed`, `run.state`,
  `step.started`, `model.delta` (streaming tokens), `tool.called`,
  `usage.recorded`. Handler errors are logged and never reach the publisher.
- **Hooks:** named extension points that can **decide** something, e.g.
  `runner.beforeModelCall` (the limits check can pause the run),
  `runner.beforeToolCall` (permission, allow list and secrets checks can deny
  the call) and `runner.afterToolCall` (redaction). A hook point is declared by
  the package that calls it. Higher packages register handlers, in order, and
  any handler can stop the chain with a decision.
- **Durable events are different.** Events from outside, and lifecycle
  events that must survive a crash, are **records** (kind `event`) and go
  through the queue. The bus is only for in-process feedback and live
  updates, and losing a bus message never loses work.

## Composition root

`@mp/server` is the only place that knows about concrete adapters:

```ts
const store = config.DATABASE_URL ? await postgresStore(config) : memoryStore()
const queue = config.REDIS_URL    ? bullmqQueue(config)         : memoryQueue()
const model = config.MODEL_FAKE   ? scriptedModel(script)       : openAiModel(config)
…
const records  = createRecords({ store, bus })
const sessions = createSessions({ store, records, bus })
…
const runner = createRunner({ sessions, tools, model, secrets, usage, hooks, bus, … })
registerStdlib(tools, { sessions, chat, directory, memory, git, containers, … })
```

The same wiring with only in-memory adapters and a scripted model is what the
end-to-end tests use, so a whole scenario runs in milliseconds with no
services.

## Live updates

The server publishes a **WebSocket** at `/ws`. A client subscribes to
channels such as `session:<id>`, `run:<id>`, `chat:<channel id>`, `records:<kind>`
or `now`. The server forwards matching bus events: new entries, run state
changes, streamed model output, tool calls, checklist changes, usage. The UI
loads the current state over HTTP, then applies changes from the socket.

## Migrations

- Schema changes are **numbered SQL migration files** in
  `packages/store-postgres/migrations/` (`0001_init.sql`, `0002_…`). They are
  forward-only, and each runs in a transaction.
- Applied migrations are recorded in a `schema_migrations` table.
- The server applies pending migrations **at startup**, under a Postgres
  advisory lock, so several app instances starting at once can't race.
  `npm run migrate` does the same on its own.
- Domain schema changes (new record kinds, new extension fields) need no
  migration, because they're data in `records`.

## Configuration

- All configuration comes from **environment variables** (and `.env` in
  development). They are validated at startup against one schema in
  `@mp/server`. A missing or invalid value stops startup with a clear message.
- Adapters are chosen by configuration: no `DATABASE_URL` means the in-memory
  store, no `REDIS_URL` means the in-memory queue. This is for tests and demos
  only. Deployments always set both.

## Install and deployment

`docker compose up` is the install. `compose.yaml` at the repo root starts:

| Service    | Image / build | Notes |
|------------|---------------|-------|
| `app`      | built from the root `Dockerfile` | API, web UI, WebSocket and workers. Runs migrations at startup. Mounts the Docker socket and the `data` volume (git cache). |
| `postgres` | `postgres:18` | `pgdata` volume, health check |
| `redis`    | `redis:8`     | `redisdata` volume (append-only file), health check |

- The `Dockerfile` is multi-stage: install and build, then a slim runtime
  image that serves the built web UI as static files from the same server.
- The app waits for Postgres and Redis to be healthy (`depends_on` with
  `condition: service_healthy`).
- Health checks: `GET /healthz` (the process is up) and `GET /readyz`
  (database and queue reachable, migrations applied).
- Graceful shutdown: on `SIGTERM` the server stops taking jobs, lets running
  steps reach a boundary, closes the queue and the database, then exits.
- Configuration goes in `.env`, which compose reads. See `.env.example`.

Development doesn't use Docker at all. See the
[README](../README.md#development).

## Testing

| Kind | Where | What |
|------|-------|------|
| unit | each package, `test/*.test.ts` | the package's own logic, with fakes for everything below it |
| contract | exported by each port package, run by every implementation | the same behaviour for the in-memory implementation and every adapter |
| adapter | each adapter package | the contract suite against the real service (Postgres, Redis) when its URL is set. Docker is tested against a mocked Docker API. MCP is tested against a real MCP server over an in-memory transport. git is tested against local repositories. |
| end-to-end | `@mp/server` | whole scenarios through the composition root: an event comes in, is routed, runs, forks, waits, commits, posts in chat, with a scripted model. They run once with in-memory adapters, and once with Postgres and BullMQ when those are available. |
| architecture | `scripts/check-deps.ts` | the layering rules and the absence of cycles |
| leaks | `scripts/check-secrets.ts` | no keys, tokens or private keys in tracked files |
| lint | Biome | formatting and lint rules |

CI (GitHub Actions) runs all of these on every push and pull request, with
Postgres and Redis as service containers, so the adapter and end-to-end tests
run against the real services there.

- The test runner is **vitest**. `npm test` runs everything that can run in
  the current environment. Tests that need a service skip themselves, with a
  message, when that service isn't configured.
- **The model is always faked** in tests, except one opt-in smoke test that
  makes a single tiny call to the real provider (`MP_LIVE_MODEL_TEST=1`).

## Conventions

- **TypeScript**, ESM, `strict`. Packages are consumed as TypeScript source
  (`exports` points at `src/index.ts`). The server runs with `tsx` in
  development and is bundled for the Docker image.
- **Ids** are prefixed and sortable, e.g. `ses_01J…`, `run_01J…`, `ent_01J…`
  (a prefix per kind, then a time-ordered random part).
- **Errors** are typed (`NotFoundError`, `ConflictError`, `ValidationError`,
  `DeniedError`, …) from `@mp/core`, and the API maps them to HTTP status
  codes.
- **Time** comes from the injected `Clock`, never `Date.now()` directly, so
  tests control it.
- **Logging** is structured JSON through the injected `Logger`.
- **No package reads environment variables** except `@mp/server`.

## Replacing a component

1. Create a new package, e.g. `packages/runner-v2`, at the same layer.
2. Implement the same public interface. For a port, run the port's contract
   suite against it.
3. Add it to `scripts/layers.json`.
4. Switch the composition root in `@mp/server` to use it.
5. Delete the old package when you're happy.

Nothing above the replaced component changes, because it depends on the
interface. Nothing below it changes, because it never knew about it.
