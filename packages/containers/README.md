# @mp/containers

The containers port (L1): isolated project environments and commands run in them.

## API

- `ContainerRuntime`: `createEnv`, `getEnv`, `listEnvs(labels?)`, `exec(envId, cmd, opts)`, `logs`, `destroyEnv` (idempotent).
- `EnvSpec`, `EnvInfo`, `ExecOptions`, `ExecResult`, `Mount`: the shapes above.
- `TIMEOUT_EXIT_CODE` (124): the exit code of a command that hit `timeoutMs` (`timedOut: true`).
- `ExecAbortedError`: what `exec` rejects with when its `signal` aborts.
- `fakeRuntime(opts?)`: in-memory runtime for tests. Tracks environments, records every exec in `calls`, and
  answers scripted responses: `runtime.on(/npm test/, { exitCode: 1, stdout: '...' })` or a function
  `(call, env) => response`. Responses can set `delayMs`, `hang`, `chunks` (streamed via `onOutput`), or `error`.
  Also `appendLog`, `stop`, `failNextCreate`, `envs()`, `created`.

## Tests

`test/fake.test.ts` covers the fake. Adapters (e.g. `@mp/containers-docker`) have their own tests.

## Replacing it

Implement `ContainerRuntime` in a new adapter package and switch the composition root.
