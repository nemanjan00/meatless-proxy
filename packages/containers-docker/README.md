# @mp/containers-docker

Docker adapter (L2) for `@mp/containers`, using dockerode.

## API

`dockerRuntime({ docker?, socketPath?, logger?, clock?, namePrefix = 'mp-', labels?, capDrop?, pidsLimit?, maxOutputBytes? })`
returns a `ContainerRuntime`. Also exported: `mapError`, `demuxBuffer`, `NotImplementedError`, the `mp.*` label names and the
`DockerLike` interface (the slice of dockerode used).

Per environment `<name>`:

- image: pulled if missing, or built from `build.context` (an absolute local directory; dockerode tars it and honours
  `.dockerignore`) as `<prefix>build/<name>:latest`. Remote build contexts throw `NotImplementedError`.
- network `<prefix><name>`: a bridge with `Internal: true` unless `allowInternet`, so containers can't reach the harness's
  Postgres/Redis or the internet.
- services `<prefix><name>-<service>` on that network, reachable by their service name (network alias).
- main container `<prefix><name>` (this is the env id): binds, env, workdir, `NanoCpus`/`Memory` limits, labels
  `mp.env=<name>`, `mp.managed=true`, `mp.role=main`, command default `sleep infinity`. Never privileged, never host
  network, `no-new-privileges`, a few capabilities dropped (`DEFAULT_CAP_DROP`), pids limit, runs as the image's user.
- exec: `container.exec` + `exec.start({ hijack: true })`, demuxed with `modem.demuxStream`. On timeout the stream is
  dropped and the result has `timedOut: true`, exit code 124. Docker can't kill an exec'd process, so it is abandoned
  (it dies with the environment). Aborting rejects with `ExecAbortedError`.
- destroy: removes every container labelled `mp.env=<name>` (with anonymous volumes) and the network. Idempotent, and
  also cleans up half-created environments. A failed `createEnv` cleans up after itself.

Errors: 404 -> `NotFoundError` (`getEnv` returns null), 409 -> `ConflictError`, 400 -> `ValidationError`, 5xx and socket
errors -> `UnavailableError`.

## Tests

`test/docker.test.ts` runs against `test/mock-docker.ts`, a hand-written in-memory Docker (it uses the real modem's
demuxing and progress parsing, but never connects to a daemon). No real Docker is used.

## Replacing it

Write another `ContainerRuntime` adapter (Podman, Kubernetes, ...) and switch the composition root.
