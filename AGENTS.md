# AGENTS.md

Instructions for coding agents working on **meatless-proxy**, an AI harness
that runs AI employees who talk to a whole company. Read this first, then
the design documents.

## Read before changing anything

| Document | What it tells you |
|----------|-------------------|
| [docs/spec.md](docs/spec.md) | What the harness does. It is the source of truth for behaviour. |
| [docs/execution.md](docs/execution.md) | How it runs: events, routing, runs, the entry tree, crash safety. |
| [docs/architecture.md](docs/architecture.md) | Where code lives and how packages may depend on each other. |
| [docs/stylebook.md](docs/stylebook.md) | How the web UI looks. Follow it for any UI change. |
| [docs/employee.md](docs/employee.md) | How an AI employee behaves. |

If you change behaviour, update the spec in the same change. If the spec and
the code disagree, the code is wrong, or the spec needs a deliberate update.

## Layout

```
packages/<name>/     one package per component, each with src/, test/ and a README.md
  core               ids, errors, clock, logger, event bus, hooks, schemas (layer 0)
  store, queue, …    ports: generic interfaces + in-memory implementation + contract tests (layer 1)
  store-postgres, …  adapters: real implementations of the ports (layer 2)
  integration-*      first-party integrations (Slack, Linear, GitLab), as MCP servers (layer 2)
  records, …         domain packages (layer 3)
  router, runner     the engine (layer 4)
  stdlib             the model's tools, the employee prompt, policy hooks (layer 5)
  server, web        composition root and API; the web UI (layer 6)
scripts/             layers.json (every package's layer), check-deps.ts, check-secrets.ts
docs/                the spec and design documents
```

## Rules that the build enforces

- **Dependencies point down the layers only.** A package may import packages
  from lower layers (and, in the domain layer, domain packages listed earlier
  in `scripts/layers.json` `domainOrder`). Only `@mp/server` and `@mp/evals`
  import adapters. New packages need an entry in `scripts/layers.json`.
  `npm run check:deps` fails otherwise.
- **Upward feedback goes through the event bus or hooks** (`@mp/core`),
  never through an import of a higher layer.
- **Ports come with contract suites.** A new implementation of a port must
  pass the port's contract (e.g. `storeContract`, `queueContract`,
  `mcpHubContract`, `secretStoreContract`).
- **No secrets in the repo.** It's public and pushed automatically.
  `npm run check:secrets` scans every tracked file. Use fake values in tests
  and examples (`sk-test`, `ana@example.com`). `.env` is never committed.

## Commands

```sh
npm install                  # workspaces; commit package-lock.json with any dependency change
npm test                     # vitest; tests needing Postgres/Redis/Docker/a model skip unless configured
npm run lint                 # Biome (lint:fix to format)
npm run typecheck            # the root tsconfig (the web UI has its own: npm run build -w @mp/web)
npm run check:deps           # layering and cycles
npm run check:secrets        # leak scan
npm run check                # all of the above
npm run dev                  # the server with tsx watch
```

Services for tests: set `DATABASE_URL` and `REDIS_URL` (see the README for
running Postgres and Redis locally). Opt-in suites:
- `MP_DOCKER_TEST=1` runs the Docker adapter against a real daemon.
- `MP_LIVE_MODEL_TEST=1` makes one real model call.
- `MP_LIVE_<INTEGRATION>=1` runs an integration's live smoke test.

`npm ci` must pass on a clean checkout. CI runs it, so keep
`package-lock.json` in sync with every `package.json`.

## Conventions

- **TypeScript, strict, ESM.** Local imports use the `.ts` extension.
  Type-only imports use `import type`.
- **Biome style:** single quotes, no semicolons, 2 spaces, 130 columns.
  Match the code around you.
- **Inject** the `Clock`, `Logger` and `EventBus`. Only `@mp/server` reads
  environment variables.
- **Errors** are the typed ones from `@mp/core` (`NotFoundError`,
  `ConflictError`, `ValidationError`, `DeniedError`, `LimitError`,
  `UnavailableError`).
- **Records, not tables.** Domain data is records with extendable schemas
  (`@mp/records`); links are records too. A new kind rarely needs a migration.
  Schema changes to the Postgres adapter are new numbered files in
  `packages/store-postgres/migrations/`, never edits to old ones.
- **Tests** live in `packages/<name>/test/*.test.ts`. Test failure paths and
  races, not only the happy path. Use the in-memory implementations and fakes
  (`memoryStore`, `memoryQueue`, `scriptedModel`, `fakeMcpHub`,
  `fakeGitCache`, `fakeRuntime`). Never call real external services from a
  test unless it's gated behind an opt-in variable.
- **Replacing a component:** write a new package against the same interface,
  pass the same contract tests, switch the composition root, delete the old
  one.

## Hard limits that code must keep

These are product guarantees. Don't weaken them, and add tests when you touch
nearby code:

- **Employees never merge, deploy or push to protected branches.** Only their
  own branches, and merge requests. The GitLab integration has no merge tool
  on purpose.
- **Secrets are injected at call time** and redacted from outputs. They never
  reach the model, the history, logs or the UI.
- **Untrusted input** (events from triggers and fallbacks, repo content,
  webhook payloads) is marked and treated as information, not instructions.
- **Live previews run on a separate origin** from the harness, with scoped
  short-lived tokens. They never get the harness's cookie.
