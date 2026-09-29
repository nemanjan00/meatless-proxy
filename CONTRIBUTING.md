# Contributing

Thanks for looking. meatless-proxy is experimental and moves fast, so the
best way to help is to open an issue first and talk about what you want to
change.

Using a coding agent? Point it at [AGENTS.md](AGENTS.md) (Claude Code reads
it through `CLAUDE.md`).

## How the code is organised

Read [docs/architecture.md](docs/architecture.md) before changing code. In
short:

- Every component is a package under `packages/`, in a layer.
  **Dependencies only point down**, and `npm run check:deps` fails the build
  otherwise.
- Low-level code reports back up through the **event bus** and **hooks**,
  never by importing higher layers.
- Everything outside the process sits behind a **port** with an in-memory
  implementation and a **contract test suite**. Adapters must pass the same
  suite.
- To rewrite a component, write a new package against the same interface and
  switch the composition root in `@mp/server`.

## Development

See [Development](README.md#development) in the README. Before you open a
pull request:

```sh
npm run check        # dependency rules, secret scan, lint, types, tests
```

Tests that need Postgres, Redis, Docker or a real model skip themselves unless
configured. CI runs them with Postgres and Redis.

## Style

- TypeScript, strict, ESM. Format and lint with Biome (`npm run lint:fix`).
- Inject the clock, logger and bus, instead of reaching for globals.
- Keep interfaces generic and documented. Keep docs in `docs/` in sync with
  behaviour.
- Never commit secrets. The repo is public, and `npm run check:secrets` runs
  in CI.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
