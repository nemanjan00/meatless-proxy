# @mp/containers-docker

Docker adapter (L2) for `@mp/containers`, using dockerode.

## API

`dockerRuntime({ docker?, socketPath?, logger?, clock?, namePrefix = 'mp-', labels?, capDrop?, pidsLimit?, maxOutputBytes?, proxyImage? })`
returns a `ContainerRuntime`. Also exported: `mapError`, `demuxBuffer`, `NotImplementedError`, the `mp.*` label names and the
`DockerLike` interface (the slice of dockerode used), `parseEgressLog`, and the egress proxy: `createEgressProxy`,
`EGRESS_PROXY_SOURCE`, `egressProxyDecision`, `EGRESS_PROXY_PORT` (3128), `DEFAULT_PROXY_IMAGE` (`node:26-alpine`),
`PROXY_URL`.

Per environment `<name>`:

- image: pulled if missing, or built from `build.context` (an absolute local directory; dockerode tars it and honours
  `.dockerignore`) as `<prefix>build/<name>:latest`. Remote build contexts throw `NotImplementedError`.
- network `<prefix><name>`: a bridge with `Internal: true` unless `allowInternet`, so containers can't reach the harness's
  Postgres/Redis or the internet.
- services `<prefix><name>-<service>` on that network, reachable by their service name (network alias).
- with `egress`: a second, non-internal network `<prefix><name>-egress`, and a proxy sidecar `<prefix><name>-proxy`
  (`proxyImage`, running `node -e EGRESS_PROXY_SOURCE` as uid 65534, read-only root, 256 MiB) on the env network with alias
  `proxy`, then connected to the egress network. It is the only container with a route out. The main container and the
  services get `HTTP_PROXY`/`HTTPS_PROXY`/`http_proxy`/`https_proxy=http://proxy:3128` and
  `NO_PROXY`/`no_proxy=localhost,127.0.0.1,<services>` (overriding the spec's own). `egress` excludes `allowInternet`,
  and no service may be called `proxy` then. `egressLog(envId)` reads the proxy's stdout and parses its JSON lines.
- main container `<prefix><name>` (this is the env id): binds, env, workdir, `NanoCpus`/`Memory` limits, labels
  `mp.env=<name>`, `mp.managed=true`, `mp.role=main`, command default `sleep infinity`. Never privileged, never host
  network, `no-new-privileges`, a few capabilities dropped (`DEFAULT_CAP_DROP`), pids limit, runs as the image's user.
- exec: `container.exec` + `exec.start({ hijack: true })`, demuxed with `modem.demuxStream`. On timeout the stream is
  dropped and the result has `timedOut: true`, exit code 124. Docker can't kill an exec'd process, so it is abandoned
  (it dies with the environment). Aborting rejects with `ExecAbortedError`.
- destroy: removes every container labelled `mp.env=<name>` (with anonymous volumes), the proxy, and both networks. Idempotent, and
  also cleans up half-created environments. A failed `createEnv` cleans up after itself.

Errors: 404 -> `NotFoundError` (`getEnv` returns null), 409 -> `ConflictError`, 400 -> `ValidationError`, 5xx and socket
errors -> `UnavailableError`.

## The egress proxy

`src/egress-proxy-core.cjs` is a small forward proxy in plain CommonJS with node built-ins only: plain HTTP forwarding
(absolute-URI requests, hop-by-hop and `Proxy-*` headers dropped) and `CONNECT` tunnels. Anything not on the allowlist gets
403. IP literals, `localhost` and hosts that resolve to private, loopback or link-local addresses are refused unless listed
exactly; the proxy connects to the address it checked (no DNS rebinding). One JSON line per request on stdout:
`{ at, method, host, port, allowed, reason? }`. The same file is loaded in-process by `createEgressProxy({ allow, logger?,
lookup?, now? })` (returns an `http.Server`, not listening yet) and inlined verbatim into `EGRESS_PROXY_SOURCE`, which reads
`ALLOW` (JSON list), `PORT` and `HOST` from the environment. Its allowlist logic is a copy of `checkEgress` in
`@mp/containers`; a test checks that both agree.

## Tests

`test/docker.test.ts` runs against `test/mock-docker.ts`, a hand-written in-memory Docker (it uses the real modem's
demuxing and progress parsing, but never connects to a daemon). No real Docker is used. `test/egress-docker.test.ts`
checks the egress networks, the sidecar, aliases, proxy variables, cleanup and `egressLog` against the mock.
`test/egress-proxy.test.ts` runs `createEgressProxy` in-process against a local HTTP upstream and a local TCP echo target
(forwarding, 403s, CONNECT tunnels, private addresses, globs and ports, log lines), and `EGRESS_PROXY_SOURCE` as a
`node -e` child process.

## Replacing it

Write another `ContainerRuntime` adapter (Podman, Kubernetes, ...) and switch the composition root.
