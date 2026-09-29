import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import {
  DEFAULT_DESKTOP_SIZE,
  DESKTOP_DISPLAY,
  DESKTOP_PORTS,
  ExecAbortedError,
  TIMEOUT_EXIT_CODE,
  invalidDesktop,
  invalidEgressEntries,
  invalidEntryPath,
  invalidExpose,
  invalidNetworkSpec,
  invalidVolumeMounts,
  type ContainerProcesses,
  type ContainerRuntime,
  type ContainerStats,
  type EgressLogEntry,
  type EnvInfo,
  type EnvSpec,
  type EnvStats,
  type ExecOptions,
  type ExecResult,
  type FileEntry,
  type PreviewTarget,
  type Process,
  type RuntimeFeatures,
} from '@mp/containers'
import {
  ConflictError,
  DeniedError,
  MpError,
  NotFoundError,
  UnavailableError,
  ValidationError,
  errorMessage,
  silentLogger,
  systemClock,
  type Clock,
  type Logger,
} from '@mp/core'
import Docker from 'dockerode'
import type {
  ContainerInspectLike,
  ContainerStatsLike,
  ContainerSummaryLike,
  DockerLike,
  NetworkInspectLike,
} from './docker-like.ts'
import { EGRESS_PROXY_PORT, EGRESS_PROXY_SOURCE } from './egress-proxy.ts'
import { PREVIEW_FORWARDER_SOURCE, PREVIEW_READY_MARKER } from './preview-forwarder.ts'
import { packTar, unpackTar } from './tar.ts'

export interface DockerRuntimeOptions {
  /** A dockerode instance (or anything shaped like one). Default: `new Docker({ socketPath })`. */
  docker?: DockerLike
  /** Docker socket, used when `docker` isn't given. Default: dockerode's default (`/var/run/docker.sock`). */
  socketPath?: string
  logger?: Logger
  clock?: Clock
  /**
   * Prefix for container, network and image names, and this deployment's `mp.deployment` label: two
   * deployments on one Docker host need different prefixes. Default `mp-`.
   */
  namePrefix?: string
  /** Labels added to every container, network and volume this runtime creates. */
  labels?: Record<string, string>
  /** Capabilities dropped from every container. Default: a set a normal build or test run doesn't need. */
  capDrop?: string[]
  /** Max processes per container. Default 4096. */
  pidsLimit?: number
  /** Output kept per stream and exec; the rest is dropped with a marker. Default 10 MiB. */
  maxOutputBytes?: number
  /** Image for the egress proxy and preview forwarder sidecars: anything with `node` on the PATH. Default `DEFAULT_PROXY_IMAGE`. */
  proxyImage?: string
  /**
   * The container the harness itself runs in, when it runs in Docker (id or name). `previewTarget`
   * connects it to an environment's preview network, which holds only the preview forwarder, so the
   * harness can reach exposed ports. Unset when the harness runs on the host: the host reaches the
   * forwarder's address on the bridge directly.
   */
  selfContainer?: string
  /** Image of the desktop sidecar (`EnvSpec.desktop`): docker/desktop in this repository. Default `DEFAULT_DESKTOP_IMAGE`. */
  desktopImage?: string
}

export const DEFAULT_PROXY_IMAGE = 'node:26-alpine'
export const DEFAULT_DESKTOP_IMAGE = 'ghcr.io/nemanjan00/meatless-proxy-desktop:latest'
/** The desktop sidecar's name suffix and `mp.role`. */
export const DESKTOP_SUFFIX = 'desktop'
/** On the main container: `true` when the environment has a desktop. */
export const LABEL_DESKTOP = 'mp.desktop'
/** What the desktop sidecar writes (to stderr) once its display, VNC servers and bridges are up. */
export const DESKTOP_READY_MARKER = 'mp desktop ready'
/** The desktop sidecar's user: not root, like the image's own. */
const DESKTOP_USER = '1000:1000'
/** The proxy's network alias on the environment's network, and its URL there. */
export const PROXY_ALIAS = 'proxy'
/** What the proxy writes (to stderr) once it's listening. */
export const PROXY_READY_MARKER = 'egress proxy listening on'
const PROXY_READY_TIMEOUT_MS = 20_000
const PROXY_READY_POLL_MS = 100
export const PROXY_URL = `http://${PROXY_ALIAS}:${EGRESS_PROXY_PORT}`

export const DEFAULT_CAP_DROP = ['NET_RAW', 'MKNOD', 'AUDIT_WRITE', 'SYS_CHROOT', 'SETFCAP']

export const DEFAULT_NAME_PREFIX = 'mp-'
/**
 * On every container, network and volume: the name prefix of the deployment that made it. A runtime
 * only lists and removes its own (with the default prefix, also the unlabelled ones made before the
 * label existed), so deployments sharing a Docker host never touch each other's resources.
 */
export const LABEL_DEPLOYMENT = 'mp.deployment'
export const LABEL_ENV = 'mp.env'
export const LABEL_MANAGED = 'mp.managed'
export const LABEL_ROLE = 'mp.role'
export const LABEL_SERVICE = 'mp.service'
/** On the main container: the exposed ports, comma-separated. */
export const LABEL_EXPOSE = 'mp.expose'
/** The preview forwarder's name suffix (container and network), and the service name it takes. */
export const PREVIEW_SUFFIX = 'preview'
/** `mp.role` of a shared direct network (`EnvSpec.direct`). */
export const DIRECT_ROLE = 'direct'
/** The bridge driver option that turns traffic between containers on one network off. */
export const ICC_OPTION = 'com.docker.network.bridge.enable_icc'

/** The requested feature isn't implemented by this adapter. */
export class NotImplementedError extends MpError {
  constructor(message: string) {
    super('not_implemented', message)
  }
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(:[A-Za-z0-9_][A-Za-z0-9_.-]*)?$/
/** The first Docker API version with volume subpaths (Engine 26). */
export const VOLUME_SUBPATH_API = '1.45'
/** How long `kill` waits for a spawned process to report its pid and to end. */
const KILL_WAIT_MS = 5000
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * `ContainerRuntime` on Docker. Each environment is a main container plus service
 * containers on a private network of its own (internal, so no route out, unless
 * `allowInternet`). With `egress` a proxy sidecar is the only way out; with `direct` the
 * containers also join a shared bridge network with inter-container traffic off, whose
 * route out is the host's NAT. The environment id is the main container's name, `<prefix><name>`.
 */
export function dockerRuntime(opts: DockerRuntimeOptions = {}): ContainerRuntime {
  const docker: DockerLike =
    opts.docker ?? (new Docker(opts.socketPath ? { socketPath: opts.socketPath } : undefined) as DockerLike)
  const log = opts.logger ?? silentLogger
  const clock = opts.clock ?? systemClock
  const prefix = opts.namePrefix ?? DEFAULT_NAME_PREFIX
  const baseLabels = { ...opts.labels, [LABEL_DEPLOYMENT]: prefix }
  /** Whether a resource is this deployment's, by its labels. */
  const owns = (labels: Record<string, string> | null | undefined) =>
    labels?.[LABEL_MANAGED] === 'true' &&
    (labels[LABEL_DEPLOYMENT] === prefix || (labels[LABEL_DEPLOYMENT] === undefined && prefix === DEFAULT_NAME_PREFIX))
  const capDrop = opts.capDrop ?? DEFAULT_CAP_DROP
  const pidsLimit = opts.pidsLimit ?? 4096
  const maxOutput = opts.maxOutputBytes ?? 10 * 1024 * 1024
  const proxyImage = opts.proxyImage ?? DEFAULT_PROXY_IMAGE
  const desktopImage = opts.desktopImage ?? DEFAULT_DESKTOP_IMAGE
  /** The previous CPU sample of each container, for `stats` (Docker's one-shot samples have no previous one). */
  const cpuSamples = new Map<string, { total: number; system: number }>()
  const self = opts.selfContainer
  /**
   * The harness container's own mounts, read once: a path in it (a worktree under DATA_DIR) is not
   * a host path, so a bind mount of it would give an empty directory. Null when the harness runs on
   * the host, or its container can't be inspected (paths are then used as they are).
   */
  let ownMounts: Promise<{ Type?: string; Name?: string; Source?: string; Destination?: string }[] | null> | null = null
  const selfMounts = () =>
    (ownMounts ??= (async () => {
      if (!self) return null
      try {
        const info = (await docker.getContainer(self).inspect()) as unknown as {
          Mounts?: { Type?: string; Name?: string; Source?: string; Destination?: string }[]
        }
        return info.Mounts ?? []
      } catch (err) {
        log.warn('could not inspect the harness container: mounts are used as host paths', {
          container: self,
          err: errorMessage(err),
        })
        return null
      }
    })())
  /** A mount of a path as the harness sees it, as Docker sees it: the host path, or the volume and subpath behind it. */
  const hostMount = async (m: { hostPath: string; containerPath: string; readOnly?: boolean }) => {
    const bindOf = (path: string) => ({ bind: `${path}:${m.containerPath}${m.readOnly ? ':ro' : ''}` })
    const own = await selfMounts()
    const hit = (own ?? [])
      .filter(
        (x) => x.Destination && (m.hostPath === x.Destination || m.hostPath.startsWith(`${x.Destination.replace(/\/$/, '')}/`)),
      )
      .sort((a, b) => b.Destination!.length - a.Destination!.length)[0]
    if (!hit) return bindOf(m.hostPath)
    const rest = m.hostPath.slice(hit.Destination!.length).replace(/^\/+/, '')
    if (hit.Type === 'bind' && hit.Source) return bindOf(rest ? `${hit.Source.replace(/\/$/, '')}/${rest}` : hit.Source)
    if (hit.Type === 'volume' && hit.Name) {
      if (rest && !(await runtime.features!()).volumeSubpath)
        throw new ValidationError(
          `mounting ${m.hostPath} needs a volume subpath: Docker Engine 26 (API ${VOLUME_SUBPATH_API}) or later`,
        )
      return {
        volume: {
          Type: 'volume',
          Source: hit.Name,
          Target: m.containerPath,
          ReadOnly: m.readOnly === true,
          VolumeOptions: { NoCopy: true, ...(rest ? { Subpath: rest } : {}) },
        },
      }
    }
    return bindOf(m.hostPath)
  }
  /** Preview networks the harness container is already connected to. */
  const attached = new Set<string>()
  let features: Promise<RuntimeFeatures> | null = null

  const envName = (id: string) => (id.startsWith(prefix) ? id.slice(prefix.length) : id)
  const mainName = (name: string) => `${prefix}${name}`
  const serviceName = (name: string, svc: string) => `${prefix}${name}-${svc}`
  const networkName = (name: string) => `${prefix}${name}`
  const egressNetworkName = (name: string) => `${prefix}${name}-egress`
  const proxyName = (name: string) => `${prefix}${name}-proxy`
  const previewName = (name: string) => `${prefix}${name}-${PREVIEW_SUFFIX}`
  const previewNetworkName = (name: string) => `${prefix}${name}-${PREVIEW_SUFFIX}`
  const directNetworkName = (network: string) => `${prefix}${network}`
  const desktopName = (name: string) => `${prefix}${name}-${DESKTOP_SUFFIX}`
  /** The ports the preview forwarder carries: the exposed ones, and the desktop's. */
  const forwardedPorts = (spec: EnvSpec) => [...(spec.expose ?? []), ...(spec.desktop ? Object.values(DESKTOP_PORTS) : [])]

  const hardening = {
    Privileged: false,
    CapDrop: capDrop,
    SecurityOpt: ['no-new-privileges:true'],
    PidsLimit: pidsLimit,
    Init: true,
  }

  async function ensureImage(spec: EnvSpec): Promise<string> {
    if (spec.image) {
      try {
        await docker.getImage(spec.image).inspect()
        return spec.image
      } catch (e) {
        if (statusOf(e) !== 404) throw mapError(e, `image ${spec.image}`)
      }
      log.info('pulling image', { image: spec.image })
      const stream = await docker.pull(spec.image).catch((e) => {
        throw mapError(e, `image ${spec.image}`)
      })
      await follow(docker, stream, `pull ${spec.image}`)
      return spec.image
    }
    const build = spec.build!
    if (build.context.includes('://') || !isAbsolute(build.context)) {
      throw new NotImplementedError('only builds from an absolute local context directory are supported')
    }
    const tag = `${prefix}build/${spec.name}:latest`.toLowerCase()
    let src: string[]
    try {
      src = readdirSync(build.context)
    } catch (e) {
      throw new ValidationError(`build context ${build.context} is not readable: ${errorMessage(e)}`)
    }
    log.info('building image', { tag, context: build.context })
    const stream = await docker
      .buildImage(
        { context: build.context, src },
        { t: tag, ...(build.dockerfile ? { dockerfile: build.dockerfile } : {}), rm: true },
      )
      .catch((e) => {
        throw mapError(e, `build ${tag}`)
      })
    await follow(docker, stream, `build ${tag}`)
    return tag
  }

  async function pullIfMissing(image: string): Promise<void> {
    try {
      await docker.getImage(image).inspect()
    } catch (e) {
      if (statusOf(e) !== 404) throw mapError(e, `image ${image}`)
      await follow(docker, await docker.pull(image), `pull ${image}`)
    }
  }

  /** The proxy settings every container of an environment with `egress` gets. */
  function proxyEnv(spec: EnvSpec): Record<string, string> {
    if (!spec.egress) return {}
    const noProxy = ['localhost', '127.0.0.1', ...(spec.services ?? []).map((s) => s.name)].join(',')
    return {
      HTTP_PROXY: PROXY_URL,
      HTTPS_PROXY: PROXY_URL,
      http_proxy: PROXY_URL,
      https_proxy: PROXY_URL,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    }
  }

  /**
   * The egress proxy: on the environment's internal network (alias `proxy`) and on a second,
   * non-internal network of its own, the only way out.
   */
  async function createProxy(spec: EnvSpec, net: string, labels: Record<string, string>): Promise<void> {
    const egressNet = egressNetworkName(spec.name)
    await docker.createNetwork({
      Name: egressNet,
      Driver: 'bridge',
      Internal: false,
      CheckDuplicate: true,
      Labels: { ...labels, [LABEL_ROLE]: 'egress' },
    })
    const name = proxyName(spec.name)
    const c = await docker.createContainer({
      name,
      Image: proxyImage,
      Cmd: ['node', '-e', EGRESS_PROXY_SOURCE],
      Env: envList({ ALLOW: JSON.stringify(spec.egress!.allow), PORT: String(EGRESS_PROXY_PORT) }),
      User: '65534:65534',
      Labels: { ...labels, [LABEL_ROLE]: 'proxy' },
      HostConfig: {
        ...hardening,
        NetworkMode: net,
        ReadonlyRootfs: true,
        Memory: 256 * 1024 * 1024,
        MemorySwap: 256 * 1024 * 1024,
      },
      NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: [PROXY_ALIAS] } } },
    })
    await docker.getNetwork(egressNet).connect({ Container: name })
    await c.start()
    await waitForProxy(name)
  }

  /**
   * Waits until the proxy logs that it's listening, so the environment's first request
   * doesn't race the proxy's start-up. Fails if the proxy exits or doesn't come up in time.
   */
  async function waitForProxy(name: string, marker = PROXY_READY_MARKER, what = 'egress proxy'): Promise<void> {
    const deadline = clock.now() + PROXY_READY_TIMEOUT_MS
    for (;;) {
      const container = docker.getContainer(name)
      const res = await container.logs({ stdout: true, stderr: true, follow: false })
      const text = demuxBuffer(Buffer.isBuffer(res) ? res : await readAll(res))
      if (text.includes(marker)) return
      const state = (await container.inspect()).State
      if (state && state.Running === false) throw new UnavailableError(`${what} ${name} exited: ${text.slice(-500)}`)
      if (clock.now() > deadline) throw new UnavailableError(`${what} ${name} didn't start listening in time`)
      await new Promise((r) => setTimeout(r, PROXY_READY_POLL_MS))
    }
  }

  /**
   * The live preview forwarder: on the environment's network, where it reaches the main container
   * as `main`, and on a preview network of its own (internal, nothing else on it but the harness
   * container when there is one). It forwards each exposed port to the same port of `main`, and
   * nothing else, so a project container that reaches it only gets back to itself.
   */
  async function createForwarder(spec: EnvSpec, net: string, labels: Record<string, string>): Promise<void> {
    const previewNet = previewNetworkName(spec.name)
    await docker.createNetwork({
      Name: previewNet,
      Driver: 'bridge',
      Internal: true,
      CheckDuplicate: true,
      Labels: { ...labels, [LABEL_ROLE]: PREVIEW_SUFFIX },
    })
    const name = previewName(spec.name)
    const c = await docker.createContainer({
      name,
      Image: proxyImage,
      Cmd: ['node', '-e', PREVIEW_FORWARDER_SOURCE],
      Env: envList({
        TARGET: 'main',
        FORWARDS: JSON.stringify(forwardedPorts(spec).map((port) => ({ listen: port, port }))),
      }),
      User: '65534:65534',
      Labels: { ...labels, [LABEL_ROLE]: PREVIEW_SUFFIX },
      HostConfig: {
        ...hardening,
        NetworkMode: net,
        ReadonlyRootfs: true,
        Memory: 128 * 1024 * 1024,
        MemorySwap: 128 * 1024 * 1024,
      },
    })
    await docker.getNetwork(previewNet).connect({ Container: name })
    await c.start()
    await waitForProxy(name, PREVIEW_READY_MARKER, 'preview forwarder')
  }

  /**
   * The desktop sidecar: Xvfb, x11vnc (localhost only) and websockify, in the main container's network
   * namespace. Programs in the main container reach the display through its abstract X socket (shared
   * with the namespace), and the preview forwarder reaches the bridges at `main`.
   */
  async function createDesktop(spec: EnvSpec, labels: Record<string, string>): Promise<void> {
    const name = desktopName(spec.name)
    const size = `${spec.desktop!.width ?? DEFAULT_DESKTOP_SIZE.width}x${spec.desktop!.height ?? DEFAULT_DESKTOP_SIZE.height}`
    const c = await docker.createContainer({
      name,
      Image: desktopImage,
      Env: envList({ DISPLAY: DESKTOP_DISPLAY, DESKTOP_SIZE: size }),
      User: DESKTOP_USER,
      Labels: { ...labels, [LABEL_ROLE]: DESKTOP_SUFFIX },
      HostConfig: {
        ...hardening,
        NetworkMode: `container:${mainName(spec.name)}`,
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m,mode=1777' },
        Memory: 768 * 1024 * 1024,
        MemorySwap: 768 * 1024 * 1024,
      },
    })
    await c.start()
    await waitForProxy(name, DESKTOP_READY_MARKER, 'desktop')
  }

  /** Refuses a network that isn't a direct network this runtime made, or has lost its settings. */
  function checkDirect(n: NetworkInspectLike): void {
    if (!owns(n.Labels) || n.Labels?.[LABEL_ROLE] !== DIRECT_ROLE)
      throw new ConflictError(`network ${n.Name} exists and is not a direct network made by this deployment`)
    if (n.Internal || n.Options?.[ICC_OPTION] !== 'false')
      throw new ConflictError(
        `direct network ${n.Name} lets containers reach each other or has no route out: remove it and it is made again`,
      )
  }

  /**
   * The shared direct network: a plain bridge (the host's NAT is the way out) with inter-container
   * traffic off, so environments on it can't reach each other. Made on first use and kept.
   */
  async function ensureDirectNetwork(net: string): Promise<void> {
    try {
      checkDirect(await docker.getNetwork(net).inspect())
      return
    } catch (e) {
      if (e instanceof MpError || statusOf(e) !== 404) throw mapError(e, `network ${net}`)
    }
    try {
      await docker.createNetwork({
        Name: net,
        Driver: 'bridge',
        Internal: false,
        CheckDuplicate: true,
        Options: { [ICC_OPTION]: 'false' },
        Labels: { ...baseLabels, [LABEL_MANAGED]: 'true', [LABEL_ROLE]: DIRECT_ROLE },
      })
      log.info('direct network created', { network: net })
    } catch (e) {
      // Another environment made it at the same time.
      if (statusOf(e) !== 409) throw mapError(e, `network ${net}`)
      checkDirect(await docker.getNetwork(net).inspect())
    }
  }

  /** Connects the harness container to a preview network, once. Already being connected is fine. */
  async function attachSelf(previewNet: string): Promise<void> {
    if (!self || attached.has(previewNet)) return
    try {
      await docker.getNetwork(previewNet).connect({ Container: self })
    } catch (e) {
      const status = statusOf(e)
      if (!(status === 403 || status === 409 || /already (exists|attached|connected)/i.test(errorMessage(e))))
        throw mapError(e, `preview network ${previewNet}`)
    }
    attached.add(previewNet)
  }

  async function create(spec: EnvSpec, labels: Record<string, string>): Promise<void> {
    const image = await ensureImage(spec)
    for (const svc of spec.services ?? []) await pullIfMissing(svc.image)
    if (spec.egress || spec.expose?.length || spec.desktop) await pullIfMissing(proxyImage)
    if (spec.desktop) await pullIfMissing(desktopImage)
    const net = networkName(spec.name)
    await docker.createNetwork({
      Name: net,
      Driver: 'bridge',
      Internal: !spec.allowInternet,
      CheckDuplicate: true,
      Labels: labels,
    })
    if (spec.egress) await createProxy(spec, net, labels)
    const direct = spec.direct ? directNetworkName(spec.direct.network) : null
    if (direct) await ensureDirectNetwork(direct)
    const viaProxy = proxyEnv(spec)
    for (const svc of spec.services ?? []) {
      const c = await docker.createContainer({
        name: serviceName(spec.name, svc.name),
        Image: svc.image,
        Env: envList({ ...svc.env, ...viaProxy }),
        Labels: { ...labels, [LABEL_ROLE]: 'service', [LABEL_SERVICE]: svc.name },
        HostConfig: { ...hardening, NetworkMode: net, ...limits(spec) },
        NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: [svc.name] } } },
      })
      if (direct) await docker.getNetwork(direct).connect({ Container: serviceName(spec.name, svc.name) })
      await c.start()
    }
    const translated = await Promise.all((spec.mounts ?? []).map(hostMount))
    const binds = translated.flatMap((t) => ('bind' in t ? [t.bind] : []))
    const ownVolumes = translated.flatMap((t) => ('volume' in t ? [t.volume] : []))
    const main = await docker.createContainer({
      name: mainName(spec.name),
      Image: image,
      // Without a command it's kept running for exec, whatever the image's own entrypoint is
      // (e.g. alpine/git's `git`, which would turn the keep-alive into `git sleep infinity` and exit).
      ...(spec.command ? { Cmd: spec.command } : { Entrypoint: ['sleep'], Cmd: ['infinity'] }),
      ...(spec.workdir ? { WorkingDir: spec.workdir } : {}),
      ...(spec.user ? { User: spec.user } : {}),
      Env: envList({ ...(spec.desktop ? { DISPLAY: DESKTOP_DISPLAY } : {}), ...spec.env, ...viaProxy }),
      Labels: {
        ...labels,
        [LABEL_ROLE]: 'main',
        ...(forwardedPorts(spec).length ? { [LABEL_EXPOSE]: forwardedPorts(spec).join(',') } : {}),
        ...(spec.desktop ? { [LABEL_DESKTOP]: 'true' } : {}),
      },
      HostConfig: {
        ...hardening,
        NetworkMode: net,
        Binds: binds,
        ...(spec.volumes?.length || spec.volumeMounts?.length || ownVolumes.length
          ? {
              Mounts: [
                // Paths inside the harness container's own volumes (its worktrees), at their subpath.
                ...ownVolumes,
                // Fresh anonymous volumes, labelled, removed with the container.
                ...(spec.volumes ?? []).map((v) => ({ Type: 'volume', Target: v, VolumeOptions: { Labels: labels } })),
                ...(spec.volumeMounts ?? []).map((m) => ({
                  Type: 'volume',
                  Source: m.volume,
                  Target: m.containerPath,
                  ReadOnly: m.readOnly === true,
                  VolumeOptions: { NoCopy: true, ...(m.subpath ? { Subpath: m.subpath } : {}) },
                })),
              ],
            }
          : {}),
        ...(spec.readOnlyRootfs ? { ReadonlyRootfs: true } : {}),
        ...(spec.tmpfs
          ? {
              Tmpfs: Object.fromEntries(
                Object.entries(spec.tmpfs).map(([p, t]) => [p, `rw,nosuid,nodev,size=${Math.round(t.sizeMb ?? 64)}m`]),
              ),
            }
          : {}),
        ...limits(spec),
        ...(spec.limits?.pids ? { PidsLimit: spec.limits.pids } : {}),
      },
      NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: ['main'] } } },
    })
    if (direct) await docker.getNetwork(direct).connect({ Container: mainName(spec.name) })
    await main.start()
    if (spec.desktop) await createDesktop(spec, labels)
    if (forwardedPorts(spec).length) await createForwarder(spec, net, labels)
  }

  async function removeAll(name: string): Promise<void> {
    let containers: ContainerSummaryLike[]
    try {
      containers = await docker.listContainers({
        all: true,
        filters: { label: [`${LABEL_MANAGED}=true`, `${LABEL_ENV}=${name}`] },
      })
    } catch (e) {
      throw mapError(e, `environment ${name}`)
    }
    // The desktop first: it lives in the main container's network namespace.
    const ids = new Set(
      containers
        .filter((c) => owns(c.Labels))
        .sort((a, b) => Number(b.Labels[LABEL_ROLE] === DESKTOP_SUFFIX) - Number(a.Labels[LABEL_ROLE] === DESKTOP_SUFFIX))
        .map((c) => c.Id),
    )
    // The main container and the sidecars are also removed by name, in case a listing missed them, but
    // only when they are this deployment's.
    for (const n of [desktopName(name), mainName(name), proxyName(name), previewName(name)]) {
      try {
        if (owns((await docker.getContainer(n).inspect()).Config.Labels)) ids.add(n)
      } catch (e) {
        if (statusOf(e) !== 404) throw mapError(e, `container ${n}`)
      }
    }
    for (const id of ids) {
      try {
        await docker.getContainer(id).remove({ force: true, v: true })
      } catch (e) {
        if (statusOf(e) !== 404) throw mapError(e, `container ${id}`)
      }
    }
    if (self) {
      // The harness container may be on the preview network: a network with endpoints can't be removed.
      await docker
        .getNetwork(previewNetworkName(name))
        .disconnect({ Container: self, Force: true })
        .catch(() => undefined)
      attached.delete(previewNetworkName(name))
    }
    for (const net of [networkName(name), egressNetworkName(name), previewNetworkName(name)]) {
      try {
        if (!owns((await docker.getNetwork(net).inspect()).Labels)) continue
        await docker.getNetwork(net).remove()
      } catch (e) {
        if (statusOf(e) !== 404) throw mapError(e, `network ${net}`)
      }
    }
  }

  /**
   * The containers of an environment that do its work, main first: the main container, its services
   * and the desktop (not the proxy and preview sidecars). `NotFoundError` when it's gone.
   */
  async function envContainers(envId: string): Promise<ContainerSummaryLike[]> {
    const name = envName(envId)
    let list: ContainerSummaryLike[]
    try {
      list = await docker.listContainers({ all: true, filters: { label: [`${LABEL_MANAGED}=true`, `${LABEL_ENV}=${name}`] } })
    } catch (e) {
      throw mapError(e, `environment ${envId}`)
    }
    const order = (c: ContainerSummaryLike) => ({ main: 0, service: 1, [DESKTOP_SUFFIX]: 2 })[c.Labels[LABEL_ROLE] ?? ''] ?? 9
    const mine = list.filter((c) => owns(c.Labels) && order(c) < 9).sort((a, b) => order(a) - order(b))
    if (!mine.some((c) => c.Labels[LABEL_ROLE] === 'main')) throw new NotFoundError('environment', envId)
    return mine
  }

  /** Docker's stats sample as metrics, with the CPU share since this container's previous sample. */
  function statsOf(id: string, raw: ContainerStatsLike): Omit<ContainerStats, 'name' | 'role' | 'state' | 'startedAt'> {
    const total = raw.cpu_stats?.cpu_usage?.total_usage
    const system = raw.cpu_stats?.system_cpu_usage
    const cpus = raw.cpu_stats?.online_cpus || 1
    let prev: { total: number; system: number } | undefined = cpuSamples.get(id)
    const pre = raw.precpu_stats
    if (pre?.cpu_usage?.total_usage && pre.system_cpu_usage)
      prev = { total: pre.cpu_usage.total_usage, system: pre.system_cpu_usage }
    let cpuPercent: number | null = null
    if (total !== undefined && system !== undefined) {
      if (prev && system > prev.system) cpuPercent = Math.max(0, ((total - prev.total) / (system - prev.system)) * cpus * 100)
      cpuSamples.set(id, { total, system })
    }
    const mem = raw.memory_stats
    // Page cache doesn't count, as `docker stats` shows it.
    const cache = mem?.stats?.inactive_file ?? mem?.stats?.total_inactive_file ?? mem?.stats?.cache ?? 0
    const nets = Object.values(raw.networks ?? {})
    return {
      cpuPercent: cpuPercent === null ? null : Math.round(cpuPercent * 10) / 10,
      memoryBytes: mem?.usage !== undefined ? Math.max(0, mem.usage - cache) : null,
      memoryLimitBytes: mem?.limit ?? null,
      netRxBytes: nets.length ? nets.reduce((n, x) => n + (x.rx_bytes ?? 0), 0) : null,
      netTxBytes: nets.length ? nets.reduce((n, x) => n + (x.tx_bytes ?? 0), 0) : null,
      pids: raw.pids_stats?.current ?? null,
    }
  }

  const runtime: ContainerRuntime = {
    async createEnv(spec) {
      validate(spec)
      // The harness's own volumes: this deployment's, or the family's (e.g. the compose-declared mp-files).
      const foreign = (spec.volumeMounts ?? [])
        .filter((m) => !m.volume.startsWith(prefix) && !m.volume.startsWith(DEFAULT_NAME_PREFIX))
        .map((m) => m.volume)
      if (foreign.length) throw new ValidationError(`only volumes named ${DEFAULT_NAME_PREFIX}* can be mounted`, foreign)
      if (spec.volumeMounts?.some((m) => m.subpath) && !(await runtime.features!()).volumeSubpath)
        throw new ValidationError(`volume subpaths need Docker Engine 26 (API ${VOLUME_SUBPATH_API}) or later`)
      const labels = {
        ...baseLabels,
        ...spec.labels,
        [LABEL_ENV]: spec.name,
        [LABEL_MANAGED]: 'true',
        [LABEL_DEPLOYMENT]: prefix,
      }
      const id = mainName(spec.name)
      try {
        const existing = await docker.getContainer(id).inspect()
        throw new ConflictError(
          owns(existing.Config.Labels)
            ? `environment ${spec.name} already exists`
            : `container ${id} exists and belongs to another deployment: give each deployment on this Docker host its own name prefix (DOCKER_NAME_PREFIX)`,
        )
      } catch (e) {
        if (e instanceof ConflictError) throw e
        if (statusOf(e) !== 404) throw mapError(e, `environment ${spec.name}`)
      }
      try {
        await create(spec, labels)
      } catch (e) {
        log.warn('creating environment failed, cleaning up', { env: spec.name, err: errorMessage(e) })
        await removeAll(spec.name).catch((ce) => log.error('cleanup failed', { env: spec.name, err: errorMessage(ce) }))
        throw mapError(e, `environment ${spec.name}`)
      }
      log.info('environment created', { env: spec.name })
      const info = await runtime.getEnv(id)
      if (!info) throw new UnavailableError(`environment ${spec.name} disappeared after creation`)
      return info
    },

    async getEnv(id) {
      try {
        const c = await docker.getContainer(id).inspect()
        if (!owns(c.Config.Labels) || c.Config.Labels?.[LABEL_ROLE] !== 'main') return null
        return infoFromInspect(c)
      } catch (e) {
        if (statusOf(e) === 404) return null
        throw mapError(e, `environment ${id}`)
      }
    },

    async listEnvs(labels = {}) {
      const filters = [`${LABEL_MANAGED}=true`, `${LABEL_ROLE}=main`, ...Object.entries(labels).map(([k, v]) => `${k}=${v}`)]
      try {
        const list = await docker.listContainers({ all: true, filters: { label: filters } })
        return list.filter((c) => owns(c.Labels)).map(infoFromSummary)
      } catch (e) {
        throw mapError(e, 'environments')
      }
    },

    async exec(envId, cmd, o: ExecOptions = {}) {
      if (!cmd.length) throw new ValidationError('exec needs a command')
      if (o.signal?.aborted) throw new ExecAbortedError()
      const started = clock.now()
      const container = docker.getContainer(envId)
      let exec: Awaited<ReturnType<typeof container.exec>>
      let stream: NodeJS.ReadableStream & { destroy?(): void }
      try {
        exec = await container.exec({
          Cmd: cmd,
          AttachStdout: true,
          AttachStderr: true,
          AttachStdin: false,
          Tty: false,
          Env: envList(o.env),
          ...(o.workdir ? { WorkingDir: o.workdir } : {}),
          ...(o.user ? { User: o.user } : {}),
        })
        stream = await exec.start({ hijack: true, stdin: false })
      } catch (e) {
        throw mapError(e, `environment ${envId}`)
      }

      const out = collector('stdout', maxOutput, o.onOutput)
      const err = collector('stderr', maxOutput, o.onOutput)
      docker.modem.demuxStream(stream, out.writable, err.writable)

      type Outcome = { kind: 'done' } | { kind: 'timeout' } | { kind: 'abort' } | { kind: 'error'; error: unknown }
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const outcome = await new Promise<Outcome>((resolve) => {
        stream.on('end', () => resolve({ kind: 'done' }))
        stream.on('close', () => resolve({ kind: 'done' }))
        stream.on('error', (error) => resolve({ kind: 'error', error }))
        if (o.timeoutMs !== undefined) timer = setTimeout(() => resolve({ kind: 'timeout' }), o.timeoutMs)
        if (o.signal) {
          onAbort = () => resolve({ kind: 'abort' })
          o.signal.addEventListener('abort', onAbort, { once: true })
        }
      })
      if (timer) clearTimeout(timer)
      if (onAbort) o.signal?.removeEventListener('abort', onAbort)

      if (outcome.kind !== 'done') {
        // Docker has no API to kill an exec'd process: stop reading and leave it. The
        // environment's own limits still apply, and destroying the env ends it.
        stream.destroy?.()
        if (outcome.kind === 'abort') throw new ExecAbortedError()
        if (outcome.kind === 'error') throw mapError(outcome.error, `exec in ${envId}`)
        log.warn('exec timed out, abandoning it', { env: envId, cmd: cmd[0], timeoutMs: o.timeoutMs })
        return {
          exitCode: TIMEOUT_EXIT_CODE,
          stdout: out.text(),
          stderr: err.text(),
          timedOut: true,
          durationMs: clock.now() - started,
        }
      }

      let exitCode: number
      try {
        const info = await exec.inspect()
        exitCode = info.ExitCode ?? -1
      } catch (e) {
        throw mapError(e, `exec in ${envId}`)
      }
      const result: ExecResult = {
        exitCode,
        stdout: out.text(),
        stderr: err.text(),
        timedOut: false,
        durationMs: clock.now() - started,
      }
      return result
    },

    async logs(envId, o = {}) {
      try {
        const res = await docker
          .getContainer(envId)
          .logs({ stdout: true, stderr: true, follow: false, ...(o.tail !== undefined ? { tail: o.tail } : {}) })
        const buf = Buffer.isBuffer(res) ? res : await readAll(res)
        return demuxBuffer(buf)
      } catch (e) {
        throw mapError(e, `environment ${envId}`)
      }
    },

    async egressLog(envId) {
      const name = proxyName(envName(envId))
      let buf: Buffer
      try {
        const res = await docker.getContainer(name).logs({ stdout: true, stderr: false, follow: false })
        buf = Buffer.isBuffer(res) ? res : await readAll(res)
      } catch (e) {
        if (statusOf(e) === 404) return []
        throw mapError(e, `egress proxy of ${envId}`)
      }
      return parseEgressLog(demuxBuffer(buf))
    },

    async previewTarget(envId, port): Promise<PreviewTarget> {
      const name = envName(envId)
      let main: ContainerInspectLike
      try {
        main = await docker.getContainer(mainName(name)).inspect()
      } catch (e) {
        if (statusOf(e) === 404) throw new NotFoundError('environment', envId)
        throw mapError(e, `environment ${envId}`)
      }
      const labels = main.Config.Labels ?? {}
      if (labels[LABEL_MANAGED] !== 'true' || labels[LABEL_ROLE] !== 'main') throw new NotFoundError('environment', envId)
      const exposed = (labels[LABEL_EXPOSE] ?? '').split(',').filter(Boolean).map(Number)
      if (!exposed.includes(port)) throw new NotFoundError('exposed port', `${envId}:${port}`)
      const previewNet = previewNetworkName(name)
      await attachSelf(previewNet)
      let fwd: ContainerInspectLike
      try {
        fwd = await docker.getContainer(previewName(name)).inspect()
      } catch (e) {
        if (statusOf(e) === 404) throw new UnavailableError(`the preview forwarder of ${envId} is gone`)
        throw mapError(e, `preview forwarder of ${envId}`)
      }
      const ip = fwd.NetworkSettings?.Networks?.[previewNet]?.IPAddress
      if (!fwd.State.Running || !ip) throw new UnavailableError(`the preview forwarder of ${envId} is not running`)
      return { host: ip, port }
    },

    async spawn(envId, cmd, o = {}): Promise<Process> {
      if (!cmd.length) throw new ValidationError('spawn needs a command')
      const container = docker.getContainer(envId)
      // The process reports its pid first (so `kill` can reach it), then becomes the command.
      const marker = `mp-pid-${randomBytes(6).toString('hex')}:`
      let exec: Awaited<ReturnType<typeof container.exec>>
      let stream: NodeJS.ReadWriteStream & { destroy?(): void }
      try {
        exec = await container.exec({
          Cmd: ['sh', '-c', `echo "${marker}$$" >&2; exec "$@"`, 'sh', ...cmd],
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          Env: envList(o.env),
          ...(o.workdir ? { WorkingDir: o.workdir } : {}),
        })
        stream = (await exec.start({ hijack: true, stdin: true })) as unknown as NodeJS.ReadWriteStream & { destroy?(): void }
      } catch (e) {
        throw mapError(e, `environment ${envId}`)
      }

      let resolvePid!: (pid: number | null) => void
      const pid = new Promise<number | null>((r) => {
        resolvePid = r
      })
      let head = ''
      let headDone = false
      const emit = (streamName: 'stdout' | 'stderr', text: string) => {
        if (text) o.onOutput?.({ stream: streamName, text })
      }
      const out = new StringDecoder('utf8')
      const err = new StringDecoder('utf8')
      const stdout = new Writable({
        write(chunk: Buffer, _enc, cb) {
          emit('stdout', out.write(chunk))
          cb()
        },
      })
      const stderr = new Writable({
        write(chunk: Buffer, _enc, cb) {
          const text = err.write(chunk)
          if (headDone) emit('stderr', text)
          else {
            head += text
            const nl = head.indexOf('\n')
            if (nl >= 0 || head.length > 256) {
              headDone = true
              const first = nl >= 0 ? head.slice(0, nl) : head
              const n = first.startsWith(marker) ? Number(first.slice(marker.length)) : Number.NaN
              resolvePid(Number.isInteger(n) && n > 0 ? n : null)
              emit('stderr', first.startsWith(marker) ? head.slice(nl + 1) : head)
              head = ''
            }
          }
          cb()
        },
      })
      docker.modem.demuxStream(stream, stdout, stderr)

      let ended = false
      let killed = false
      const exited = new Promise<{ exitCode: number | null }>((resolve) => {
        const done = async () => {
          if (ended) return
          ended = true
          resolvePid(null)
          emit('stdout', out.end())
          emit('stderr', err.end())
          if (killed) return resolve({ exitCode: null })
          try {
            resolve({ exitCode: (await exec.inspect()).ExitCode ?? null })
          } catch {
            resolve({ exitCode: null })
          }
        }
        stream.on('end', done)
        stream.on('close', done)
        stream.on('error', done)
      })

      return {
        exited,
        write(data) {
          if (ended) return Promise.reject(new ConflictError('the process has ended'))
          return new Promise<void>((resolve, reject) => {
            stream.write(typeof data === 'string' ? data : Buffer.from(data), (e) =>
              e ? reject(mapError(e, 'stdin')) : resolve(),
            )
          })
        },
        end() {
          if (!ended) stream.end()
        },
        async kill() {
          if (ended) return
          killed = true
          const p = await Promise.race([pid, new Promise<null>((r) => setTimeout(() => r(null), KILL_WAIT_MS))])
          if (p)
            await runtime
              .exec(envId, ['sh', '-c', 'kill -KILL -- "-$1" 2>/dev/null; kill -KILL "$1" 2>/dev/null; true', 'sh', String(p)], {
                timeoutMs: KILL_WAIT_MS,
              })
              .catch((e) => log.warn('could not kill a process', { env: envId, err: errorMessage(e) }))
          stream.destroy?.()
          await Promise.race([exited, new Promise((r) => setTimeout(r, KILL_WAIT_MS))])
        },
      }
    },

    async copyIn(envId, dir, entries) {
      if (!isAbsolute(dir)) throw new ValidationError(`dir must be absolute: ${dir}`)
      const bad = entries.map((e) => invalidEntryPath(e.path)).filter((x): x is string => !!x)
      if (bad.length) throw new ValidationError('invalid entries', bad)
      try {
        await docker.getContainer(envId).putArchive(packTar(entries), { path: dir })
      } catch (e) {
        throw mapError(e, `${dir} in ${envId}`)
      }
    },

    async copyOut(envId, path): Promise<FileEntry[]> {
      let stream: NodeJS.ReadableStream
      try {
        stream = await docker.getContainer(envId).getArchive({ path })
      } catch (e) {
        if (statusOf(e) === 404 && /no such (file|directory)|could not find the file/i.test(errorMessage(e))) return []
        throw mapError(e, `${path} in ${envId}`)
      }
      return unpackTar(await readAll(stream))
    },

    async screenshot(envId) {
      const info = await runtime.getEnv(envId)
      if (!info) throw new NotFoundError('environment', envId)
      if (!info.desktop) throw new NotFoundError('desktop', envId)
      const r = await runtime.exec(desktopName(envName(envId)), ['mp-desktop-shot'], { timeoutMs: 30_000 })
      if (r.exitCode !== 0)
        throw new UnavailableError(`the desktop of ${envId} could not take a screenshot: ${r.stderr.slice(-300)}`)
      const png = Buffer.from(r.stdout.trim(), 'base64')
      if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new UnavailableError(`the desktop of ${envId} gave no PNG`)
      return new Uint8Array(png)
    },

    async stats(envId): Promise<EnvStats> {
      const at = new Date(clock.now()).toISOString()
      const out: ContainerStats[] = []
      for (const c of await envContainers(envId)) {
        const role = c.Labels[LABEL_ROLE]
        const base = {
          name: role === 'service' ? (c.Labels[LABEL_SERVICE] ?? 'service') : role === DESKTOP_SUFFIX ? 'desktop' : 'main',
          role: (role === 'service' || role === DESKTOP_SUFFIX ? role : 'main') as ContainerStats['role'],
          state: c.State,
          startedAt: new Date(c.Created * 1000).toISOString(),
        }
        const empty = {
          cpuPercent: null,
          memoryBytes: null,
          memoryLimitBytes: null,
          netRxBytes: null,
          netTxBytes: null,
          pids: null,
        }
        const container = docker.getContainer(c.Id)
        if (c.State !== 'running' || !container.stats) {
          out.push({ ...base, ...empty })
          continue
        }
        try {
          const raw = await container.stats({ stream: false, 'one-shot': true })
          out.push({ ...base, ...statsOf(c.Id, raw) })
        } catch (e) {
          log.debug('container stats failed', { container: c.Id, err: errorMessage(e) })
          out.push({ ...base, ...empty })
        }
      }
      // Forget containers that are gone.
      if (cpuSamples.size > 1000) cpuSamples.clear()
      return { envId, at, containers: out }
    },

    async processes(envId): Promise<ContainerProcesses[]> {
      const out: ContainerProcesses[] = []
      for (const c of await envContainers(envId)) {
        const role = c.Labels[LABEL_ROLE]
        const name = role === 'service' ? (c.Labels[LABEL_SERVICE] ?? 'service') : role === DESKTOP_SUFFIX ? 'desktop' : 'main'
        const r: ContainerProcesses = {
          name,
          role: (role === 'service' || role === DESKTOP_SUFFIX ? role : 'main') as ContainerProcesses['role'],
          titles: [],
          processes: [],
        }
        const container = docker.getContainer(c.Id)
        if (c.State === 'running' && container.top) {
          try {
            const top = await container.top({ ps_args: '-eo pid,user,pcpu,pmem,etime,args' })
            r.titles = top.Titles ?? []
            const cpu = r.titles.findIndex((t) => /cpu/i.test(t))
            r.processes = [...(top.Processes ?? [])]
              .sort((a, b) => (cpu < 0 ? 0 : Number(b[cpu] ?? 0) - Number(a[cpu] ?? 0)))
              .slice(0, 25)
          } catch (e) {
            log.debug('container top failed', { container: c.Id, err: errorMessage(e) })
          }
        }
        out.push(r)
      }
      return out
    },

    async features(): Promise<RuntimeFeatures> {
      features ??= docker.version().then(
        (v) => ({ volumeSubpath: apiAtLeast(v.ApiVersion, VOLUME_SUBPATH_API), desktop: true }),
        (e) => {
          features = null
          throw mapError(e, 'docker version')
        },
      )
      return features
    },

    async destroyEnv(envId) {
      const name = envName(envId)
      await removeAll(name)
      log.info('environment destroyed', { env: name })
    },
  }
  return runtime
}

function validate(spec: EnvSpec) {
  const issues: string[] = []
  if (!NAME_RE.test(spec.name ?? '')) issues.push(`name must match ${NAME_RE}`)
  if (!spec.image && !spec.build) issues.push('an image or a build is needed')
  for (const m of spec.mounts ?? []) {
    if (!isAbsolute(m.hostPath) || !isAbsolute(m.containerPath)) issues.push(`mount paths must be absolute: ${m.hostPath}`)
    if (m.hostPath.includes(':') || m.containerPath.includes(':')) issues.push(`mount paths can't contain ':': ${m.hostPath}`)
  }
  for (const svc of spec.services ?? []) {
    if (!NAME_RE.test(svc.name) || svc.name === 'main') issues.push(`bad service name: ${svc.name}`)
    if (spec.egress && svc.name === PROXY_ALIAS) issues.push(`service name ${PROXY_ALIAS} is taken by the egress proxy`)
    if (spec.expose?.length && svc.name === PREVIEW_SUFFIX)
      issues.push(`service name ${PREVIEW_SUFFIX} is taken by the preview forwarder`)
    if (spec.desktop && svc.name === DESKTOP_SUFFIX) issues.push(`service name ${DESKTOP_SUFFIX} is taken by the desktop`)
  }
  issues.push(...invalidExpose(spec.expose))
  issues.push(...invalidDesktop(spec.desktop, spec.expose))
  issues.push(...invalidVolumeMounts(spec.volumeMounts))
  for (const p of [...(spec.volumes ?? []), ...Object.keys(spec.tmpfs ?? {})])
    if (!isAbsolute(p) || p.includes(':') || p.includes(',')) issues.push(`bad container path: ${p}`)
  if (spec.user !== undefined && !USER_RE.test(spec.user)) issues.push(`bad user: ${spec.user}`)
  if (spec.limits?.pids !== undefined && !(Number.isInteger(spec.limits.pids) && spec.limits.pids > 0))
    issues.push('limits.pids must be a positive integer')
  issues.push(...invalidNetworkSpec(spec))
  if (spec.egress) {
    if (!Array.isArray(spec.egress.allow)) issues.push('egress.allow must be a list')
    else for (const bad of invalidEgressEntries(spec.egress.allow)) issues.push(`bad egress entry: ${bad}`)
  }
  for (const k of [...Object.keys(spec.env ?? {}), ...(spec.services ?? []).flatMap((s) => Object.keys(s.env ?? {}))]) {
    if (!ENV_KEY_RE.test(k)) issues.push(`bad env var name: ${k}`)
  }
  if (spec.limits?.cpus !== undefined && !(spec.limits.cpus > 0)) issues.push('limits.cpus must be > 0')
  if (spec.limits?.memoryMb !== undefined && !(spec.limits.memoryMb > 0)) issues.push('limits.memoryMb must be > 0')
  if (issues.length) throw new ValidationError('invalid environment spec', issues)
}

/** The proxy's JSON log lines; anything else in its output is skipped. */
export function parseEgressLog(text: string): EgressLogEntry[] {
  const out: EgressLogEntry[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const v = JSON.parse(t) as EgressLogEntry
      if (typeof v.host === 'string' && typeof v.allowed === 'boolean' && typeof v.method === 'string') out.push(v)
    } catch {
      // not a log line
    }
  }
  return out
}

/** Whether Docker API version `v` (e.g. `1.47`) is at least `min`. */
export function apiAtLeast(v: string | undefined, min: string): boolean {
  const [a = 0, b = 0] = (v ?? '0').split('.').map(Number)
  const [c = 0, d = 0] = min.split('.').map(Number)
  return a > c || (a === c && b >= d)
}

function limits(spec: EnvSpec): Record<string, number> {
  const out: Record<string, number> = {}
  if (spec.limits?.cpus) out.NanoCpus = Math.round(spec.limits.cpus * 1e9)
  if (spec.limits?.memoryMb) {
    out.Memory = Math.round(spec.limits.memoryMb * 1024 * 1024)
    out.MemorySwap = out.Memory // no swap beyond the memory limit
  }
  return out
}

function envList(env?: Record<string, string>): string[] {
  return Object.entries(env ?? {}).map(([k, v]) => {
    if (!ENV_KEY_RE.test(k)) throw new ValidationError(`bad env var name: ${k}`)
    return `${k}=${v}`
  })
}

function infoFromInspect(c: ContainerInspectLike): EnvInfo {
  const labels = c.Config.Labels ?? {}
  return {
    id: c.Name.replace(/^\//, ''),
    name: labels[LABEL_ENV] ?? c.Name.replace(/^\//, ''),
    status: c.State.Running ? 'running' : 'stopped',
    labels,
    createdAt: new Date(c.Created).toISOString(),
    ...(labels[LABEL_DESKTOP] === 'true' ? { desktop: true } : {}),
  }
}

function infoFromSummary(c: ContainerSummaryLike): EnvInfo {
  const name = (c.Names[0] ?? c.Id).replace(/^\//, '')
  return {
    id: name,
    name: c.Labels[LABEL_ENV] ?? name,
    status: c.State === 'running' ? 'running' : 'stopped',
    labels: c.Labels,
    createdAt: new Date(c.Created * 1000).toISOString(),
    ...(c.Labels[LABEL_DESKTOP] === 'true' ? { desktop: true } : {}),
  }
}

function collector(
  stream: 'stdout' | 'stderr',
  max: number,
  onOutput?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
) {
  const decoder = new StringDecoder('utf8')
  const parts: string[] = []
  let size = 0
  let truncated = false
  const push = (text: string) => {
    if (!text) return
    onOutput?.({ stream, text })
    if (truncated) return
    if (size + text.length > max) {
      parts.push(text.slice(0, max - size), `\n[output truncated after ${max} bytes]\n`)
      truncated = true
      return
    }
    parts.push(text)
    size += text.length
  }
  const writable = new Writable({
    write(chunk: Buffer, _enc, cb) {
      push(decoder.write(chunk))
      cb()
    },
  })
  return {
    writable,
    text: () => {
      push(decoder.end())
      return parts.join('')
    },
  }
}

/** Splits Docker's multiplexed log format (8-byte frame headers) back into text. Plain text passes through. */
export function demuxBuffer(buf: Buffer): string {
  const looksMuxed = buf.length >= 8 && buf[0]! <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0
  if (!looksMuxed) return buf.toString('utf8')
  const parts: Buffer[] = []
  let i = 0
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4)
    parts.push(buf.subarray(i + 8, i + 8 + len))
    i += 8 + len
  }
  return Buffer.concat(parts).toString('utf8')
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
  return Buffer.concat(chunks)
}

function follow(docker: DockerLike, stream: NodeJS.ReadableStream, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (err, output) => {
      if (err) return reject(mapError(err, what))
      const failed = (output ?? []).find((o) => o && (o.error || o.errorDetail))
      if (failed) return reject(new UnavailableError(`${what} failed: ${failed.error ?? failed.errorDetail?.message}`))
      resolve()
    })
  })
}

function statusOf(e: unknown): number | undefined {
  return typeof e === 'object' && e && 'statusCode' in e ? Number((e as { statusCode: unknown }).statusCode) : undefined
}

/** Docker API errors to harness errors: 404 not found, 409 conflict, socket trouble unavailable. */
export function mapError(e: unknown, what: string): Error {
  if (e instanceof MpError) return e
  const status = statusOf(e)
  const code = typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : ''
  const msg = errorMessage(e)
  if (status === 404) return new NotFoundError(what, undefined, { cause: msg })
  if (status === 409) return new ConflictError(`${what}: ${msg}`)
  if (status === 400) return new ValidationError(`${what}: ${msg}`)
  // The socket itself: retrying won't help, a person has to fix the deployment.
  if (!status && (code === 'EACCES' || code === 'EPERM'))
    return new DeniedError(
      "The app can't use the Docker socket (permission denied): run the container with the socket's group (the image's entrypoint does this by itself), or set DOCKER_GID",
      { cause: msg },
    )
  if (!status && code === 'ENOENT')
    return new ValidationError(
      `The Docker socket isn't there (${msg}): mount it into the app container (/var/run/docker.sock), set DOCKER_SOCKET, or turn DOCKER_ENABLED off`,
    )
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code) || (status && status >= 500)) {
    return new UnavailableError(`docker: ${what}: ${msg}`)
  }
  return e instanceof Error ? e : new Error(msg)
}
