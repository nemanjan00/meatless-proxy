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
- **Files and images, both ways.** People attach screenshots, logs and
  scripts in chat; employees attach any file they made (a chart, a script)
  and look at an image or read a file only when they need to (`image.view`,
  `chat.attachment_text`), so attachments cost tokens only when they matter.
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
[packages/server/README.md](packages/server/README.md). An environment can
also have a **desktop** (`env.up { desktop: true }`): a virtual screen for
headed browsers and GUI apps that people watch live in the browser (noVNC, on
the preview origin) and the employee sees through `env.screenshot`. The
**Environments** page lists everything that runs, with live CPU, memory and
network per container, what command runs in it, logs, and a Stop button.
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

### Assigning projects

An employee only knows what it works on once it's assigned: on its page,
**Projects** adds an existing project with a role (owner or member), and
**New project** creates one it owns, with its repository URLs and docs links.
A project's page adds employees and people the same way, and GitLab's setup
step adds the repositories the employee's account can reach with **Add as
project**. The employee sees its current projects at the start of every piece
of work, and the harness registers GitLab webhooks on their repositories.

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
  branches, adds the account's GitLab projects as harness projects ("Add as
  project"), and shows the webhooks the harness registered.
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
npm run token -- --contact <your contact id>     # prints a token once (or Settings → API tokens)
claude mcp add --transport http meatless-proxy <PUBLIC_URL>/mcp \
  --header "Authorization: Bearer mpt_…"
```

Then ask it to **join chat**. It calls `chat_join` and becomes a participant
of its own, like `@ordinary-plum` (a random name, or one you give it; the same
token and name reclaim it later), acting for you with at most `member` access
and seeing only what you can see. Employees and people can tag it, and it is
told about messages that mention it, DMs to it, replies in its threads and new
messages in channels it follows (`chat_join_channel`). What it misses while
disconnected waits in `chat_inbox`. `chat_search` searches the chat you can
see.

Messages arrive as MCP `notifications/message`, and also as Claude Code
[channel](https://code.claude.com/docs/en/channels-reference) notifications,
which put them straight into a running session. Channels are a research
preview: Claude Code only listens for them from servers you opt in at start,
e.g. `claude --dangerously-load-development-channels server:meatless-proxy`
(see its docs; they describe stdio servers, and whether an HTTP server is
accepted is not verified here). Without it, ask Claude to check `chat_inbox`.

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

### Code execution

Employees run Python and Node for math, data and charts with `code.run`, like
a notebook: variables and imports stay between runs in a session, and the last
expression's value comes back. Code runs in a sandbox container per employee
(`mp-<employee>-sandbox`: no network unless its setting gives one, non-root,
read-only root, CPU, memory and process limits, no secrets), never in the app. The employee's files are
its working directory, so a chart it saves is a file it can share.

| Variable | Default | What it does |
|----------|---------|--------------|
| `SANDBOX_IMAGE` | `ghcr.io/nemanjan00/meatless-proxy-sandbox:latest` | the image (`docker/sandbox/Dockerfile`: Python with numpy, pandas, sympy and matplotlib, and Node) |
| `DESKTOP_IMAGE` | `ghcr.io/nemanjan00/meatless-proxy-desktop:latest` | the desktop sidecar of `env.up { desktop: true }` (`docker/desktop/Dockerfile`: Xvfb, x11vnc and websockify; build your own with `docker build -t mp-desktop docker/desktop`) |
| `DEFAULT_EGRESS` | none | hosts environments and sandboxes may reach when neither the employee's network setting nor the project names any, e.g. `pypi.org,files.pythonhosted.org` |
| `ENV_PROFILES` | [nemanjan00/dev](https://github.com/nemanjan00/dev-environment) profiles | the toolkits `env.up` offers by name, as JSON `[{ "name", "image", "description" }]`; a project can pick one as its default (`envProfile`) |
| `ENV_DEFAULT_PROFILE` | `default` | the profile `env.up` uses when the call, the project and the checkout (no Dockerfile) don't decide |
| `DOCKER_DIRECT_NETWORK` | `true` | `false` turns every employee's "Direct network (no proxy)" setting into no network |
| `DOCKER_NAME_PREFIX` | `mp-` | prefix of every container and network (and their `mp.deployment` label); give each deployment on one Docker host its own, e.g. `mp-e2e-` |
| `SANDBOX_ENABLED` | `true` | turn code execution off (it also needs `DOCKER_ENABLED`) |
| `SANDBOX_CPUS`, `SANDBOX_MEMORY_MB`, `SANDBOX_PIDS` | 1, 1024, 256 | limits per employee's container |
| `SANDBOX_IDLE_MINUTES` | 15 | idle kernels, then containers, are stopped |
| `FILES_DIR` | `<DATA_DIR>/files` | where employee files live, one directory per employee |
| `FILES_VOLUME` | none | the named volume mounted at `FILES_DIR` (`mp-files`); with it, sandboxes mount the employee's files instead of copying them |

Network access follows each employee's **network** setting, on its page:

| Setting | Code sandbox and environments get |
|---------|-----------------------------------|
| Only the project's allowlist (default) | the project's hosts through the logging egress proxy; the sandbox has no project, so `DEFAULT_EGRESS` or nothing |
| Package registries, Any public host, These hosts… | those hosts through the proxy, narrowed to what the project allows too |
| Direct network (no proxy) | a real network of the employee's own, for SSH, database clients, raw TCP, UDP and DNS. Unrestricted and not logged: it can reach your LAN, cloud metadata and any host, but not the harness's own containers. Admins only, for employees you trust |
| No network | nothing |

Build the image yourself with `docker build -t mp-sandbox docker/sandbox` and
set `SANDBOX_IMAGE=mp-sandbox`. Employees also know the time: every message
carries when it arrived, and `time.now` answers in the company timezone
(the `timezone` setting, UTC by default). See
[docs/spec.md](docs/spec.md#code-execution).

### Files and images in chat

People attach any file to chat messages (the attach button, paste, or drag
and drop), and employees attach any file from their filesystem, such as a
chart or a script `code.run` saved (`/work/files/a.sh` in code is `/a.sh` for
the file tools and attachments; both spellings work everywhere). Messages name
attachments to employees (`[image: chart.png 800x600, attachment att_…]`,
`[file: ipwatch.sh 1.2 KB text/x-shellscript, attachment att_…]`), and an
employee looks at an image with `image.view` or reads a text file with
`chat.attachment_text` only when it needs to. Types are sniffed from the
content: only PNG, JPEG, GIF and WebP are images, shown inline; everything
else is always a download (HTML, SVG, XML, JavaScript and PDF as
`application/octet-stream`), and small text files get a plain-text preview.
Attachments live on the files volume, and only people who can see the channel
can open them. An employee that posts the same text in the same thread twice
within two minutes is told so instead of posting it again.

| Variable | Default | What it does |
|----------|---------|--------------|
| `MODEL_VISION` | `auto` | whether the model can see images: `auto` asks the provider's model list, then goes by the model's name; `true` or `false` to say so |
| `MODEL_IMAGE_MAX_SIDE` | 1568 | images for the model are downscaled to this many pixels on the longest side (PNG; other types pass through) |
| `MODEL_IMAGE_MAX_BYTES` | 5 MB | larger images aren't sent to the model |
| `IMAGE_DESCRIBE` | `view` | saved image descriptions, one model call per image, reused everywhere: `view` describes an image on its first look, `upload` in the background when it's posted, `off` never (needs vision) |
| `IMAGE_DESCRIBE_MODEL` | `MODEL` | the model that describes images, on the same provider |
| `CHAT_ATTACHMENT_MAX_BYTES` | 10 MB | per attached file or image |
| `CHAT_ATTACHMENTS_PER_MESSAGE` | 10 | attachments per message |

### Limits and budgets

Runaway protection works out of the box. Every employee gets these defaults,
and admins override them in **Settings → Limits** for the whole deployment,
every or one employee, or every or one requester (the person who asked). The
most specific override wins. Work over a limit pauses with the reason and
waits for someone to resume it; nothing is dropped. `#alerts` gets a warning
at 80 % of a daily budget and a note when it's used up, tagging the
employee's owner or the admins.

| Variable | Default | What it does |
|----------|---------|--------------|
| `LIMIT_MAX_DEPTH` | 5 | how deep forks may go |
| `LIMIT_MAX_FAN_OUT` | 20 | children per loop |
| `LIMIT_MAX_CONCURRENT_RUNS` | 8 | runs of one employee working at once; more wait in the queue |
| `MAX_STEPS` | 60 | model calls per run before it pauses |
| `LIMIT_RUN_WALL_MINUTES` | 30 | minutes of work per run before it pauses, between steps (`0`: no limit) |
| `LIMIT_EMPLOYEE_DAILY_TOKENS` | 5,000,000 | tokens per employee per UTC day (`0`: no limit) |
| `LIMIT_EMPLOYEE_DAILY_COST_USD` | off | dollars per employee per UTC day (counts only models with a price) |
| `LIMIT_DEPLOYMENT_DAILY_TOKENS`, `LIMIT_DEPLOYMENT_DAILY_COST_USD` | off | the same for the whole deployment |
| `BUDGET_WARN_PERCENT` | 80 | when `#alerts` warns about a budget (`0`: never) |
| `PRICING` | built-in table | USD per million tokens per model, as JSON (`{"my-model":{"inputPerM":0.6,"cachedInputPerM":0.15,"outputPerM":2.5}}`) or a JSON file |

Costs come from a small built-in price table (Kimi and some OpenAI models,
checked on the providers' pricing pages), `PRICING`, and **Settings →
Pricing**, which wins over both. A model without a price costs $0 and the UI
says "no pricing configured". See
[docs/spec.md](docs/spec.md#configurable-limits).

The model provider is any OpenAI-compatible Chat Completions API. Kimi is the
first one it's tested with. Set `OPENAI_BASE_URL`, `OPENAI_API_KEY` and `MODEL`
in `.env`. The model must support tool calling: employees work through tools.
For web search, add a search MCP server (Brave Search, Tavily, SearXNG, …) in
Settings → MCP servers; its tools show up for employees like any other.
Search-only models such as OpenAI's search-preview ones don't take tools in
Chat Completions, so they can't run an employee.

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
docker/sandbox/       the code.run sandbox image
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
