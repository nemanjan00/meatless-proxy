import { createHash } from 'node:crypto'
import type { Json } from '@mp/core'
import { egressEntryCovered, invalidExpose, type ContainerRuntime, type EnvSpec } from '@mp/containers'
import type { Session } from '@mp/sessions'
import type { ToolContext, ToolHandler } from '@mp/tools'
import { DEFAULT_ENV_PROFILES, describeProfiles, envProfile } from '../env-profiles.ts'
import { envOf, fail, ok, str, worktreesOf, type Kit } from '../kit.ts'
import { nodeWorktreeFs } from '../worktree-fs.ts'

/** Where each checkout of a session is in its environment: /repos/<repository name>, made unique. */
function repoMountsOf(worktrees: { key: string; path: string }[]): { key: string; path: string; containerPath: string }[] {
  const used = new Set<string>()
  return worktrees.map((w) => {
    const base = (w.key.split('/').pop() || 'repo').replace(/[^A-Za-z0-9._-]/g, '-')
    let name = base
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`
    used.add(name)
    return { key: w.key, path: w.path, containerPath: `/repos/${name}` }
  })
}

/** Told with every environment: what it holds, and what it doesn't. */
const ENV_NOTE =
  'The checkout is at /workspace (and every checkout of this session at /repos/<name>): files only. Run git through the git.* tools (status, diff, log, commit, push), not inside the environment: its .git points outside it. Without network nothing can be installed, so pick an image that already has the tools you need.'

import { DIRECT_NOTE, PROXY_NOTE, directNetworkName, networkFor, type NetworkDecision } from '../network.ts'
import { worktreeFor } from './git.ts'

/**
 * Longest environment name. The runtime prefixes it (`mp-`) and suffixes container and network
 * names (`-proxy`, `-egress`, `-<service>`), which keeps them under Docker's 63 characters.
 */
export const MAX_ENV_NAME = 40

const cleanSlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

/**
 * `<employee slug>-<session slug>`, reduced to `[a-z0-9-]`. Longer than `max`, it is cut and gets a
 * short hash of the full name, so different sessions keep different names.
 */
export function envNameFor(employeeSlug: string, sessionSlug: string, max = MAX_ENV_NAME): string {
  const full = `${cleanSlug(employeeSlug) || 'employee'}-${cleanSlug(sessionSlug) || 'session'}`
  if (full.length <= max) return full
  const hash = createHash('sha256').update(full).digest('hex').slice(0, 6)
  return `${full.slice(0, max - hash.length - 1).replace(/-+$/, '')}-${hash}`
}

/** The exposed ports recorded in a session's environment meta. */
const exposedOf = (env: object | null): number[] => {
  const e = (env as { expose?: unknown } | null)?.expose
  return Array.isArray(e) ? e.filter((p): p is number => Number.isInteger(p)) : []
}

/**
 * The harness UI link to a session's live preview of `port`: its session page with the Preview tab
 * open. Relative to the harness's own origin, so it works in chat and in the UI. It carries no token:
 * the UI mints one for whoever signed in opens it.
 */
export const previewLink = (sessionId: string, port: number) =>
  `/sessions/${encodeURIComponent(sessionId)}?tab=preview&port=${port}`

/** What a network decision gave, to tell whether the setting changed since an environment started. */
const networkKey = (net: NetworkDecision) => (net.direct ? 'direct' : [...net.allow].sort().join(','))

/** Keeps the end of long output, which is usually where the error is. */
const tail = (text: string, max = 8000) =>
  text.length <= max ? text : `[… ${text.length - max} earlier characters truncated]\n${text.slice(-max)}`

export function registerEnvTools(kit: Kit, runtime: ContainerRuntime): void {
  /**
   * The network from the employee's setting with the project (the checkout's, else the session's
   * first linked one), or the deployment default.
   */
  const decideNetwork = async (session: Session, ctx: ToolContext, projectId: string | undefined) => {
    const pid = projectId ?? (await kit.projectsOf(session))[0]
    const project = pid ? await kit.deps.directory.projects.get(pid) : null
    const emp = await kit.employee(ctx.employeeId)
    const net = networkFor({
      network: emp.data.network,
      projectAllow: project?.data.egress?.allow,
      fallback: kit.deps.config.defaultEgress ?? [],
      direct: kit.deps.config.directNetwork ?? true,
    })
    return { net, emp, projectId: pid, project }
  }

  /** env.up's handler, so env.exec can start the default environment by itself. */
  let upEnv: ToolHandler = async () => fail('env.up is not ready')
  kit.tool(
    {
      name: 'env.up',
      description:
        "Start this session's isolated environment (containers on a private network) for working on code: check the repository out first (git.checkout), then env.up gives you a container with that checkout at /workspace and every checkout of this session at /repos/<name>, from an image (any image: it's kept running for you) or built from the checkout's Dockerfile. It holds files only: run git through the git.* tools. One environment per session: env.down first to change its image or which checkout is at /workspace. Network access goes through a proxy (HTTP_PROXY/HTTPS_PROXY) that allows the hosts your network setting and the project allow, or, when an admin gave you a direct network, straight out; the result says which, or why there is none. Calling it again returns the running one. Use env.exec to build, test or run. To let people watch a dev server live, list its ports in expose (and make it listen on 0.0.0.0), then share env.preview.",
      effect: 'idempotent',
      params: {
        properties: {
          profile: {
            type: 'string',
            description: `A ready-made toolkit to work in, by name (the usual choice): ${describeProfiles(kit.deps.config.envProfiles ?? DEFAULT_ENV_PROFILES)}. Without network nothing can be installed, so pick the one with the tools you need. Default: the project's profile, else the checkout's Dockerfile, else ${kit.deps.config.envDefaultProfile ?? 'default'}.`,
          },
          image: {
            type: 'string',
            description: 'Any other image instead of a profile, e.g. node:22 or python:3.13.',
          },
          dockerfile: { type: 'string', description: 'Dockerfile path in the checkout, when building.' },
          repo: {
            type: 'string',
            description:
              'Which checkout goes at /workspace (and is built): its key, e.g. gitlab.com/group/repo, or its project id. Default: your only or first checkout.',
          },
          env: { type: 'object', description: 'Environment variables (no secrets: name secrets instead).' },
          services: {
            type: 'array',
            description: 'Extra containers on the same network, e.g. [{name:"db", image:"postgres:18"}].',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, image: { type: 'string' }, env: { type: 'object' } },
              required: ['name', 'image'],
            },
          },
          egress: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Narrow the allowed hosts to these (a subset of them), through the proxy. Default: all of them (or your direct network).',
          },
          expose: {
            type: 'array',
            items: { type: 'number' },
            description: 'Ports your app serves, e.g. [5173] for a dev server, shown to people as live previews (env.preview).',
          },
        },
      },
    },
    (upEnv = async (a, ctx) => {
      const session = await kit.ownSession(undefined, ctx)
      const current = envOf(session)
      if (current) {
        const info = await runtime.getEnv(current.id)
        if (info?.status === 'running') {
          const exposed = exposedOf(current)
          // Running environments keep the network they started with.
          const started = current.networkKey
          const changed =
            typeof started === 'string' && started !== networkKey((await decideNetwork(session, ctx, current.projectId)).net)
          const notes = [
            ...(a.expose !== undefined && JSON.stringify(a.expose) !== JSON.stringify(exposed)
              ? ['the environment is already running with its own ports: env.down first to change them']
              : []),
            ...(changed
              ? [
                  'your network setting changed since this environment started: it keeps the network it started with. env.down, then env.up, to use the new one',
                ]
              : []),
          ]
          return ok({
            envId: info.id,
            name: info.name,
            status: info.status,
            existing: true,
            ...(current.network ? { network: current.network } : {}),
            ...(exposed.length ? { previews: exposed.map((port) => ({ port, url: previewLink(session.id, port) })) } : {}),
            ...(notes.length ? { note: notes.join('; ') } : {}),
          })
        }
      }
      const badExpose = invalidExpose(a.expose)
      if (badExpose.length) return fail('expose must be a list of distinct ports (1-65535)', { issues: badExpose })
      const expose = (a.expose as number[] | undefined) ?? []
      const w = worktreesOf(session).length ? worktreeFor(session, str(a.repo)) : null
      if (!str(a.image) && !str(a.profile) && !w)
        return fail('give an image or a profile, or check out a repository first (git.checkout)')

      // The employee's network setting with the project, or the deployment default. The model can
      // only narrow it: a direct network to proxied hosts, proxied hosts to fewer. Never to direct.
      const { net, emp, projectId, project } = await decideNetwork(session, ctx, w?.projectId)

      // What to run: an image, a named profile, the project's profile, the checkout's Dockerfile,
      // else the default profile (most repositories have no Dockerfile to build).
      const profiles = kit.deps.config.envProfiles ?? [...DEFAULT_ENV_PROFILES]
      let image = str(a.image)
      let profile: string | undefined
      if (!image && str(a.profile)) {
        const p = envProfile(profiles, a.profile)
        if (!p) return fail(`no profile ${a.profile}: pick one of ${profiles.map((x) => x.name).join(', ')}`)
        image = p.image
        profile = p.name
      }
      if (!image && !str(a.dockerfile) && project?.data.envProfile) {
        const p = envProfile(profiles, project.data.envProfile)
        if (p) {
          image = p.image
          profile = p.name
        }
      }
      if (!image && !str(a.dockerfile)) {
        const hasDockerfile = w
          ? await (kit.deps.worktreeFs ?? nodeWorktreeFs()).read(w.path, 'Dockerfile').then(
              () => true,
              () => false,
            )
          : false
        if (!hasDockerfile) {
          const p = envProfile(profiles, kit.deps.config.envDefaultProfile ?? 'default') ?? profiles[0]
          if (p) {
            image = p.image
            profile = p.name
          }
        }
      }
      let egress: EnvSpec['egress'] = net.allow.length ? { allow: [...net.allow] } : undefined
      let direct = net.direct === true
      if (a.egress !== undefined) {
        if (!Array.isArray(a.egress)) return fail('egress must be a list of hosts')
        const requested = (a.egress as unknown[]).map(String)
        // A direct network allows any public host; through the proxy, as any other list.
        const allowed = direct ? ['*'] : net.allow
        const wider = requested.filter((e) => !egressEntryCovered(e, allowed))
        if (wider.length)
          return fail(
            allowed.length ? 'egress can only narrow the allowed hosts' : `there is no network to narrow (${net.reason})`,
            { notAllowed: wider, allowed: direct ? ['any public host (direct network)'] : net.allow },
          )
        if (allowed.length) {
          egress = { allow: requested }
          direct = false
        }
      }
      const network: Json = direct
        ? { via: 'direct', note: DIRECT_NOTE }
        : egress
          ? { via: 'proxy', allow: egress.allow, note: PROXY_NOTE }
          : { via: 'none', reason: net.reason ?? 'no network: env.up was asked for no hosts' }

      // Every checkout of the session is there too, at /repos/<name>: one environment works across them.
      const repoMounts = repoMountsOf(worktreesOf(session))
      const otherMounts = repoMounts.map((m) => ({ hostPath: m.path, containerPath: m.containerPath }))
      const spec: EnvSpec = {
        name: envNameFor(emp.key ?? emp.data.name, session.data.slug || session.id),
        ...(image ? { image } : { build: { context: w!.path, ...(str(a.dockerfile) ? { dockerfile: a.dockerfile } : {}) } }),
        ...(w ? { mounts: [{ hostPath: w.path, containerPath: '/workspace' }, ...otherMounts], workdir: '/workspace' } : {}),
        ...(a.env ? { env: Object.fromEntries(Object.entries(a.env).map(([k, v]) => [k, String(v)])) } : {}),
        ...(a.services ? { services: a.services } : {}),
        ...(egress ? { egress } : {}),
        ...(direct ? { direct: { network: directNetworkName(emp.key ?? emp.data.name) } } : {}),
        ...(expose.length ? { expose } : {}),
        labels: { 'mp.session': session.id, 'mp.employee': ctx.employeeId },
      }
      const info = await runtime.createEnv(spec)
      await kit.patchMeta(session.id, (m) => ({
        ...m,
        env: {
          id: info.id,
          name: info.name,
          ...(expose.length ? { expose } : {}),
          network,
          networkKey: networkKey(net),
          ...(projectId ? { projectId } : {}),
        },
      }))
      return ok({
        envId: info.id,
        name: info.name,
        status: info.status,
        ...(w ? { workspace: '/workspace', checkout: w.key } : {}),
        ...(image ? { image } : {}),
        ...(profile ? { profile } : {}),
        ...(repoMounts.length ? { repos: Object.fromEntries(repoMounts.map((m) => [m.containerPath, m.key])) } : {}),
        network,
        ...(expose.length ? { previews: expose.map((port) => ({ port, url: previewLink(session.id, port) })) } : {}),
        note: ENV_NOTE,
      })
    }),
  )

  kit.tool(
    {
      name: 'env.exec',
      description:
        'Run a command in this session\'s environment, in /workspace. Without one it starts the default environment first (your checkout, in the project\'s profile, its Dockerfile or the default profile): use env.up yourself to pick a profile, image or ports. An argv list, e.g. ["npm", "test"]; for pipes and globs use ["sh", "-c", "grep -rn router src | wc -l"]. Returns the exit code and the end of stdout/stderr. Default timeout 300 s.',
      effect: 'non_idempotent',
      params: {
        properties: {
          cmd: { type: 'array', items: { type: 'string' } },
          timeoutSeconds: { type: 'number' },
          workdir: { type: 'string' },
        },
        required: ['cmd'],
      },
    },
    async (a, ctx) => {
      let session = await kit.ownSession(undefined, ctx)
      let env = envOf(session)
      // No environment yet, or it stopped: start the default one (the checkout, with the project's
      // profile, its Dockerfile or the default profile), as env.up with no arguments would.
      const running = env ? (await runtime.getEnv(env.id))?.status === 'running' : false
      let started: Json | undefined
      if (!running) {
        const up = await upEnv({}, ctx)
        if (up.isError) return up
        started = up.output as Json
        session = await kit.ownSession(undefined, ctx)
        env = envOf(session)
        if (!env) return fail('the environment could not be started')
      }
      if (!env) return fail('the environment could not be started')
      const envId = env.id
      const cmd = (a.cmd as unknown[]).map(String)
      if (!cmd.length) return fail('cmd is empty')
      const timeoutMs = Math.min(Math.max(1, a.timeoutSeconds ?? 300), 3600) * 1000
      const r = await runtime.exec(envId, cmd, {
        timeoutMs,
        signal: ctx.signal,
        ...(str(a.workdir) ? { workdir: a.workdir } : {}),
      })
      return {
        output: {
          exitCode: r.exitCode,
          ...(r.timedOut ? { timedOut: true } : {}),
          durationMs: r.durationMs,
          stdout: tail(r.stdout),
          stderr: tail(r.stderr, 4000),
          ...(started ? { started } : {}),
        },
        ...(r.exitCode !== 0 ? { isError: true } : {}),
      }
    },
  )

  kit.tool(
    {
      name: 'env.logs',
      description: "The latest logs of this session's environment (or another of your sessions', for reviews).",
      effect: 'read',
      params: { properties: { tail: { type: 'number', description: 'Lines. Default 200.' }, sessionId: { type: 'string' } } },
    },
    async (a, ctx) => {
      const session = await kit.ownSession(a.sessionId, ctx)
      const env = envOf(session)
      if (!env) return fail('this session has no environment')
      const logs = await runtime.logs(env.id, { tail: Math.min(Math.max(1, a.tail ?? 200), 2000) })
      return ok({ envId: env.id, logs: tail(logs, 12000) })
    },
  )

  kit.tool(
    {
      name: 'env.preview',
      description:
        "A link people open to watch a port of your environment live (from env.up's expose), in this session's Preview tab of the harness UI. Share it in chat, e.g. [Preview](link). It reloads as you commit.",
      effect: 'read',
      params: {
        properties: {
          port: { type: 'number', description: 'Which exposed port. Default: the only one.' },
          sessionId: { type: 'string', description: "Another of your sessions' environment." },
        },
      },
    },
    async (a, ctx) => {
      const session = await kit.ownSession(a.sessionId, ctx)
      const env = envOf(session)
      if (!env) return fail('this session has no environment: call env.up with expose first')
      const ports = exposedOf(env)
      if (!ports.length) return fail('the environment exposes no ports: env.down, then env.up with expose')
      const port = a.port ?? (ports.length === 1 ? ports[0] : undefined)
      if (port === undefined) return fail('which port? the environment exposes several', { ports })
      if (!ports.includes(port)) return fail(`port ${port} is not exposed`, { ports })
      const info = await runtime.getEnv(env.id)
      if (!info) return fail('the environment is gone: call env.up again')
      return ok({ url: previewLink(session.id, port), port, envId: env.id, ports, status: info.status })
    },
  )

  kit.tool(
    {
      name: 'env.down',
      description: "Tear down this session's environment (containers, network, volumes).",
      effect: 'idempotent',
    },
    async (_a, ctx) => {
      const session = await kit.ownSession(undefined, ctx)
      const env = envOf(session)
      if (!env) return ok({ down: true, note: 'there was no environment' })
      await runtime.destroyEnv(env.id)
      await kit.patchMeta(session.id, (m) => {
        delete m.env
        return m
      })
      return ok({ down: true, envId: env.id } as Json)
    },
  )
}
