# vegan

**A meat proxy, without the meat.**

A *meat proxy* is the person who relays between their colleagues and an AI:
they paste a question into a chatbot and paste the answer back. vegan cuts
them out. It runs **AI employees** that sit in your company's Slack, GitLab
and Linear, know who everyone is and who owns what, take work from whoever
asks, and answer like a colleague would: briefly, and correctly.

[![vegan intro (video)](https://img.youtube.com/vi/HHKr9trlRIA/maxresdefault.jpg)](https://www.youtube.com/watch?v=HHKr9trlRIA)

▶ **[Watch the intro](https://www.youtube.com/watch?v=HHKr9trlRIA)**

> **Status: early and experimental.** Everything in `docs/` is implemented
> and runs end to end in production against a real model.
> Expect breaking changes: components are built to be thrown away and
> rewritten.

## Why it's different

Most agent harnesses have one person at a terminal. vegan has a whole company
talking to it at once.

- **Work comes to it.** Chat messages, task assignments, merge request
  comments and schedules start work. A router per employee sends each one to
  the session that already has the context, or starts a new one.
- **Nothing is lost.** Every session's full history lives in Postgres.
  Sessions survive restarts, move between workers, fork, fan out over a list,
  and rewind with a summary instead of compacting away the past.
- **It knows the company.** People, projects, owners, procedures and memory
  are records the employee sees at the start of every piece of work. Each
  procedure has a context that already knows it, and work that needs it runs
  in a fork.
- **It does real work.** Its own branches and merge requests, live preview
  environments, a desktop for headed browsers, a Python/Node sandbox for data
  and charts, files and images in both directions, and any MCP server you add.
- **Safe by construction.** Employees open merge requests and never merge,
  deploy or push to protected branches. Secrets are injected at call time and
  never reach the model, logs or UI. Untrusted input is information, not
  instructions. Runaway work pauses on limits and budgets instead of burning
  money.
- **Your own AI can join in.** The harness is an MCP server: your Claude Code
  joins company chat as a participant, asks employees for things, and is
  notified when they reply.

## Quick start

Everything runs with Docker Compose:

```sh
git clone https://github.com/nemanjan00/meatless-proxy.git vegan
cd vegan
cp .env.example .env    # set OPENAI_API_KEY, MODEL and SECRETS_KEY
docker compose up
```

Open <http://localhost:3000> and get a sign-in link:

```sh
docker compose exec app npm run login-link -- --admin
```

A default employee, **Meatless**, is waiting in `#requests`. Ask it
something. From there, [docs/setup.md](docs/setup.md) covers adding
employees and projects, connecting Slack, GitLab and Linear, MCP servers,
sandboxes, limits and every setting.

The model is any OpenAI-compatible Chat Completions API with tool calling
(`OPENAI_BASE_URL`, `OPENAI_API_KEY`, `MODEL`).

## Screenshots

| Chat | Session |
|------|---------|
| ![Chat](packages/web/docs/screenshots/chat-dark.png) | ![Session](packages/web/docs/screenshots/session-detail-dark.png) |
| **Session tree** | **Lineage** |
| ![Session tree](packages/web/docs/screenshots/session-tree-dark.png) | ![Lineage](packages/web/docs/screenshots/lineage-dark.png) |

## Documentation

| Document | What's in it |
|----------|--------------|
| [docs/setup.md](docs/setup.md) | Running a deployment: employees, projects, integrations, MCP, sandboxes, every setting |
| [docs/spec.md](docs/spec.md) | What the harness does, feature by feature. The source of truth for behaviour |
| [docs/employee.md](docs/employee.md) | The role: what an AI employee knows, and how it talks and works |
| [docs/execution.md](docs/execution.md) | How it runs: events, routing, runs, the entry tree, crash safety |
| [docs/architecture.md](docs/architecture.md) | How the code is organised: layers, ports and adapters, testing |
| [CONTEXT.md](CONTEXT.md) | How a session manages its context window: offload, collapse, compaction |
| [docs/benchmark.md](docs/benchmark.md) | The context benchmark, round by round |
| [docs/stylebook.md](docs/stylebook.md) | How the web UI looks |
| [packages/server/README.md](packages/server/README.md) | The HTTP API, sign-in, previews, webhooks and operations |

## Development

Development runs natively, with Node, Postgres and Redis pinned in
`.tool-versions` ([asdf](https://asdf-vm.com)). If you'd rather not build
Postgres and Redis, run them in Docker:

```sh
npm install
docker run -d --name mp-dev-postgres -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=meatless_proxy -p 127.0.0.1:55432:5432 postgres:18
docker run -d --name mp-dev-redis -p 127.0.0.1:56379:6379 redis:8
cp .env.example .env    # DATABASE_URL=postgres://postgres@127.0.0.1:55432/meatless_proxy, REDIS_URL=redis://127.0.0.1:56379
npm run dev
```

Without `DATABASE_URL` and `REDIS_URL` the server runs in memory: handy for
trying things out, but nothing is kept.

<details>
<summary>Postgres and Redis through asdf instead</summary>

```sh
asdf plugin add nodejs
asdf plugin add postgres https://github.com/smashedtoatoms/asdf-postgres.git
asdf plugin add redis https://github.com/smashedtoatoms/asdf-redis.git
asdf install                      # builds Postgres and Redis from source

# one-time database setup; data lives in .data/ (ignored by git)
initdb -D .data/postgres -U postgres --auth=trust -E UTF8
pg_ctl -D .data/postgres -l .data/postgres.log -o "-p 5432 -k /tmp" start
createdb -h 127.0.0.1 -U postgres meatless_proxy

# every time
pg_ctl -D .data/postgres -l .data/postgres.log -o "-p 5432 -k /tmp" start
mkdir -p .data/redis && redis-server --port 6379 --dir .data/redis --daemonize yes --logfile "$PWD/.data/redis.log"
```

</details>

### Checks

```sh
npm run check          # all of the below
npm test               # vitest; Postgres and Redis tests skip when not configured
npm run lint           # Biome
npm run typecheck
npm run check:deps     # layers point down, no cycles
npm run check:secrets  # nothing that looks like a key in the repo
npx tsx scripts/context-overhead.ts                                          # tokens of the employee prompt and tools
MP_DOCKER_TEST=1 npx vitest run --project node packages/containers-docker   # against a real Docker daemon
MP_LIVE_MODEL_TEST=1 npx vitest run --project node packages/model-openai     # one real model call
```

CI runs them on every push, with Postgres and Redis.

## Repository layout

```
packages/
  core/               ids, errors, clock, logger, event bus, hooks, schemas
  store/ queue/ …     ports: generic interfaces with in-memory implementations
  store-postgres/ …   adapters: real implementations of the ports
  integration-*/      Slack, GitLab and Linear, as MCP servers
  records/ sessions/… domain: contacts, projects, sessions, chat, …
  router/ runner/     the engine
  stdlib/             the model's tools and the employee prompt
  server/ web/        the app: API, WebSocket, workers, and the web UI
docker/               the sandbox and desktop images
docs/                 the spec and design documents
scripts/              architecture and secret checks, context measurements
```

Dependencies only point down the layers, and any component can be replaced
by a new package against the same interface. See
[docs/architecture.md](docs/architecture.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Coding agents start with
[AGENTS.md](AGENTS.md). Report vulnerabilities privately, as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
