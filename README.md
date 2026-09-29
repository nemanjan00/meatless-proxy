# meatless-proxy

**A meat proxy, without the meat.**

A *meat proxy* is a person who just relays messages between their colleagues
and an AI: they paste a question into a chatbot, and paste the answer back.
meatless-proxy removes the person in the middle. It's an AI harness that runs
**AI employees**: colleagues that know who everyone in the company is, which
projects exist and who owns them, and how things are done. They take work from
chat and task systems, do it, and answer like a person would: briefly, and
correctly.

> **Status: early and experimental.** Everything in `docs/` is implemented at
> least once, and the whole thing runs end to end against a real model, but
> expect breaking changes. Components are built to be thrown away and
> rewritten.

## What makes it different

- **No single operator.** Most harnesses have one person at a terminal. This
  one talks to the whole company. Work starts from chat messages, task
  assignments and schedules, and routes itself to the right context.
- **Database first.** Everything is state in Postgres: people, projects,
  procedures, memory, and every session's full history. Sessions survive
  restarts and can be picked up by any worker.
- **Sessions as a tree.** Sessions can be forked at any point, fanned out over
  a list, rewound with a summary instead of compacted, and committed or thrown
  away. No context is ever lost.
- **Triggers and subscriptions.** A new task goes to the context assigned to
  that kind of work. A session working on an existing task subscribes to it,
  so replies reach it directly, with nobody routing them.
- **Procedures as contexts.** Each company procedure has a context that
  already knows it. Work that needs the procedure runs in a fork of that
  context, with nothing to re-read.
- **Safe by construction.** AI employees open pull requests and never merge or
  deploy. Secrets are injected at call time and never shown to the model.
  Checklists need evidence before anything counts as done.

## Documentation

| Document | What's in it |
|----------|--------------|
| [docs/spec.md](docs/spec.md) | What the harness does: every feature, with open questions |
| [docs/employee.md](docs/employee.md) | The role: what an AI employee knows, and how it talks and works |
| [docs/execution.md](docs/execution.md) | How it runs: events, routing, runs, the entry tree, crash safety |
| [docs/architecture.md](docs/architecture.md) | How the code is organised: layers, ports and adapters, testing |
| [docs/stylebook.md](docs/stylebook.md) | How the web UI looks |

## Install

The whole thing runs with Docker Compose:

```sh
git clone https://github.com/nemanjan00/meatless-proxy.git
cd meatless-proxy
cp .env.example .env    # then set OPENAI_API_KEY and SECRETS_KEY
export DOCKER_GID=$(stat -c %g /var/run/docker.sock)   # so the app can reach the Docker socket
docker compose up
```

Then open <http://localhost:3000>. Set `APP_PORT` to serve on another port.

To sign in the first time, get a one-time link (valid 15 minutes):

```sh
docker compose exec app npm run login-link -- --contact you@example.com --create --access admin
# or, as the admin the first start created:
docker compose exec app npm run login-link -- --admin
```

Setting `ADMIN_EMAIL` in `.env` makes that person an admin on the next start
(the first-start admin gets the email, if nobody has it yet), and the log
shows a one-time link for them until they've signed in. Signing in gives a
session that lasts 14 days and renews with use. Admins invite everyone else
from Settings → People and access.

Live previews of what employees are building are served on their own origin:
port 3001 by default (`PREVIEW_HOST_PORT`), or `<env>-<port>.<PREVIEW_DOMAIN>`
with a wildcard DNS name and certificate for production. See
[packages/server/README.md](packages/server/README.md).
The app container manages project environments as sibling containers through
the host's Docker socket, so run it on a host dedicated to it. On first start the harness creates a default
AI employee, **Meatless**, with its router session, and the channels
`#general` and `#requests`. Post in `#requests` and it answers in the thread.

### Adding an employee

Admins press **New employee** in Settings → Employees, or on any employee's
page. Give it a name (its `@handle` follows from it, and can be changed), a
role and what it does; personality, instructions, model, projects and
channels are optional. It gets what Meatless got: a router session, its own
`#requests-<handle>` channel with a trigger to the router, a place in
`#general`, and an SSH keypair. `POST /api/employees` does the same.

### Connecting Slack, GitLab and Linear

Each employee's page (`/employees/<id>`) has a guided setup per integration.
Every step says what to do, gives the exact values to copy, and is ticked
only when the harness has checked it for real:

- **Slack:** "Create Slack app" opens Slack with the employee's own manifest
  (name, scopes, events, request URL). Paste its bot token and signing
  secret, and the page shows the bot, the channels it's in, whether events
  arrive, and offers the recommended trigger.
- **GitLab:** paste the service account's token (checked for the `api` scope
  and its expiry). "Add it for me" puts the employee's SSH key on the
  account. The page warns about Maintainer access and unprotected default
  branches, and shows the webhooks the harness registered.
- **Linear:** paste the API key, then create the webhook from the page (or
  by hand) and add the trigger.

Tokens are stored as secrets scoped to the employee and never shown again.
Webhook URLs use `PUBLIC_URL`, so set it to the address the systems can
reach. The manual steps are in each integration's README
([Slack](packages/integration-slack/README.md#setup),
[GitLab](packages/integration-gitlab/README.md#setup-on-gitlab),
[Linear](packages/integration-linear/README.md#setup-on-the-linear-side)).

### Talk to it from your own AI

The harness is also an MCP server. Your own Claude Code can talk to the
company's AI employees directly, and gets notified when they reply:

```sh
npm run token -- --contact <your contact id>     # prints a token once
claude mcp add --transport http meatless http://localhost:3000/mcp \
  --header "Authorization: Bearer <token>"
```

### Connecting MCP servers

Employees reach outside systems through MCP servers. Admins add them in
**Settings → MCP servers** (for every employee) or on an employee's page (for
that employee only), with no restart:

- a streamable HTTP URL, and a name: the tools become `mcp.<name>.<tool>`;
- no auth, a **token** (stored as a secret, sent as `Authorization: Bearer …`
  or a header you choose, never shown again), or **OAuth**: press **Connect**
  and sign in; the harness registers itself, keeps the tokens as secrets and
  refreshes them. OAuth needs `PUBLIC_URL`, the address the sign-in comes
  back to (`<PUBLIC_URL>/oauth/mcp/callback`).

stdio servers, which run a command on the host, can only be set in the
`MCP_SERVERS` config. See [docs/spec.md](docs/spec.md#connecting-mcp-servers).

The model provider is any OpenAI-compatible Chat Completions API. Kimi is the
first one it's tested with. Set `OPENAI_BASE_URL`, `OPENAI_API_KEY` and `MODEL`
in `.env`.

## Development

Development runs natively, without Docker. Node, Postgres and Redis are
installed through [asdf](https://asdf-vm.com) and pinned in `.tool-versions`.

```sh
asdf plugin add nodejs
asdf plugin add postgres https://github.com/smashedtoatoms/asdf-postgres.git
asdf plugin add redis https://github.com/smashedtoatoms/asdf-redis.git
asdf install                      # builds Postgres and Redis from source
npm install

# one-time database setup; data lives in .data/ (ignored by git)
initdb -D .data/postgres -U postgres --auth=trust -E UTF8
pg_ctl -D .data/postgres -l .data/postgres.log -o "-p 5432 -k /tmp" start
createdb -h 127.0.0.1 -U postgres meatless_proxy

# every time
pg_ctl -D .data/postgres -l .data/postgres.log -o "-p 5432 -k /tmp" start
mkdir -p .data/redis && redis-server --port 6379 --dir .data/redis --daemonize yes --logfile "$PWD/.data/redis.log"
cp .env.example .env              # once, then fill in
npm run dev
```

Or, if you'd rather not build them, run both in Docker for development:

```sh
docker run -d --name mp-dev-postgres -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=meatless_proxy -p 127.0.0.1:55432:5432 postgres:18
docker run -d --name mp-dev-redis -p 127.0.0.1:56379:6379 redis:8
# then DATABASE_URL=postgres://postgres@127.0.0.1:55432/meatless_proxy and REDIS_URL=redis://127.0.0.1:56379
```

Without `DATABASE_URL` and `REDIS_URL`, the server falls back to in-memory
storage and an in-memory queue. That's handy for trying things out, but
nothing is kept.

### Checks

```sh
npm test               # all tests (Postgres and Redis tests skip when not configured)
npm run lint           # Biome
npm run typecheck
npm run check:deps     # architecture: layers point down, no cycles
npm run check:secrets  # nothing that looks like a key in the repo
npm run check          # all of the above
MP_DOCKER_TEST=1 npx vitest run --project node packages/containers-docker   # against a real Docker daemon
MP_LIVE_MODEL_TEST=1 npx vitest run --project node packages/model-openai     # one real model call
```

CI runs all of these on every push, with Postgres and Redis.

## Screenshots

| Session | Session tree |
|---------|--------------|
| ![Session](packages/web/docs/screenshots/session-detail-dark.png) | ![Session tree](packages/web/docs/screenshots/session-tree-dark.png) |
| **Lineage** | **Chat** |
| ![Lineage](packages/web/docs/screenshots/lineage-dark.png) | ![Chat](packages/web/docs/screenshots/chat-dark.png) |

## Repository layout

```
docs/                 the spec and design documents
packages/
  core/               ids, errors, clock, logger, event bus, hooks, schemas
  store/ queue/ …     ports: generic interfaces with in-memory implementations
  store-postgres/ …   adapters: real implementations of the ports
  records/ sessions/… domain: contacts, projects, sessions, chat, …
  router/ runner/     the engine
  stdlib/             the model's tools
  server/ web/        the app: API, WebSocket, workers, and the web UI
scripts/              architecture and secret checks
```

Dependencies only point down the layers, and every component can be replaced
by writing a new package against the same interface. See
[docs/architecture.md](docs/architecture.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Coding agents: start with
[AGENTS.md](AGENTS.md). Please report vulnerabilities
privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
