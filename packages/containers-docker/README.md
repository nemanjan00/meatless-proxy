# @mp/containers-docker

Docker adapter (L2) for `@mp/containers`, using dockerode.

## API

`dockerRuntime({ docker?, socketPath?, logger?, clock?, namePrefix = 'mp-', labels?, capDrop?, pidsLimit?, maxOutputBytes?, proxyImage?, selfContainer? })`
returns a `ContainerRuntime`. Also exported: `mapError`, `demuxBuffer`, `NotImplementedError`, the `mp.*` label names and the
`DockerLike` interface (the slice of dockerode used), `parseEgressLog`, and the egress proxy: `createEgressProxy`,
`EGRESS_PROXY_SOURCE`, `egressProxyDecision`, `EGRESS_PROXY_PORT` (3128), `DEFAULT_PROXY_IMAGE` (`node:26-alpine`),
`PROXY_URL`, and the preview forwarder: `createPreviewForwarder`, `PREVIEW_FORWARDER_SOURCE`, `PREVIEW_READY_MARKER`,
`LABEL_EXPOSE`, `PREVIEW_SUFFIX`.

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
- with `expose`: the main container is labelled `mp.expose=5173,8000` (nothing is published on the host), and a
  **preview forwarder** sidecar `<prefix><name>-preview` (`proxyImage`, `node -e PREVIEW_FORWARDER_SOURCE`, uid 65534,
  read-only root, 128 MiB) runs on the env network and on a network of its own, `<prefix><name>-preview` (internal). It
  forwards TCP on each exposed port to the same port of `main`, and nowhere else. `previewTarget(envId, port)` returns
  the forwarder's address on the preview network. With `selfContainer` (the harness's own container, when it runs in
  Docker) that container is first connected to the preview network (once; already connected is fine) and disconnected
  on destroy. No service may be called `preview` then.
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

## Why a forwarder sidecar for previews

The harness has to reach a port inside an environment whose network is internal. Connecting the harness container to
the environment's network would do it, but would also put the harness (and whatever it listens on) in reach of the
project's containers, which must never reach the harness's API, Postgres or Redis. Instead the only container on both
sides is the forwarder: the harness shares a network with nothing but the forwarder, the project shares one with
nothing of the harness, and the forwarder only ever connects to `main` on an exposed port. A project container that
connects to the forwarder only gets back to itself. When the harness runs on the host, the host reaches the forwarder's
bridge address directly and nothing is connected.

## Tests

`test/docker.test.ts` runs against `test/mock-docker.ts`, a hand-written in-memory Docker (it uses the real modem's
demuxing and progress parsing, but never connects to a daemon). No real Docker is used. `test/egress-docker.test.ts`
checks the egress networks, the sidecar, aliases, proxy variables, cleanup and `egressLog` against the mock.
`test/egress-proxy.test.ts` runs `createEgressProxy` in-process against a local HTTP upstream and a local TCP echo target
(forwarding, 403s, CONNECT tunnels, private addresses, globs and ports, log lines), and `EGRESS_PROXY_SOURCE` as a
`node -e` child process. `test/preview-docker.test.ts` checks the forwarder, its networks, `previewTarget`,
`selfContainer` connects and disconnects and cleanup against the mock, and runs `createPreviewForwarder` and
`PREVIEW_FORWARDER_SOURCE` against real local servers. `test/real-docker.test.ts` (`MP_DOCKER_TEST=1`) also serves
`python3 -m http.server` through the forwarder, once reached from the host and once from a stand-in harness container
that the project container can't reach on any of its addresses.

## Replacing it

Write another `ContainerRuntime` adapter (Podman, Kubernetes, ...) and switch the composition root.
