# @mp/server

The composition root (layer L6): the only package that knows the concrete
adapters and reads environment variables. It wires every adapter and domain
service, and runs the HTTP API, the WebSocket, the MCP server, the web UI and
the queue workers in one Node process.

```sh
npm run dev        # tsx watch packages/server/src/main.ts (loads .env)
npm start          # the same, without watching
npm run migrate    # apply pending database migrations and exit
npm run seed       # create the default employee, channels and trigger (idempotent)
```

## Configuration

Environment variables, validated at startup with zod (`src/config.ts`). An
invalid value stops startup with a message naming the variable; values are
never printed. In development (`NODE_ENV` not `production`) `.env` is loaded
first by a small built-in loader; variables already set win.

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port (API, `/ws`, `/mcp`, web UI) |
| `HOST` | `0.0.0.0` | Bind address |
| `DATABASE_URL` | none: in-memory store | Postgres URL. Migrations run at startup under an advisory lock |
| `DATABASE_SCHEMA` | `public` | Postgres schema of the tables |
| `REDIS_URL` | none: in-memory queue | Redis URL for BullMQ |
| `REDIS_PREFIX` | `mp` | Redis key prefix |
| `OPENAI_BASE_URL` | none | OpenAI-compatible endpoint, e.g. `https://api.kimi.com/coding/v1` |
| `OPENAI_API_KEY` | none | Provider key (sent only as the `Authorization` header) |
| `MODEL` | none | Default model, e.g. `kimi-k2-7-code`. Required with `OPENAI_BASE_URL` |
| `SECRETS_KEY` | ephemeral (warning) | Master key (16+ characters) encrypting stored secrets. Required with `DATABASE_URL` |
| `DATA_DIR` | `./.data/app` | Harness data (git stores, worktrees) |
| `GIT_CACHE_DIR` | `$DATA_DIR/git` | Git stores, one per employee: `<dir>/<employeeId>/<host>/<path>` |
| `WORKTREES_DIR` | `$DATA_DIR/worktrees` | Session worktrees |
| `DOCKER_ENABLED` | `false` (`true` in compose) | Use the Docker runtime for project environments (`env.*` tools) |
| `DOCKER_SOCKET` | dockerode default | Docker socket path |
| `MCP_SERVERS` | `[]` | JSON array of MCP servers, or a path to a JSON file (see below) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` (JSON lines) |
| `MP_BOOTSTRAP` | `true` | Seed an empty store at startup |
| `MP_WEB_DIST` | `packages/web/dist` | Built web UI to serve, if present |
| `PRICING` | `{}` | JSON `{ "<model>": { "inputPerM", "outputPerM", "cachedInputPerM"? } }` (USD per million tokens) |
| `RUN_CONCURRENCY` | `4` | Runs executed at once by this process |
| `RUN_ATTEMPTS` | `5` | Attempts per run job (an unavailable provider is retried, the run resumes from its journal) |
| `RUN_BACKOFF_MS` | `2000` | First retry delay, doubled per attempt |
| `MAX_STEPS` | `60` | Model calls per run before it pauses |
| `MAX_TOKENS` | none | `max_tokens` per model call (leave room for reasoning) |
| `ALERTS_ENABLED` | `true` | Post alerts in `#alerts` (see [Alerts](#alerts)) |
| `ALERT_PAUSED_MINUTES` | `30` | Alert about a run paused longer than this |
| `ALERT_UNAVAILABLE_COUNT` | `3` | Alert when a dependency had this many `unavailable` errors… |
| `ALERT_UNAVAILABLE_MINUTES` | `10` | …within this many minutes |
| `NODE_ENV` | | `production` disables `.env` loading |
| `DOTENV_PATH` | `.env` | Where the development `.env` is |

### MCP servers

`MCP_SERVERS` entries are `McpServerConfig` (`name`, `transport: stdio | http`,
`command`/`args` or `url`, `env`, `secrets`: header or env var name to secret
name) plus optional:

- `effect` / `effects: { <tool>: effect }`: effect class of the server's tools (default `non_idempotent`).
- `employee`: the employee whose triggers handle this server's events.
- `events: [{ method, type?, subjectFrom?, subjectSystem?, idFrom?, actorFrom?, textFrom? }]`:
  how notifications become events. `method` may be a glob. Paths are dot paths
  into the notification's params. Without a mapping, the type is the method,
  the subject is `params.uri` (resource notifications), and the dedupe key is
  `mcp:<server>:<method>:<sha256 of the params>`.

Every server tool is registered as `mcp.<server>.<tool>`; every notification
becomes an event with source `mcp:<server>`, routed like any other.

## HTTP API

Exactly the routes of `@mp/api` (`ROUTES`), plus:

- `POST /api/mcp/tokens` `{ contactId?, name? }` → `{ id, token, contactId }` (201). The token is returned once.
- `POST /api/employees/:id/ssh-key` → `{ employeeId, publicKey }`: rotates the employee's SSH keypair.

Errors are `{ error: { code, message, details? } }`: not found 404, validation
422 (issues in `details.issues`), malformed request 400, conflict 409 (the
current record in `details.current` for stale updates), denied 403, limit 429,
unavailable 503, anything else 500 with a generic message and no stack trace.

Writes are made by the current person: the contact in the `x-mp-contact`
header, or the deployment's default "Web user" contact (there is no sign-in yet).
Routing results are stored on each event (`data.routing`), which is what event
details, trigger statistics and lineage read. Secrets are write-only: the API
only ever returns names and scopes. `secret` and `mcp_token` records are hidden
from the generic records API.

## Live updates (`/ws`)

The `@mp/api` live protocol: `subscribe` / `unsubscribe` / `ping`, answered by
`subscribed`, `pong` and `event` messages. Bus topics (`record.changed`,
`link.changed`, `entry.appended`, `run.state`, `session.head`, `model.delta`,
`tool.called`, `tool.result`, `usage.recorded`, `checklist.changed`,
`chat.message`, `event.ingested`, `event.routed`, `control.changed`) are mapped
to the API payloads and fanned out with `channelsFor`. Messages are forwarded in
order; a socket that stops draining (buffer over 1 MiB and 500 queued messages)
is closed with 1013.

## MCP server (`/mcp`)

Streamable HTTP, one MCP session per client, authenticated with a per-contact
bearer token. Everything a client does is authored by that contact.

Tools: `chat_post` (channel, text, thread_id?), `chat_read` (channel or
thread_id), `ask` (employee, question: posted in the contact's DM thread with
the employee, tagging it; returns the thread id), `session_get`,
`sessions_search`, `docs_search`, `docs_read`, `my_work`.

Notifications out, as `notifications/message` with `data`:
`{ type: 'chat.reply' | 'chat.mention', threadId, channelId, messageId, author, text }`
for replies in threads the contact is in and mentions of it,
`{ type: 'work.finished', runId, sessionId, state, text }` when work it asked for
finishes, and `{ type: 'approval.needed', runId, sessionId, text }` when that work pauses.

Connect Claude Code:

```sh
npm run token -- --contact <contactId>        # prints the token once
claude mcp add --transport http meatless http://localhost:3000/mcp --header "Authorization: Bearer <token>"
```

## Composition

`createApp(config, overrides?)` (`src/app.ts`) returns `{ app, services, live, mcp, start(), stop() }`.

- Adapters: `store-postgres` (migrations at startup) or the memory store;
  `queue-bullmq` or the memory queue; `model-openai` or `overrides.model`;
  `secrets-store` over the store, keyed by `SECRETS_KEY`; one `git-cli` store per
  employee (`src/git-store.ts`, chosen by the run's employee); `containers-docker`
  when `DOCKER_ENABLED`; the `mcp-sdk` hub from `MCP_SERVERS`, resolving secrets
  from the secret store. Tests replace any of them with `overrides`.
- Services: records, docs, directory, memory, skills, files, events, sessions,
  checklists, chat, the tool registry (stdlib and MCP tools), usage, router
  (default router, procedure contexts, chat channel members as recipients),
  runner (tool lists from `employee.toolAllow`/`toolDeny`, project from the
  first linked project), and the stdlib policies, usage policies and router
  policies on the hooks. The global pause (`/api/control/*`) is a setting that a
  first `beforeModelCall` handler honours.
- Queues: `events` (routing, one at a time) and `runs`. Ingesting an event
  enqueues it; at startup every unrouted event, queued or running run, and
  suspended run with a satisfied wait or a timer is enqueued again, so the
  queues can always be rebuilt from the database.
- Every employee gets an ed25519 SSH keypair when it is created (bootstrap
  included): the private key is the employee-scoped secret `SSH_PRIVATE_KEY`,
  the public key is the `sshPublicKey` field of the employee. The stdlib gets
  it through `sshKeyFor`.
- Shutdown (SIGTERM, SIGINT): stop the WebSocket and MCP sessions, stop taking
  jobs, wait up to 30 s for running jobs, close the queue, MCP and the store.
  A run interrupted at shutdown resumes from its journal at the next start.

## Schedules

`src/scheduler.ts` runs a repeatable job (queue `schedules`, job id
`schedule-tick`, every 30 s). Each tick calls `events.triggers.dueSchedules`,
ingests a `schedule.fired` event per due firing (source `schedule`, the
trigger's employee, subject `{ system: 'mp', id: <triggerId> }`, text
`Scheduled: <name> (<cron>)`, dedupe key `schedule:<triggerId>:<ISO time>`),
and marks the slot with `markScheduled`. The router delivers it to the
trigger's context, or a fork of it. Racing ticks, restarts and several
instances fire a slot once. A firing whose trigger was disabled or removed
before routing is dropped rather than sent to the fallback router. Schedule
triggers are created in the API or by employees with `triggers.create`
(`schedule: { cron, timezone?, graceSeconds? }`).

## Alerts

`src/alerts.ts` posts in `#alerts`, which the bootstrap employee creates the
first time it's needed. Each alert tags the run's requester (their `mp`
handle, or their name) and the session's employee:

- **Failed run:** bus topic `run.state` with `to: 'failed'`.
- **Paused too long:** a repeatable job (queue `alerts`, every 60 s) looks
  for runs paused longer than `ALERT_PAUSED_MINUTES`. A paused run doesn't
  change, so its `updatedAt` is when it was paused.
- **A dependency keeps failing:** `ALERT_UNAVAILABLE_COUNT` `unavailable`
  errors from the same dependency within `ALERT_UNAVAILABLE_MINUTES`. The
  source is the run worker: when a run job attempt ends with an `unavailable`
  error (the job is then retried), it's reported. The dependency is
  `MCP server <name>` when the error names a server (`details.server`), else
  `model provider`. Counts are per process.

Each alert is claimed with an `alert` record whose key is the condition and
the run (or the dependency and the time window), so there is one alert per
run per condition, across restarts and instances. Alert messages don't
start runs: tagging the employee is a notification, otherwise a failing
provider would keep alerting about its own alerts. Replies in an alert's
thread are routed as usual.

## Memory at session start

`src/session-memory.ts` handles the router's `afterFork` hook. When a context
is forked for a delivery (e.g. each request in `#requests`), it recalls up to
5 memories with `memory.recall`. It uses the event's text (a chat message's
full text), the fork's employee, the projects linked to the context and the
fork, and the event's actor. The memories go into the fork's first run as
one `system` entry, after the fork point and before the event: "Things you
remember that may be relevant:" followed by one line per memory (summary,
kind, id, content snippet). The fork keeps the context's cached prefix.

## Bootstrap

When `MP_BOOTSTRAP` is on and the store has no employee, `src/bootstrap.ts`
creates the employee "Meatless" (AI contact, a personality, `toolAllow: ['**']`,
`env.*` denied without Docker), its router session (system prompt from the
stdlib's `employeePrompt`), the channels #general and #requests, a trigger
routing new top-level messages in #requests to the router, the default router
setting and the default web contact. Every step is idempotent (`npm run seed`).

## Operations

- Migrations: applied at startup; `npm run migrate` applies them alone.
- Tokens: `npm run token -- --contact <contactId> [--name laptop]`, or `POST /api/mcp/tokens`.
- Health: `GET /healthz` (process up), `GET /readyz` (database, queue and migrations; 503 otherwise).
- Deployment: `docker compose up` with the root `Dockerfile` and `compose.yaml`
  (Postgres 18, Redis 8 with AOF, the Docker socket and a `data` volume). Set
  `SECRETS_KEY` and the model provider in `.env`, and `DOCKER_GID` to the group of
  `/var/run/docker.sock` so the non-root app user can use it.

## Tests

`npx vitest run --project node packages/server`:

- `api.test.ts`: every `@mp/api` route exists, shapes, error mapping, secrets never returned, pause-all.
- `live.test.ts`: the real server on port 0 and a WebSocket client (run.state, entry.appended, model.delta), slow clients.
- `mcp-server.test.ts`: the MCP SDK client over streamable HTTP with a token; tools and notifications.
- `scenarios.test.ts`: end-to-end scenarios with a scripted model (routing to a worker and back through a
  subscription; an MCP notification through a trigger to a procedure fork; a loop with a wait; the checklist
  gate; crash recovery; a budget pause). They run on the in-memory adapters, and again on Postgres and BullMQ
  (unique schema and Redis prefix) when `DATABASE_URL` and `REDIS_URL` are set.
- `scheduler.test.ts`: schedule triggers fire once per slot with racing ticks (and with two app instances on Postgres
  and BullMQ when configured), the fork's run reaches its context, grace, disabled triggers, the repeatable job.
- `alerts.test.ts`: failed runs (once, tags, no run started), `ALERTS_ENABLED`, paused runs, dependencies that keep
  failing, and the run worker reporting a provider outage.
- `session-memory.test.ts`: recalled memories in a request fork, before the event; visibility; the limit of 5.
- `units.test.ts`: configuration, `.env`, notification mapping, SSH key format, per-employee git stores,
  bootstrap idempotence, queue recovery.

## Replacing it

Another composition root can wire the same packages differently: build the
services with `buildServices`, or write a new `createApp`. Nothing else depends
on this package.
