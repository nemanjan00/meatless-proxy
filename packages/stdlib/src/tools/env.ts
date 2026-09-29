import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Json } from '@mp/core'
import { DESKTOP_DISPLAY, egressEntryCovered, invalidExpose, type ContainerRuntime, type EnvSpec } from '@mp/containers'
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

/** Where the employee's own files are in an environment (when the deployment keeps them on disk). */
export const FILES_MOUNT = '/files'
const FILES_NOTE =
  '/files in an environment is your filesystem root (/files/a.zip is /a.zip for fs.* and chat attachments): copy a build output there to attach it or fs.share it.'

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

/**
 * The harness UI link to a session's live desktop: its Preview tab with the desktop open. Like
 * `previewLink`, it carries no token: the UI mints a single-use one, scoped to the viewer, on open.
 */
export const desktopLink = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}?tab=preview&desktop=1`

/** What env.up tells about a desktop. */
const desktopOf = (sessionId: string) => ({
  url: desktopLink(sessionId),
  display: DESKTOP_DISPLAY,
  note: `A virtual screen: programs you start with env.exec draw on it (DISPLAY=${DESKTOP_DISPLAY} is set), e.g. a headed browser. People watch it live at url (share it as [Desktop](url)). env.screenshot saves what it shows to your files, for image.view.`,
})

/** Where a screenshot of a session's desktop is saved in the employee's files. */
const screenshotPath = (envName: string, at: string) => `/screenshots/${envName}-${at.replace(/[:.]/g, '-')}.png`

/** What a network decision gave, to tell whether the setting changed since an environment started. */
const networkKey = (net: NetworkDecision) => (net.direct ? 'direct' : [...net.allow].sort().join(','))

/** Keeps the end of long output, which is usually where the error is. */
const tail = (text: string, max = 8000) =>
  text.length <= max ? text : `[… ${text.length - max} earlier characters truncated]\n${text.slice(-max)}`

/**
 * Keeps the start and the end of long command output (where the command's own header and its error
 * usually are), with a marker in the middle saying how much was left out.
 */
export function headAndTail(text: string, keep = 3000): { text: string; cut: boolean } {
  if (text.length <= keep * 2) return { text, cut: false }
  const left = text.length - keep * 2
  return { text: `${text.slice(0, keep)}\n[… ${left} characters left out …]\n${text.slice(-keep)}`, cut: true }
}

/** What env.exec says when it cut output. */
export const cutNote = (length: number) =>
  `output over ${length} characters: redirect it to a file (e.g. > /files/out.txt, or in /workspace) and read ranges with fs.read / git.read_file`

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
          desktop: {
            type: 'boolean',
            description:
              'Also start a virtual screen (1440x900) that GUI programs and headed browsers draw on (DISPLAY=:99 is set for env.exec). People watch it live; env.screenshot lets you see it.',
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
            ...(a.desktop === true && !current.desktop
              ? ['the environment is already running without a desktop: env.down, then env.up with desktop: true']
              : []),
          ]
          return ok({
            envId: info.id,
            name: info.name,
            status: info.status,
            existing: true,
            ...(current.network ? { network: current.network } : {}),
            ...(exposed.length ? { previews: exposed.map((port) => ({ port, url: previewLink(session.id, port) })) } : {}),
            ...(current.desktop ? { desktop: desktopOf(session.id) } : {}),
            ...(notes.length ? { note: notes.join('; ') } : {}),
          })
        }
      }
      const badExpose = invalidExpose(a.expose)
      if (badExpose.length) return fail('expose must be a list of distinct ports (1-65535)', { issues: badExpose })
      const expose = (a.expose as number[] | undefined) ?? []
      if (a.desktop !== undefined && typeof a.desktop !== 'boolean') return fail('desktop must be true or false')
      const desktop = a.desktop === true
      if (desktop && (!runtime.screenshot || !(await runtime.features?.())?.desktop))
        return fail('this deployment has no desktops: its container runtime cannot run one')
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
      // The employee's own files, at /files: builds can leave their results there for fs.* and chat.
      const filesRoot = kit.deps.config.filesDir
      const ownFiles = filesRoot && /^[A-Za-z0-9_-]+$/.test(ctx.employeeId) ? resolve(filesRoot, ctx.employeeId) : null
      if (ownFiles) await mkdir(ownFiles, { recursive: true })
      const mounts = [
        ...(w ? [{ hostPath: w.path, containerPath: '/workspace' }, ...otherMounts] : []),
        ...(ownFiles ? [{ hostPath: ownFiles, containerPath: FILES_MOUNT }] : []),
      ]
      const spec: EnvSpec = {
        name: envNameFor(emp.key ?? emp.data.name, session.data.slug || session.id),
        ...(image ? { image } : { build: { context: w!.path, ...(str(a.dockerfile) ? { dockerfile: a.dockerfile } : {}) } }),
        ...(mounts.length ? { mounts } : {}),
        ...(w ? { workdir: '/workspace' } : {}),
        ...(a.env ? { env: Object.fromEntries(Object.entries(a.env).map(([k, v]) => [k, String(v)])) } : {}),
        ...(a.services ? { services: a.services } : {}),
        ...(egress ? { egress } : {}),
        ...(direct ? { direct: { network: directNetworkName(emp.key ?? emp.data.name) } } : {}),
        ...(expose.length ? { expose } : {}),
        ...(desktop ? { desktop: {} } : {}),
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
          image: image ?? 'build',
          ...(profile ? { profile } : {}),
          ...(desktop ? { desktop: true } : {}),
          ...(ownFiles ? { files: true } : {}),
          ...(w
            ? {
                checkouts: [
                  { key: w.key, path: '/workspace' },
                  ...repoMounts.map((m) => ({ key: m.key, path: m.containerPath })),
                ],
              }
            : {}),
          ...(a.services ? { services: (a.services as { name: unknown }[]).map((x) => String(x.name)) } : {}),
        },
      }))
      kit.deps.bus?.publish('env.changed', { sessionId: session.id, envId: info.id, op: 'up' })
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
        ...(desktop ? { desktop: desktopOf(session.id) } : {}),
        ...(ownFiles ? { files: FILES_MOUNT } : {}),
        note: ownFiles ? `${ENV_NOTE} ${FILES_NOTE}` : ENV_NOTE,
      })
    }),
  )

  kit.tool(
    {
      name: 'env.exec',
      description:
        'Run a command in this session\'s environment, in /workspace (/files in it is your filesystem root: /files/a.zip is /a.zip for fs.* and chat attachments). Without one it starts the default environment first (your checkout, in the project\'s profile, its Dockerfile or the default profile): use env.up yourself to pick a profile, image or ports. An argv list, e.g. ["npm", "test"]; for pipes and globs use ["sh", "-c", "grep -rn router src | wc -l"]. Returns the exit code and the end of stdout/stderr. Default timeout 300 s.',
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
      // What runs where, for the Environments page: started, and finished whatever the outcome.
      const execution = { sessionId: session.id, envId, runId: ctx.runId, callId: ctx.callId, cmd }
      kit.deps.bus?.publish('env.exec.started', { ...execution, startedAt: ctx.clock.iso() })
      let r: Awaited<ReturnType<typeof runtime.exec>>
      try {
        r = await runtime.exec(envId, cmd, {
          timeoutMs,
          signal: ctx.signal,
          ...(str(a.workdir) ? { workdir: a.workdir } : {}),
        })
      } finally {
        kit.deps.bus?.publish('env.exec.finished', execution)
      }
      const stdout = headAndTail(r.stdout, 3000)
      const stderr = headAndTail(r.stderr, 1500)
      const longest = Math.max(stdout.cut ? r.stdout.length : 0, stderr.cut ? r.stderr.length : 0)
      return {
        output: {
          exitCode: r.exitCode,
          ...(r.timedOut ? { timedOut: true } : {}),
          durationMs: r.durationMs,
          stdout: stdout.text,
          stderr: stderr.text,
          ...(longest ? { note: cutNote(longest) } : {}),
          ...(started ? { started } : {}),
          // Started before environments mounted the employee's files: say so, or /files looks missing.
          ...(kit.deps.config.filesDir && !env.files
            ? {
                filesNote: `This environment was started before ${FILES_MOUNT} (your filesystem) was mounted in environments: env.down, then env.up, to get it.`,
              }
            : {}),
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
      name: 'env.screenshot',
      description:
        "See the desktop of this session's environment (env.up with desktop: true): saves a PNG of the whole screen to your files and returns its path. Look at it with image.view { path }.",
      effect: 'non_idempotent',
      params: {
        properties: {
          path: {
            type: 'string',
            description:
              'Where to save it in your files, e.g. /screenshots/login.png. Default: /screenshots/<environment>-<time>.png.',
          },
        },
      },
    },
    async (a, ctx) => {
      const session = await kit.ownSession(undefined, ctx)
      const env = envOf(session)
      if (!env) return fail('this session has no environment: call env.up with desktop: true first')
      if (!env.desktop) return fail('the environment has no desktop: env.down, then env.up with desktop: true')
      if (!runtime.screenshot) return fail('this deployment has no desktops')
      const path = str(a.path) ?? screenshotPath(env.name, ctx.clock.iso())
      if (!/\.png$/i.test(path)) return fail('path must end in .png')
      const output = await kit.once('env.screenshot', ctx, async () => {
        const png = Buffer.from(await runtime.screenshot!(env.id))
        const file = await kit.deps.files.write(ctx.employeeId, path, png.toString('base64'), {
          encoding: 'base64',
          mime: 'image/png',
          actor: kit.actor(ctx),
        })
        const size: Record<string, Json> = png.length >= 24 ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : {}
        return {
          path: file.path,
          bytes: png.length,
          ...size,
          envId: env.id,
          note: `Look at it with image.view { path: "${file.path}" }.`,
        }
      })
      return ok(output)
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
      kit.deps.bus?.publish('env.changed', { sessionId: session.id, envId: env.id, op: 'down' })
      return ok({ down: true, envId: env.id } as Json)
    },
  )
}
