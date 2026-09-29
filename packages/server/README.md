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
| `PUBLIC_URL` | none | The URL people open, e.g. `https://mp.example.com`: sign-in links, the CSRF origin check, `Secure` cookies, the CSP's `connect-src`, and the address GitLab webhooks are registered at (without it [webhook provisioning](#gitlab-webhooks) is off) |
| `COOKIE_SECURE` | `auto` | `Secure` on the session cookie: `auto` (when `PUBLIC_URL` or the request is https), `true` or `false` |
| `TRUST_PROXY` | `false` | Trust `x-forwarded-for` (rate limits) and `x-forwarded-proto` (cookies) from a reverse proxy |
| `ADMIN_EMAIL` | none | Email of the admin contact the first start creates (or the existing contact made admin) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URL` | none | Optional sign-in with an identity provider: all four or none. The redirect URL is `<PUBLIC_URL>/auth/oidc/callback` |
| `METRICS_TOKEN` | none | A bearer token (16+ characters) that may read `/metrics`, besides admins |
| `PREVIEW_DOMAIN` | none | Live previews' domain: each preview is `<env>-<port>.<PREVIEW_DOMAIN>` (needs `PUBLIC_URL`, wildcard DNS and a wildcard certificate), and the UI may frame `https://*.<PREVIEW_DOMAIN>` and nothing else. See [Live previews](#live-previews) |
| `PREVIEW_PORT` | `3001` | The preview listener. Without `PREVIEW_DOMAIN` it is the previews' origin (the harness's host on this port); with it, the reverse proxy sends `*.<PREVIEW_DOMAIN>` here. `0` turns previews off |
| `SELF_CONTAINER` | the host name in Docker | The container the harness runs in, so it can join environments' preview networks |
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

### MCP servers added at runtime (`src/mcp-servers`)

`mcp_server` records (http only), global or for one employee, managed by
`McpServers` (`services.mcpServers`) over the same `ManagedMcpHub` as
`MCP_SERVERS` (the hub knows them by record id):

- A record change (`record.changed`, or the API directly) adds, reconnects or
  removes the server, one change at a time per server; a failed connect is
  tried again every minute. `start()` loads them all (in the background at
  startup).
- Tools are `mcp.<name>.<tool>`. `hiddenFor(employeeId)` is added to the
  employee's deny list by `toolListsFor`, so other employees' servers' tools
  are neither listed nor callable; the handler also throws `DeniedError`.
  Newly registered tools are added to the router contexts of the employees
  that may use them.
- Token auth: the token is the secret `MCP_<NAME>_TOKEN` (or a named one),
  scoped to the employee or global, sent as `<header>: <prefix><token>`.
  OAuth: `StoredOAuthProvider` (`@mp/mcp-sdk`) over the secret store
  (`MCP_<NAME>_OAUTH_CLIENT|TOKENS|VERIFIER|DISCOVERY`, same scope); states
  are `mcp_oauth_state` records keyed by the state's sha256 (10 minutes,
  single-use, bound to the server and the admin). The redirect URI is
  `PUBLIC_URL` (else the request's origin) + `/oauth/mcp/callback`.
- Status changes are published on the bus as `mcp.server.status`; `needs_auth`
  also posts an alert in `#alerts` (`wireMcpAlerts`, started with the workers).

## HTTP API

Exactly the routes of `@mp/api` (`ROUTES`), plus:

- `POST /api/mcp/tokens`: the same as `POST /api/auth/tokens` (kept for MCP clients).
- `POST /api/employees/:id/ssh-key` → `{ employeeId, publicKey }`: rotates the employee's SSH keypair (admins).
- The employee page's routes (`@mp/api` `SETUP_ROUTES`, served by `src/setup`, see [Employees and guided
  setup](#employees-and-guided-setup)): `POST /api/employees`, `GET /api/employees/:id/ssh-key`,
  `GET /api/employees/:id/integrations`, `POST /api/employees/:id/integrations/:name/secrets` and `/actions/:action`,
  `GET /api/employees/:id/integrations/slack/manifest`.
- `GET /oauth/mcp/callback`: the end of an MCP server's OAuth sign-in (`src/http/mcp-servers.ts`); it checks the
  signed-in admin against the state itself and redirects back to the UI with `mcp_oauth=connected|error`.
- `GET /metrics`: Prometheus metrics (see [Metrics](#metrics)).
- `GET /api/integrations/status` → per employee, which integrations are set up (token and webhook secret, from secret
  metadata only) and its GitLab webhooks with their status and error, plus whether provisioning is on (admins; see
  [GitLab webhooks](#gitlab-webhooks)).
- `GET /auth/login`, `GET /auth/oidc/start`, `GET /auth/oidc/callback`: sign-in (see [Sign-in](#sign-in-and-access)).
- `GET /api/sessions/:id/preview` and `POST /api/previews/token` are `@mp/api` routes, served by `src/previews` (see [Live previews](#live-previews)).

Errors are `{ error: { code, message, details? } }`: not found 404, validation
422 (issues in `details.issues`), malformed request 400, conflict 409 (the
current record in `details.current` for stale updates), denied 403, limit 429,
unavailable 503, anything else 500 with a generic message and no stack trace.

Every request to `/api` and `/ws` is made by a signed-in person, and every write
is authored by them. Nothing else says who you are: there is no `x-mp-contact`
header and no default user any more. Routing results are stored on each event
(`data.routing`), which is what event details, trigger statistics and lineage
read. Secrets are write-only: the API only ever returns names and scopes.
`secret`, `mcp_token`, `login_link`, `auth_session`, `mcp_server` and
`mcp_oauth_state` records are hidden from the generic records API (MCP servers
have their own admin routes, `/api/mcp-servers`).

## Sign-in and access

All of it is in `src/auth/`: `guard.ts` (who is calling, CSRF, the route
table), `sessions.ts` (links and sessions), `routes.ts`, `oidc.ts`,
`visibility.ts` (DMs), `headers.ts` (CSP), `rate-limit.ts`,
`bootstrap-admin.ts`.

- **Sign-in links.** `npm run login-link -- --contact <id|email>` prints one,
  admins make them in Settings → People and access (`POST /api/auth/links
  { contactId | email }`), and the first start logs one (see
  [Bootstrap](#bootstrap)). A link is a random token, stored as its sha256,
  that works once within 15 minutes. `GET /auth/login?token=&next=` exchanges it
  for a session and redirects to `next` (a local path); a bad link redirects to
  `/login?error=invalid_link`.
- **Sessions.** The cookie `mp_session` holds a random id, stored as its sha256
  (`auth_session` records): httpOnly, SameSite=Lax, Path=/, `Secure` over https
  (`COOKIE_SECURE`), 14 days after the last use (the expiry slides, written at
  most once a minute). An id older than 4 hours is replaced on its next use (the
  old one works for one more minute, for requests in flight). `POST
  /api/auth/logout` ends it.
- **OIDC** (optional, `OIDC_*`): authorization code flow with PKCE (S256) and
  discovery, the client secret as HTTP Basic, the id_token verified against the
  provider's JWKS (RS256 or ES256; issuer, audience, expiry, nonce), state kept in
  an HMAC-signed cookie for 10 minutes. The person is matched to a contact by
  email (case-insensitive; an unverified email is refused). Unknown emails are
  refused, nobody is created. No dependency: `fetch` and `node:crypto`.
- **API tokens** are the MCP tokens (`mcp_token` records, stored hashed): one
  token works as `Authorization: Bearer` on `/api`, `/ws` and `/mcp`. `GET|POST
  /api/auth/tokens`, `DELETE /api/auth/tokens/:id` (revoke). Your own tokens, or
  anyone's for admins. `npm run token -- --contact <id>` still works.
- **Access** is the contact's `access` field (an extension field defined here:
  the contact's `role` is a job title): `viewer` (reads everything except
  secrets), `member` (chat, messages to sessions, forks, pausing and resuming
  their own runs, knowledge edits: contacts, projects, procedures, memories,
  skills, docs, templates, a session's document and title, files) and `admin`
  (secrets, employees, limits, triggers, settings, the kill switch, others'
  tokens, sign-in links, import and export, anyone's access). A person without
  it is a viewer. AI employees and people with `status: left` never sign in.
- **One place enforces it**: `GUARD_RULES` in `guard.ts`, first match wins.
  Unlisted routes need `viewer` for GET and `admin` for anything else. Webhooks
  (`/webhooks/*`, their signature is the auth), `/mcp` (its own bearer check),
  `/metrics`, `/healthz`, `/readyz`, `/auth/*`, `GET /api/auth/config` and the web
  UI are public. Two checks need the body and live in the handlers: only admins
  set `access`, and members edit only a session's document and title.
- **DMs** are visible to their members only, admins included: the channel
  list, messages, threads, reactions, search, unread counts, the inbox, events,
  session threads and the records API (`channel`, `message`, `event`) leave them
  out or answer 404, and `/ws` refuses `chat:<dm>` subscriptions and drops a DM's
  live events for everyone else.
- **CSRF**: a cookie-authenticated POST, PUT, PATCH or DELETE needs an `Origin`
  matching `PUBLIC_URL` (else the request's host), or `x-mp-csrf` repeating the
  `mp_csrf` cookie (the web UI sends it). A cookie-authenticated WebSocket must
  come from the same origin. Bearer tokens need neither.
- **Brute force**: 20 failed sign-ins (bad links, failed OIDC callbacks) per
  address per minute, and 30 failed tokens or cookies, then 429 / a
  `too_many_attempts` error for the rest of the minute. In memory, per process.
- **Headers**: `X-Content-Type-Options: nosniff` and `Referrer-Policy:
  same-origin` on everything; on HTML also `X-Frame-Options: DENY` and a CSP:
  `default-src 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'`,
  `font-src 'self' data:` (the fonts are bundled), `frame-ancestors 'none'`, and
  `frame-src`: the preview origins only (`https://*.<PREVIEW_DOMAIN>`, or the
  harness's host on `PREVIEW_PORT`), `'none'` with previews off.
- **Preview origins** are refused first of all: any request whose `Host` or
  `Origin` is a preview origin gets 403, on every path (`/api`, `/ws`, `/mcp`,
  `/auth`, the UI), whatever credentials it carries.

Tests sign in with `test/auth-helpers.ts`: `t.req` is the bootstrap admin by
default, `await t.as(contactId)` returns headers for someone else (a bearer
token; `member` unless they have an access), `signIn(app, id, { via: 'cookie' })`
goes through a real link and returns the cookie and CSRF headers. As a shortcut,
`t.req(…, { 'x-mp-contact': id })` means `t.as(id)`: the helper translates it,
the server ignores the header.

## Live previews

`src/previews` (docs/spec.md "Live previews"). An environment started with
`env.up { expose: [5173] }` can be watched live in the UI. The preview is
**never** served on the harness's origin, because it runs code the employee
just wrote or installed.

- **Where**: with `PREVIEW_DOMAIN`, each preview has its own origin,
  `<env id>-<port>.<PREVIEW_DOMAIN>` (e.g. `mp-billing-bot-fix-5173.preview.example.com`).
  Point a wildcard DNS record at the host, get a wildcard certificate, and have
  the reverse proxy send `*.<PREVIEW_DOMAIN>` to `PREVIEW_PORT`. `PUBLIC_URL` is
  required then (it's the only origin allowed to frame previews). Without a
  domain, previews are served on `PREVIEW_PORT` of the harness's host (e.g.
  `http://localhost:3001`): one origin for every preview, so a browser follows
  one preview at a time there (the last one opened), and cookies of different
  previews share that host. Use a domain in production. Publish the port
  (`3001:3001` in compose).
- **Tokens**: `POST /api/previews/token { envId, port }` (members; the
  environment must belong to a session that still exposes that port) returns
  `{ token, url, origin, expiresAt }`. The token lives 5 minutes, works once,
  and is an HMAC under a key derived from `SECRETS_KEY`, scoped to the
  environment, the port and the viewer. `url` is
  `<preview origin>/__mp_preview/auth?token=…`: the UI puts it in the frame or
  opens it full screen. `env.preview` only links the session's Preview tab
  (`/sessions/<id>?tab=preview&port=5173`); tokens are minted for whoever opens it.
- **The preview listener** exchanges a token for the `mp_preview` cookie
  (httpOnly, host-only, `Path=/`, 12 hours sliding; `SameSite=None; Secure` over
  https, `SameSite=Lax` over plain http, where browsers refuse `None`), then
  redirects to `/`. Everything else is proxied to the environment
  (`ContainerRuntime.previewTarget`): HTTP streamed both ways, and WebSocket
  upgrades (hot reload) from the preview's own origin only. `Host` becomes
  `localhost:<port>`, and a same-origin `Origin`/`Referer` is rewritten to match;
  redirects to the inner address become paths.
- **Stripped**: every `mp_*` cookie (the harness's session and CSRF cookies,
  and the preview cookie itself), `Authorization` and `x-mp-csrf` never reach the
  app. A `Set-Cookie` from the app with a `Domain` (it would reach other hosts)
  or an `mp_*` name is dropped, on normal responses and on the WebSocket `101`.
- **Framing**: every preview response gets `Content-Security-Policy:
  frame-ancestors <harness origin>` (as an extra policy, so the app's own CSP
  still applies). The UI frames previews with
  `sandbox="allow-scripts allow-forms allow-same-origin"`, and the harness itself
  can't be framed (`frame-ancestors 'none'`).
- **Access** is checked again while a cookie is in use (every 30 s): a viewer
  who lost member access loses the preview. A preview ends with its environment:
  a token or cookie for a destroyed one gets a 404 page.
- **Reloads**: when a session's checkout moves to another commit (`git.commit`,
  `git.checkout`, or the commit on stop when a run ends), the server publishes
  `preview.commit` on the session's live channel; `GET /api/sessions/:id/preview`
  has the ports, the environment's status and the running commit.
- **Docker**: see `@mp/containers-docker`: a forwarder sidecar per environment
  is the only thing on both the environment's network and its preview network,
  and it forwards only to the main container's exposed ports. The harness
  container joins the preview network (`SELF_CONTAINER`), never the
  environment's network, so project containers can't reach the harness.
  Running the harness on the host instead (development): bind it to
  `HOST=127.0.0.1`, because a process listening on all interfaces is reachable
  from containers at their bridge's gateway address.

## Metrics

`GET /metrics`, Prometheus text format (written by hand, no dependency), for
signed-in admins or `Authorization: Bearer <METRICS_TOKEN>`:

| Metric | Type | Labels |
|--------|------|--------|
| `mp_runs` | gauge (counted on scrape) | `state` |
| `mp_queue_jobs` | gauge | `queue`, `state` (waiting, delayed, active) |
| `mp_model_calls_total` | counter | `model` |
| `mp_model_tokens_total` | counter | `model`, `type` (prompt, completion, cached) |
| `mp_model_call_duration_seconds` | histogram | `model` |
| `mp_tool_calls_total`, `mp_tool_errors_total` | counter | `tool` |
| `mp_events_total` | counter (new events, not duplicates) | `source` |
| `mp_environments_running` | gauge | |
| `mp_http_requests_total` | counter | `method`, `route` (the route pattern), `status` |

Counters live in memory from the bus and the runner's hooks, so they restart at
zero with the process, as Prometheus expects.

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

`createApp(config, overrides?)` (`src/app.ts`) returns `{ app, services, live, mcp, previews, hookProvisioning, start(), stop() }`.

- Adapters: `store-postgres` (migrations at startup) or the memory store;
  `queue-bullmq` or the memory queue; `model-openai` or `overrides.model`;
  `secrets-store` over the store, keyed by `SECRETS_KEY`; one `git-cli` store per
  employee (`src/git-store.ts`, chosen by the run's employee); `containers-docker`
  when `DOCKER_ENABLED`; the `mcp-sdk` hub from `MCP_SERVERS` plus the runtime
  servers (`src/mcp-servers`), resolving secrets from the secret store. Tests replace any of them with `overrides`.
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

## Employees and guided setup

`src/provision.ts` gives an employee everything it needs to take work: `provisionEmployee(s, employeeId, actor,
{ requestsChannel?, channels? })` makes sure of its SSH keypair, its router session (the router instructions and the
routing toolset), membership of #general, its requests channel (`#requests-<handle>`; the default employee's is
`#requests`) and the trigger routing new messages there to the router. It's idempotent and serialized per employee,
so concurrent calls give one router session. `createEmployee(s, input, actor)` creates the employee (a taken handle
is a `ConflictError`; two creates with the same handle at once give one) and provisions it: that's
`POST /api/employees` (admins). `bootstrap()` provisions the default employee the same way.

`src/setup` is the employee page's guided integration setup (docs/spec.md#guided-setup):

- `setup/slack.ts`, `setup/gitlab.ts`, `setup/linear.ts`: one `IntegrationSetupModule` each: its secret fields, a
  `check(ctx)` returning the steps, `validate(ctx, values)` before secrets are stored (a rejected token or a missing
  scope is a 422 and nothing is stored), and actions (`add-trigger`, `add-ssh-key`, `register-webhooks`,
  `create-webhook`). Every external call goes through the injected `fetch` (the integrations' `fetch` and base URL
  overrides apply), with a 10 s timeout; secret values are masked in every message, never returned and never logged.
- `setup/index.ts`: `createSetup(s, { integrations, provisioning })` runs the checks, cached per employee for 30 s
  (`?refresh=1` runs them again; a changed secret or trigger drops the cache), and `setupRoutes(s, setup)` serves the
  routes. Reads are for everyone signed in, writes for admins (`GUARD_RULES`).
- `setup/activity.ts`: a middleware in front of `/webhooks/*` that records every webhook the integration accepted
  (2xx, so only valid signatures), per employee (or `deployment`) and integration, and per project for GitLab. It's
  kept in memory and written to the setting `webhook.activity:<owner>:<integration>` at most every 30 s.

## GitLab webhooks

`src/integrations/provisioning.ts` registers GitLab project webhooks by itself (docs/spec.md#integrations, "Webhooks
set themselves up"). Nobody adds them by hand.

- **Who:** every employee whose `GITLAB_TOKEN` resolves (its own, or the global one).
- **Which repositories:** the repositories of every project the employee's AI contact is linked to (any role), and of
  every project one of its sessions is linked to with `works_on`. When it is the deployment's only employee, every
  project. A repository counts when its `url` is on the employee's GitLab (`GITLAB_BASE_URL`, or gitlab.com): https,
  `git@host:group/repo.git` and `ssh://` URLs all work, and GitHub or other hosts are skipped.
- **The hook:** `<PUBLIC_URL>/webhooks/gitlab/<employee id>`, with push (no branch filter), comments, issues, merge
  requests, jobs and pipelines, and SSL verification on unless `PUBLIC_URL` is `http:`. Its secret is the employee's
  own `GITLAB_WEBHOOK_SECRET`, generated (32 random bytes) and stored when missing. The per-employee webhook route
  verifies it.
- **The token:** the global secret `GITLAB_HOOKS_TOKEN` (a Maintainer or group Owner) when it's set, else the
  employee's `GITLAB_TOKEN`, which then needs Maintainer. That's why the recommended setup is a provisioning token: the
  service accounts stay Developer.
- **Repair, never duplicate:** the hook is found by its URL. Wrong events, SSL verification or a branch filter are
  fixed, extra hooks with the same URL are removed, and a deleted hook is created again. GitLab never returns a
  hook's token, so the `gitlab_hook` record keeps a short hash of the secret last set (`tokenVersion`) and the hook id:
  when the secret changes, or the hook isn't the one we set it on, the token is set again. Repositories that drop out
  of the set lose their hook. A changed `PUBLIC_URL` moves the hook.
- **When:** at start (after bootstrap, with the workers); when a GitLab secret changes (`GITLAB_TOKEN`,
  `GITLAB_HOOKS_TOKEN`, `GITLAB_WEBHOOK_SECRET`, `GITLAB_BASE_URL`); when a project's repositories change; when the
  employee is linked to or unlinked from a project, or a session of it gets a `works_on` link; when employees are added
  or removed; and every 6 hours to repair drift. Changes are debounced (2 s) and passes are serialized per employee.
  Several instances may each run a pass; the next pass removes any duplicate a race left.
- **Status:** one `gitlab_hook` record per employee and GitLab project (key `<employee id>:<project path>`): `status`
  (`ok` or `error`), `error`, `lastAction`, `lastAttemptAt`, `lastOkAt`, `hookId`, `url`. A 403 says what to do: "the
  token needs Maintainer on <project> to register webhooks; set GITLAB_HOOKS_TOKEN (a Maintainer or group Owner) or give
  the service account Maintainer". It's in `GET /api/integrations/status` and in the web UI under *Settings →
  Integrations*.
- **Off** without `PUBLIC_URL` (logged once at start), or when GitLab isn't in `INTEGRATIONS`.

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
`env.*` denied without Docker) and provisions it with `provisionEmployee`: its
router session (system prompt from the stdlib's `employeePrompt`), the channels
#general and #requests, a trigger routing new top-level messages in #requests to
the router. Then it sets the default router setting. Every step is idempotent
(`npm run seed`).

With `MP_BOOTSTRAP` on, every start also makes sure there is an admin
(`src/auth/bootstrap-admin.ts`): if no person has `access: admin`, the contact
with `ADMIN_EMAIL` becomes one, or an "Admin" contact is created (with that
email, and the chat handle `@admin`). While no admin has ever signed in, the
start logs a one-time sign-in link for them (`bootstrap: sign in as the admin
…`, 15 minutes). Later links come from `npm run login-link`.

## Operations

- Migrations: applied at startup; `npm run migrate` applies them alone.
- Sign-in links: `npm run login-link -- --contact <contactId|email>`.
- Tokens: `npm run token -- --contact <contactId> [--name laptop]`, or Settings → API tokens.
- Metrics: `GET /metrics` with `METRICS_TOKEN`.
- Health: `GET /healthz` (process up), `GET /readyz` (database, queue and migrations; 503 otherwise).
- Deployment: `docker compose up` with the root `Dockerfile` and `compose.yaml`
  (Postgres 18, Redis 8 with AOF, the Docker socket and a `data` volume). Set
  `SECRETS_KEY` and the model provider in `.env`, and `DOCKER_GID` to the group of
  `/var/run/docker.sock` so the non-root app user can use it.

### Import and export

The knowledge base can be exported as a folder of markdown with YAML
frontmatter, for backups or to keep in git, and imported back; contacts and
projects can also come from CSV (`src/transfer/`, docs/spec.md#import-and-export).

```sh
npm run export -- --out ./knowledge [--force]
npm run import -- --dir ./knowledge --dry-run
npm run import -- --contacts people.csv --projects projects.csv [--dry-run] [--strict] [--verbose]
```

The folder:

| Path | Record | Body |
|------|--------|------|
| `contacts/<slug>.md` | contact (people and AI employees' contacts) | `bio` |
| `employees/<slug>.md` | employee, without `routerSessionId`, SSH key fields or anything credential-like | `instructions` |
| `projects/<slug>.md` | project, with `members: [{contact, role, data?}]` (the owner is the `owner` role) | `description` |
| `projects/<slug>/docs/<path>.md` | the project's docs (`path`, or the slugified title) | `body` |
| `procedures/<slug>.md` | procedure, without `contextSessionId` (rebuilt on first use) | `body` |
| `skills/<company or project slug>/<name>.md` | skill | `body` |
| `memories/<id>.md` | memory | `content` |
| `index.json` | `{ format, version, records: [{kind, id, path}], links }`: every record with its file, and the links no file shows (memory `about` links and others) | |

Frontmatter is one `key: value` per field, `id` first then sorted; lists,
objects and strings that need quoting are JSON (which is YAML). Output is
deterministic: same data, same bytes, and no timestamps other than record
fields. Ids are kept, so `[[kind:id]]` links in text still resolve. Writing
into a folder replaces only the entries above, and refuses a non-empty folder
that isn't a previous export unless `--force`.

Import:

- **Matching**: by id (folder only), then by email, then by handle, then by an
  exact unique name for contacts; by name or alias for projects, by key for
  employees and skills, by owner and path for docs, by summary and scope for
  memories. A record that matches is updated with the fields the source has
  (other fields are kept); CSV handles replace the handle of the same system.
  New records keep the source's id when it's free, otherwise get a new one, and
  every reference and `[[kind:id]]` link in the import is rewritten to match.
- **CSV** with a header row, any case or spacing, `,`, `;` or tab separated,
  quoted fields, BOM and CRLF are fine. Contacts: `name, email, role, team,
  manager email, slack handle, permissions`. Projects: `name, description,
  owner email, members` (`email:role;email:role`, role defaults to `member`).
  Managers, owners and members may be contacts from the same import.
- **Memberships** are added, never removed; an `owner` replaces the project's
  previous owner.
- **Dry run**: `--dry-run` prints the plan (create, update or unchanged per
  record, with a `+ field` / `~ field: old -> new` summary, counts per kind,
  warnings and errors) and changes nothing.
- **Errors** are reported per row or file (`contacts.csv:5: name is required`),
  and those rows are skipped; the rest is imported. `--strict` refuses to apply
  a plan with errors and stops at the first failure.
- **Idempotent**: importing the same source again plans every record as
  unchanged and writes nothing.

The same functions are exported for the HTTP API: `exportTree(services)` →
`Map<path, content>`, `exportKnowledge(services, dir)`, `readTree(dir)`,
`planImport(services, { tree?, contactsCsv?, projectsCsv? })` → `ImportPlan`,
`applyImport(services, plan, { strict?, actor? })`, and `formatPlan(plan)`.

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
- `transfer.test.ts`: export and import: round trip into a fresh app gives the identical tree (memory, and
  Postgres when `DATABASE_URL` is set), idempotence, dry run changes nothing, doc links onto existing records with
  other ids, messy CSV rows, matching by email, handle and name, owner replacement, strict mode.
- `gitlab-hooks.test.ts`: webhook provisioning against a fake GitLab: create, idempotence, repair (events, a deleted
  hook, a duplicate, a changed secret), the provisioning token preferred, a 403 recorded with its message, off without
  `PUBLIC_URL`, repository and link changes, the only employee, a webhook signed with the generated secret accepted
  end to end, and the admin-only status.
- `setup.test.ts`: creating employees (everything the first one gets, a taken handle, a double click, concurrent
  provisioning), the SSH key endpoint, and the guided setup against fake Slack, GitLab and Linear APIs: bad tokens and
  missing scopes refused and not stored, values never returned or logged, signed webhooks recorded (unsigned ones
  not), idempotent triggers and SSH keys, a key already on another account, a rotated key replaced, Maintainer and
  unprotected branch warnings, an expiring token, the Linear webhook, members read-only, the 30 s cache. On memory,
  and on Postgres and BullMQ when configured.
- `units.test.ts`: configuration, `.env`, notification mapping, SSH key format, per-employee git stores,
  bootstrap idempotence, queue recovery.
- `auth.test.ts`: nothing without sign-in (`x-mp-contact` ignored), the guard table covers every route, sign-in
  links (once, 15 minutes, local `next` only), cookie flags, sliding expiry and rotation with a grace minute,
  sign-out, AI employees and leavers refused, CSRF (origin, double submit, `PUBLIC_URL`, bearer exempt), tokens
  (shown once, list, revoke, others' for admins, the same token on `/mcp`), brute-force limits, what viewers,
  members and admins may do, the admin bootstrap and its link, security headers.
- `visibility.test.ts`: DMs hidden from others and admins over HTTP (lists, reads, search, unread, records,
  events) and over the WebSocket (subscriptions, live events); a cross-site cookie socket refused.
- `oidc.test.ts`: a fake identity provider (discovery, JWKS, PKCE-checking token endpoint): RS256 and ES256,
  unknown emails, bad signatures, audiences, nonces, issuers, expiry, unverified emails, forged state cookies.
- `metrics.test.ts`: access, and every metric through a strict parser of the text format.
- `login-link-cli.test.ts`: the CLI prints a link that works once (Postgres, when `DATABASE_URL` is set).
- `previews-units.test.ts`: preview tokens (signing, 5-minute expiry, single use, scope and tampering, keys, token vs
  cookie), cookies (12 hours, refresh), preview hosts and origins in both modes, `frame-src` and `frame-ancestors`,
  cookie stripping both ways.
- `previews.test.ts`: end to end with the fake runtime pointed at a real local HTTP and WebSocket upstream on port 0:
  `env.up` with `expose`, a token, the exchange, proxied requests (cookies, `Authorization`, `Host`, redirects,
  streaming, bodies, the app's CSP), WebSocket upgrades and their origin check, lost access, 502s, the harness
  refusing preview hosts and origins with a valid cookie, domain mode, `preview.commit`, and an ended environment.
- `previews-docker.test.ts` (`MP_DOCKER_TEST=1`): a real environment running `python3 -m http.server`, previewed
  through the real listener; the project container can't reach the harness's API or preview ports.

## Replacing it

Another composition root can wire the same packages differently: build the
services with `buildServices`, or write a new `createApp`. Nothing else depends
on this package.
