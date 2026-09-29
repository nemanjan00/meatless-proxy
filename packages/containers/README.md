# @mp/containers

The containers port (L1): isolated project environments and commands run in them.

## API

- `ContainerRuntime`: `createEnv`, `getEnv`, `listEnvs(labels?)`, `exec(envId, cmd, opts)`, `logs`, `destroyEnv` (idempotent).
- `EnvSpec`, `EnvInfo`, `ExecOptions`, `ExecResult`, `Mount`: the shapes above.
- `EnvSpec.egress?: { allow: string[] }`: network access only through an allowlisting egress proxy. Entries are hostname
  globs with optional ports (`registry.npmjs.org`, `*.github.com`, `host:443`); `*` matches any run of characters (so
  `*.github.com` doesn't match `github.com`), and an entry without a port allows every port. IP literals, `localhost` and
  private/loopback/link-local addresses are reachable only through an exact entry, never a wildcard. Network modes:
  `egress` set -> proxy only; neither -> no network at all; `allowInternet: true` -> unrestricted (excludes `egress`).
- `egressLog?(envId)` (optional on `ContainerRuntime`): the proxy's log, `EgressLogEntry[]` (`{ at, method, host, port,
  allowed, reason? }`).
- Allowlist helpers: `checkEgress(allow, host, port)` (the decision, before DNS), `parseEgressEntry`,
  `invalidEgressEntries`, `hostGlobMatch`, `isPrivateAddress`, `egressEntryCovered(entry, allow)` (whether a requested
  entry only narrows `allow`).
- `TIMEOUT_EXIT_CODE` (124): the exit code of a command that hit `timeoutMs` (`timedOut: true`).
- `ExecAbortedError`: what `exec` rejects with when its `signal` aborts.
- `fakeRuntime(opts?)`: in-memory runtime for tests. Tracks environments, records every exec in `calls`, and
  answers scripted responses: `runtime.on(/npm test/, { exitCode: 1, stdout: '...' })` or a function
  `(call, env) => response`. Responses can set `delayMs`, `hang`, `chunks` (streamed via `onOutput`), or `error`.
  Also `appendLog`, `stop`, `failNextCreate`, `envs()`, `created`. `egressAllowed(envId, host, port)` answers what the real
  runtime would allow (allowlist with `egress`, anything with `allowInternet`, else nothing) and adds proxied decisions to
  `egressLog(envId)`.

## Tests

`test/fake.test.ts` covers the fake, `test/egress.test.ts` the allowlist logic and the fake's egress. Adapters (e.g. `@mp/containers-docker`) have their own tests.

## Replacing it

Implement `ContainerRuntime` in a new adapter package and switch the composition root.
