# @mp/containers-docker

Docker adapter (L2) for `@mp/containers`, using dockerode.

## API

`dockerRuntime({ docker?, socketPath?, logger?, clock?, namePrefix = 'mp-', labels?, capDrop?, pidsLimit?, maxOutputBytes?, proxyImage?, selfContainer?, desktopImage? })`
returns a `ContainerRuntime`. Also exported: `mapError`, `demuxBuffer`, `NotImplementedError`, the `mp.*` label names
(`LABEL_DEPLOYMENT`, ...), `DEFAULT_NAME_PREFIX`, `DIRECT_ROLE`, `ICC_OPTION`, and the
`DockerLike` interface (the slice of dockerode used), `parseEgressLog`, and the egress proxy: `createEgressProxy`,
`EGRESS_PROXY_SOURCE`, `egressProxyDecision`, `EGRESS_PROXY_PORT` (3128), `DEFAULT_PROXY_IMAGE` (`node:26-alpine`),
`PROXY_URL`, and the preview forwarder: `createPreviewForwarder`, `PREVIEW_FORWARDER_SOURCE`, `PREVIEW_READY_MARKER`,
`LABEL_EXPOSE`, `PREVIEW_SUFFIX`, and desktops: `DEFAULT_DESKTOP_IMAGE`, `DESKTOP_SUFFIX`, `LABEL_DESKTOP`,
`DESKTOP_READY_MARKER`.

**Deployments.** `namePrefix` (the server's `DOCKER_NAME_PREFIX`) starts every container, network and build image name,
and every container, network and volume carries `mp.deployment=<prefix>` (with `labels` and `mp.managed=true`).
`listEnvs`, `getEnv` and `destroyEnv` only see and remove resources with this runtime's label: before removing a
container or network by name it inspects it and leaves it alone when it belongs to another deployment, so a deployment
with prefix `mp-` never touches `mp-e2e-…` even though the names look alike. Unlabelled resources from before the label
count as the default `mp-` deployment's. `createEnv` on a name another deployment holds is a `ConflictError` that says
to give each deployment its own prefix.

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
- with `direct: { network }`: the shared network `<prefix><network>`, a plain bridge (`Internal: false`, the host's NAT
  is its route out) with `com.docker.network.bridge.enable_icc=false`, labelled `mp.role=direct`, `mp.managed=true` and
  the deployment. It is made on first use (another environment making it at the same moment is fine) and kept for the
  next one: destroying an environment leaves it. The main container and the services are connected to it before they
  start; they keep the environment's own internal network for each other. No proxy, no proxy variables, nothing
  published. A network of that name that isn't this deployment's direct network, or has lost `Internal: false` or
  the ICC setting, is refused with a `ConflictError` (so it can never join, say, the harness's compose network).
  Excludes `egress` and `allowInternet`. What it can still reach (the host's LAN, published ports, cloud metadata) and
  that it isn't logged is up to the caller to say: see the spec's direct network section.
- main container `<prefix><name>` (this is the env id): binds, env, workdir, `NanoCpus`/`Memory` limits, labels
  `mp.env=<name>`, `mp.managed=true`, `mp.role=main`, `mp.deployment=<prefix>`, command default `sleep infinity`. Never privileged, never host
  network, `no-new-privileges`, a few capabilities dropped (`DEFAULT_CAP_DROP`), pids limit, runs as the image's user.
- sandbox hardening: `user` -> `User`, `readOnlyRootfs` -> `ReadonlyRootfs`, `volumes` -> anonymous volumes (`Mounts`
  of type `volume` without a source, labelled like the container, removed with it), `tmpfs` -> `Tmpfs`
  (`rw,nosuid,nodev,size=<n>m`), `limits.pids` -> `PidsLimit`, `volumeMounts` -> `Mounts` of type `volume` with
  `VolumeOptions.Subpath` (and `NoCopy`). Only volumes named `<prefix>*` or `mp-*` (the compose-declared `mp-files`) may be mounted,
  and subpaths need Docker API `VOLUME_SUBPATH_API` (1.45, Engine 26) or later; `features()` reads `docker.version()`
  once (`apiAtLeast`).
- spawn: `sh -c 'echo <marker><pid> >&2; exec "$@"'` with stdin attached (`hijack`), so the process reports its pid on
  stderr (hidden from the output) and then becomes the command. `kill` runs `kill -KILL -- -<pid>` (its process group,
  when it leads one) and `kill -KILL <pid>`, then drops the stream. Needs `sh` in the image.
- copyIn/copyOut: `putArchive`/`getArchive` with a small tar writer and reader (`src/tar.ts`: ustar, pax long names).
  This works for anonymous and named volumes with a read-only root; not for tmpfs mounts (Docker's archive API doesn't
  see them).
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
- with `desktop`: the main container gets `DISPLAY=:99` and the label `mp.desktop=true`, and a **desktop sidecar**
  `<prefix><name>-desktop` (`desktopImage`, default `ghcr.io/nemanjan00/meatless-proxy-desktop:latest`, built from
  `docker/desktop`) runs in the main container's network namespace (`NetworkMode: container:<main>`), as uid 1000,
  read-only root with a `/tmp` tmpfs, 768 MiB: Xvfb `:99`, x11vnc on 127.0.0.1:5900 and 5901 (`-viewonly`), and
  websockify on 6080 and 6081. Programs in the main container reach the display through its abstract X socket (shared
  with the network namespace), so any image works. The forwarder carries 6080 and 6081 like exposed ports.
  `screenshot` runs `mp-desktop-shot` (scrot, base64) in the sidecar. No service may be called `desktop` then.
- metrics: `stats` takes one sample per working container (`container.stats({ stream: false, 'one-shot': true })`)
  and works out CPU from the previous sample it saw (Docker's own `precpu_stats` when it has them); memory leaves out
  the page cache, like `docker stats`. `processes` asks `container.top` (the host's `ps -eo pid,user,pcpu,pmem,etime,args`),
  busiest first, at most 25 per container.
- images: `getEnv` and `listEnvs` report the main container's image (`Config.Image`, or the summary's `Image`) and its ID;
  `getEnv` also the start time and limits (`NanoCpus`, `Memory`, `PidsLimit`). A main container built from a Dockerfile is
  labelled `mp.build=dockerfile` and `mp.build.base=<the Dockerfile's last FROM>` (read from the context, following stage
  names: `baseImageOf`); older ones are told by their `<prefix>build/` image name. `inspectImage` is Docker's image
  inspect (`Id`, `RepoDigests`, `RepoTags`, `Size`, `Created`, `Os`, `Architecture`/`Variant`, `Config.Labels`), null on 404.
- destroy: removes every container labelled `mp.env=<name>` (the desktop first) and this deployment (with anonymous volumes), the proxy, and
  the environment's networks (not a shared direct network). Idempotent, and also cleans up half-created environments. A
  failed `createEnv` cleans up after itself.

Errors: 404 -> `NotFoundError` (`getEnv` returns null), 409 -> `ConflictError`, 400 -> `ValidationError`, 5xx and
connection errors (`ECONNREFUSED`, `ECONNRESET`, ...: the daemon restarting) -> `UnavailableError`, which is retried. A
socket the app may not use (`EACCES`, `EPERM`) is a `DeniedError` and a missing socket (`ENOENT`) a `ValidationError`,
both saying what to fix (the socket's group, `DOCKER_GID`, `DOCKER_SOCKET`): retrying wouldn't help, so the model gets a
tool error it can report.

## The egress proxy

`src/egress-proxy-core.cjs` is a small forward proxy in plain CommonJS with node built-ins only: plain HTTP forwarding
(absolute-URI requests, hop-by-hop and `Proxy-*` headers dropped) and `CONNECT` tunnels. Anything not on the allowlist gets
403, with a body naming the host, why (not on the allowlist; an IP or private address that needs an exact entry) and to
ask an admin to add it to the project's or the employee's network allowlist. IP literals, `localhost` and hosts that resolve to private, loopback or link-local addresses are refused unless listed
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
`PREVIEW_FORWARDER_SOURCE` against real local servers. `test/interactive-docker.test.ts` checks the sandbox hardening, volume mounts, features, archives, tar and spawn
against the mock. `test/direct-docker.test.ts` checks the direct network (options, labels, connects before start, reuse,
the creation race, refusing foreign or weakened networks) and `test/deployment-docker.test.ts` two deployments on one
mock daemon (labels on everything, listing, lookups and cleanup that leave the other alone, unlabelled legacy resources).
`test/real-docker.test.ts` (`MP_DOCKER_TEST=1`) runs `runtimeContract` (spawn, copies, kill) and also serves
`python3 -m http.server` through the forwarder, once reached from the host and once from a stand-in harness container
that the project container can't reach on any of its addresses. It also checks a direct network for real: a raw TCP
connect to 1.1.1.1:53 and DNS work (the default and the proxy modes can't), a stand-in harness network's `postgres` is
neither resolvable nor reachable, and a second environment on the same direct network is unreachable while its own
services still are.

## Replacing it

Write another `ContainerRuntime` adapter (Podman, Kubernetes, ...) and switch the composition root.

`test/desktop-docker.test.ts` covers desktops, metrics and processes on the mock; `test/desktop-real-docker.test.ts`
(opt-in, `MP_DOCKER_TEST=1`) builds `docker/desktop` and checks, against a real daemon, that the display works from
the main container, that the VNC servers listen on localhost only, that both bridges answer with the VNC greeting
through the forwarder, that a screenshot is a PNG of the screen's size, metrics, and that nothing is left behind.
