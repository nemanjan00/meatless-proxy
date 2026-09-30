# @mp/containers

The containers port (L1): isolated project environments and commands run in them.

## API

- `ContainerRuntime`: `createEnv`, `getEnv`, `listEnvs(labels?)`, `exec(envId, cmd, opts)`, `logs`, `destroyEnv` (idempotent).
- `EnvSpec`, `EnvInfo`, `ExecOptions`, `ExecResult`, `Mount`: the shapes above.
- `EnvSpec.egress?: { allow: string[] }`: network access only through an allowlisting egress proxy. Entries are hostname
  globs with optional ports (`registry.npmjs.org`, `*.github.com`, `host:443`); `*` matches any run of characters (so
  `*.github.com` doesn't match `github.com`), and an entry without a port allows every port. IP literals, `localhost` and
  private/loopback/link-local addresses are reachable only through an exact entry, never a wildcard. Network modes:
  `egress` set -> proxy only; none of them -> no network at all; `allowInternet: true` -> unrestricted;
  `direct: { network }` -> a real network shared by name (see below). They exclude each other: `invalidNetworkSpec(spec)`
  names the conflicts.
- `EnvSpec.direct?: { network: string }`: a real, unproxied network. The containers also join the shared network
  `network` (the runtime adds its prefix; names match `DIRECT_NETWORK_RE`), made on first use and kept. It routes out
  through the host (any host, any protocol) with no allowlist and no log. Containers of different environments on it
  can't reach each other, and it never joins the harness's own networks. Used for an employee's `direct` network
  setting: `<handle>-direct`, one per employee.
- `EnvSpec.expose?: number[]`: ports the main container serves (a dev server on 5173), for live previews. Nothing is
  published on the host. `invalidExpose(list)` names the problems (integers 1-65535, distinct, at most
  `MAX_EXPOSED_PORTS` = 16).
- `previewTarget?(envId, port)` (optional on `ContainerRuntime`): `PreviewTarget` `{ host, port }`, where the harness
  process connects to reach an exposed port. `NotFoundError` when the environment is gone or doesn't expose the port.
- `EnvSpec.desktop?: { width?, height? }`: a virtual desktop next to the main container (display `DESKTOP_DISPLAY`
  = `:99`, `DISPLAY` set for the main container), with a VNC server on localhost only and WebSocket bridges on
  `DESKTOP_PORTS` (`control` 6080, `view` 6081: its VNC server refuses input), reached like exposed ports through
  `previewTarget`. `invalidDesktop(desktop, expose)` checks sizes (320x240 to 3840x2160) and clashes with `expose`.
  `EnvInfo.desktop` says whether an environment has one, `features().desktop` whether the runtime can.
- `screenshot?(envId)`: a PNG of the desktop (`NotFoundError` without one). `stats?(envId)`: `EnvStats` with one
  `ContainerStats` per working container (main, services, desktop): CPU %, memory and its limit, network rx/tx, pids,
  start time; null where unknown. `processes?(envId)`: `ContainerProcesses[]`, each container's top processes.
- `EnvInfo.image` / `imageId`: the image the main container runs, as the runtime reports it; `built` (with its `base`
  when known) when it was built from a Dockerfile. `getEnv` also fills `startedAt` and `limits` (`EnvLimits`: `cpus`,
  `memoryBytes`, `pids`); `listEnvs` may not. `inspectImage?(ref)` (by reference or ID): `ImageInfo` `{ ref, id,
  repoDigests, repoTags, sizeBytes, createdAt, os, architecture, labels }`, or null when there is no such image.
- `egressLog?(envId)` (optional on `ContainerRuntime`): the proxy's log, `EgressLogEntry[]` (`{ at, method, host, port,
  allowed, reason? }`).
- Allowlist helpers: `checkEgress(allow, host, port)` (the decision, before DNS), `intersectEgress(a, b)` (what both lists
  allow: the narrower host and port of each covering pair, so it never widens either), `parseEgressEntry`,
  `invalidEgressEntries`, `hostGlobMatch`, `isPrivateAddress`, `egressEntryCovered(entry, allow)` (whether a requested
  entry only narrows `allow`).
- Hardening for sandboxes: `EnvSpec.user` (`uid:gid`), `readOnlyRootfs`, `volumes` (container paths that get a fresh volume,
  removed with the environment), `tmpfs` (`{ '/tmp': { sizeMb } }`), `limits.pids`, and `volumeMounts` (`VolumeMount`:
  part of an existing named volume, `{ volume, subpath?, containerPath, readOnly? }`; `invalidVolumeMounts` checks them).
  `ExecOptions.user` runs one command as another user.
- `spawn?(envId, cmd, { env, workdir, onOutput })` (optional): a long-running process with stdin attached, a `Process`
  (`write`, `end`, `exited` with the exit code or null, `kill`, which also kills its process group when it leads one).
- `copyIn?(envId, dir, entries)` / `copyOut?(envId, path)` (optional): `FileEntry` files and directories (`path` relative,
  `content`, `mode`, `uid`, `gid`, `mtimeMs`) into a directory of the main container, or a file or a tree out of it (paths
  relative to its parent; a missing path gives `[]`). `invalidEntryPath` checks entry paths.
- `features?()` (optional): `RuntimeFeatures` (`volumeSubpath`).
- `runtimeContract(name, make, { image })` from `@mp/containers/contract`: the suite for `spawn`, `copyIn`, `copyOut` and
  `features` (the image needs `sh` and `cat`).
- `TIMEOUT_EXIT_CODE` (124): the exit code of a command that hit `timeoutMs` (`timedOut: true`).
- `ExecAbortedError`: what `exec` rejects with when its `signal` aborts.
- `fakeRuntime(opts?)`: in-memory runtime for tests. Tracks environments, records every exec in `calls`, and
  answers scripted responses: `runtime.on(/npm test/, { exitCode: 1, stdout: '...' })` or a function
  `(call, env) => response`. Responses can set `delayMs`, `hang`, `chunks` (streamed via `onOutput`), or `error`.
  Also `appendLog`, `stop`, `failNextCreate`, `envs()`, `created`. `egressAllowed(envId, host, port)` answers what the real
  runtime would allow (allowlist with `egress`, anything with `allowInternet` or `direct`, else nothing) and adds proxied decisions to
  `egressLog(envId)`. `previewTarget` points exposed ports at `127.0.0.1:<port>` (or the `previewTarget` option's
  answer), and `servePreview(envId, port, target)` points one at a local test server. `spawn` plays processes:
  `onSpawn(match, host => …)` scripts them (`host.stdout`, `stderr`, `exit`, `onInput`, `onEnd`, `onKill`, `env`); without a
  handler `cat` echoes and anything else waits for stdin to close. `spawns` and `running()` show what ran. Each environment
  has an in-memory filesystem (`env.files`) for `copyIn`/`copyOut`, with `writeFile`, `readFile` and `removeFile` for tests
  acting as a process would (modification times always increase). The `features` option sets `features()`.
  Desktops: `screenshot` returns `FAKE_PNG` (or what `setScreenshot(envId, png | Error)` set), `stats` made-up numbers
  per container (`setStats(envId, name, partial)` overrides), `processes` one row per container.
  Images: environments report `image` (`build/<name>:latest` for a build, like Docker), `imageId` (`fakeImageId(ref)`),
  `startedAt` and `limits`; `inspectImage` describes the images of live environments and whatever `setImage(ref, partial
  | null)` set (null: no such image), and counts calls in `imageInspections`.

## Tests

`test/interactive.test.ts` runs `runtimeContract` against the fake and covers spawn handlers, the fake filesystem and
volume mounts. `test/fake.test.ts` covers the fake, `test/egress.test.ts` the allowlist logic and the fake's egress, `test/preview.test.ts`
`invalidExpose` and the fake's previews. Adapters (e.g. `@mp/containers-docker`) have their own tests.

## Replacing it

Implement `ContainerRuntime` in a new adapter package and switch the composition root.
