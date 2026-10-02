import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Json } from '@mp/core'
import { DESKTOP_DISPLAY, egressEntryCovered, invalidExpose, type ContainerRuntime, type EnvSpec } from '@mp/containers'
import type { Session } from '@mp/sessions'
import type { ToolContext, ToolHandler } from '@mp/tools'
import { DEFAULT_ENV_PROFILES, describeProfiles, envProfile } from '../env-profiles.ts'
import { envOf, fail, ok, str, worktreesOf, type Kit, type WorktreeMeta } from '../kit.ts'
import { nodeWorktreeFs } from '../worktree-fs.ts'

/** One repository in an environment: a checkout of the session (writable, on its branch) or a read-only worktree of a ref. */
interface RepoMount {
  key: string
  projectId: string
  url: string
  hostPath: string
  /** /repos/<name>. */
  containerPath: string
  /** A checkout: the session's own branch. */
  branch?: string
  /** A read-only worktree: the ref asked for, and the commit it is at. */
  ref?: string
  sha?: string
  writable: boolean
}

/** Where each repository is in an environment: /repos/<repository name>, made unique (a ref's copy gets `<name>@<ref>`). */
function nameRepoMounts(list: Omit<RepoMount, 'containerPath'>[]): RepoMount[] {
  const used = new Set<string>()
  const clean = (x: string) => x.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '')
  return list.map((m) => {
    const base = clean(m.key.split('/').pop() || '') || 'repo'
    const first = used.has(base) && m.ref ? `${base}@${clean(m.ref) || 'ref'}` : base
    let name = first
    for (let n = 2; used.has(name); n++) name = `${first}-${n}`
    used.add(name)
    return { ...m, containerPath: `/repos/${name}` }
  })
}

/** What env.up lists for each repository of an environment. */
const repoView = (m: { containerPath: string; key: string; branch?: string; ref?: string; sha?: string; writable: boolean }) => ({
  path: m.containerPath,
  key: m.key,
  ...(m.branch ? { branch: m.branch } : {}),
  ...(m.ref ? { ref: m.ref, ...(m.sha ? { sha: m.sha.slice(0, 12) } : {}) } : {}),
  writable: m.writable,
})

/**
 * Lets git inside the container read a checkout whose metadata is owned by another user (the harness):
 * without it every git command there fails with "dubious ownership".
 */
const GIT_SAFE_ENV = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' }

/** One entry of env.up `repos`: a project id or a checkout's key, or `{ project, ref?, repo?, primary? }`. */
interface RepoRequest {
  target: string
  ref?: string
  repoIndex?: number
  primary: boolean
}

function parseRepoRequests(v: unknown): RepoRequest[] | string {
  if (!Array.isArray(v)) return 'repos must be a list of project ids, checkout keys or { project, ref } objects'
  const out: RepoRequest[] = []
  for (const item of v as unknown[]) {
    if (typeof item === 'string' && item.trim()) out.push({ target: item.trim(), primary: false })
    else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>
      const target = [o.project, o.projectId, o.key].find((x): x is string => typeof x === 'string' && !!x.trim())
      if (!target) return 'each entry of repos needs project (a project id or a checkout key)'
      if (o.ref !== undefined && (typeof o.ref !== 'string' || !o.ref.trim() || o.ref.trim().startsWith('-')))
        return `not a ref: ${JSON.stringify(o.ref)}`
      if (o.repo !== undefined && !(Number.isInteger(o.repo) && (o.repo as number) >= 0))
        return 'repo must be an index into the project repositories'
      out.push({
        target: target.trim(),
        ...(typeof o.ref === 'string' ? { ref: o.ref.trim() } : {}),
        ...(typeof o.repo === 'number' ? { repoIndex: o.repo } : {}),
        primary: o.primary === true,
      })
    } else return 'repos must be a list of project ids, checkout keys or { project, ref } objects'
  }
  if (!out.length) return 'repos is empty'
  if (out.filter((r) => r.primary).length > 1) return 'only one entry of repos can be primary'
  return out
}

/** Where the employee's own files are in an environment (when the deployment keeps them on disk). */
export const FILES_MOUNT = '/files'
const FILES_NOTE =
  '/files in an environment is your filesystem root (/files/a.zip is /a.zip for fs.* and chat attachments): copy a build output there to attach it or fs.share it.'

/** Told with every environment: what it holds, and what it doesn't. */
const ENV_NOTE =
  "A checkout is at /workspace and every repository of the environment at /repos/<name> (repos says which: your checkouts are writable, a ref's copy is read-only). Read-only git works inside (git log, show, diff, grep, status, branch -a): the history is mounted read-only. Commit and push only with the git.* tools: git commit inside fails."

/** Added to env.up's note when the environment has no network. */
const NO_NETWORK_NOTE = 'It has no network: nothing can be installed, so pick an image that already has the tools you need.'
/** Added when it has one. */
const NETWORK_NOTE =
  'It has network: install what the work needs (npm install, pip install), tools outside the checkout (e.g. in /tmp).'

import { DIRECT_NOTE, PROXY_NOTE, directNetworkName, networkFor, type NetworkDecision } from '../network.ts'
import { mirrorKey } from '@mp/git'
import { checkoutRepo, refWorktree, worktreeFor } from './git.ts'

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
      defaultNetwork: kit.deps.config.defaultNetwork,
    })
    return { net, emp, projectId: pid, project }
  }

  /** env.up's handler, so env.exec can start the default environment by itself. */
  let upEnv: ToolHandler = async () => fail('env.up is not ready')

  /** A requested repository, identified without changing anything: an existing checkout, one to make, or a ref's copy. */
  type Identified =
    | { kind: 'checkout'; w: WorktreeMeta; id: string; primary: boolean }
    | { kind: 'new' | 'ref'; projectId: string; repoIndex: number; key: string; ref?: string; id: string; primary: boolean }
  const identify = async (session: Session, req: RepoRequest): Promise<Identified | string> => {
    const w = worktreesOf(session).find(
      (x) =>
        x.key === req.target ||
        x.url === req.target ||
        (x.projectId === req.target && (req.repoIndex === undefined || x.repoIndex === req.repoIndex)),
    )
    if (w && !req.ref) return { kind: 'checkout', w, id: w.key, primary: req.primary }
    const projectId = w?.projectId ?? req.target
    const repoIndex = w?.repoIndex ?? req.repoIndex ?? 0
    const project = await kit.deps.directory.projects.get(projectId)
    if (!project)
      return `no project or checkout ${req.target}: give a project id (directory.find_project) or the key of one of your checkouts`
    const repo = project.data.repositories?.[repoIndex]
    if (!repo) return `project ${project.data.name} has no repository #${repoIndex}`
    const key = mirrorKey(repo.url)
    const existing = worktreesOf(session).find((x) => x.key === key)
    if (!req.ref && existing) return { kind: 'checkout', w: existing, id: key, primary: req.primary }
    return req.ref
      ? { kind: 'ref', projectId: project.id, repoIndex, key, ref: req.ref, id: `${key}@${req.ref}`, primary: req.primary }
      : { kind: 'new', projectId: project.id, repoIndex, key, id: key, primary: req.primary }
  }

  /** The repositories in a running environment, as identities (`key`, or `key@ref` for a ref's copy). */
  const mountedIds = (checkouts: { key: string; path: string; ref?: string }[] | undefined) =>
    new Set((checkouts ?? []).map((c) => (c.ref ? `${c.key}@${c.ref}` : c.key)))

  /** The exact env.up call that restarts an environment with these repositories. */
  const restartCall = (a: Record<string, unknown>) => `env.up ${JSON.stringify({ ...a, restart: true })}`

  kit.tool(
    {
      name: 'env.up',
      description:
        "Start this session's environment (containers on a private network) to explore, build, test or run code. Each repository is at /repos/<name>, one also at /workspace (the working directory). repos: projects to bring up together; a project id checks it out first if needed (your own writable branch, like git.checkout); { project, ref } mounts a read-only copy of a branch or commit. Without repos: every checkout of this session. Read-only git works inside (log, show, diff, grep); commit and push only with the git.* tools. /files is your filesystem root: copy what you build there to attach or share it. One environment per session: calling it again returns the running one; restart: true restarts it to add repositories or change its image (files outside the repositories and /files are lost). The result says its network (via proxy to allowed hosts, direct, or none): with network install what the work needs; without it nothing installs, so pick the profile with your tools. expose ports (listening on 0.0.0.0) to let people watch a dev server live (env.preview); desktop: true for GUI programs (env.screenshot).",
      effect: 'idempotent',
      params: {
        properties: {
          profile: {
            type: 'string',
            description: `A ready-made toolkit to work in, by name (the usual choice): ${describeProfiles(kit.deps.config.envProfiles ?? DEFAULT_ENV_PROFILES)}. Without network nothing can be installed, so pick the one with the tools you need. Default: the project's profile, else ${kit.deps.config.envDefaultProfile ?? 'default'} (the checkout's Dockerfile only with build: true).`,
          },
          image: {
            type: 'string',
            description: 'Any other image instead of a profile, e.g. node:22 or python:3.13.',
          },
          build: {
            type: 'boolean',
            description: "Build the checkout's Dockerfile instead (usually the app's production image, not a place to work).",
          },
          dockerfile: { type: 'string', description: 'Dockerfile path in the checkout, to build (implies build).' },
          repos: {
            type: 'array',
            description:
              'Repositories to bring up together, each at /repos/<name>: { project } or a plain project id; with ref, a read-only copy of that branch or commit. Your other checkouts are mounted as well.',
            items: {
              type: 'object',
              properties: {
                project: { type: 'string', description: 'A project id, or the key of one of your checkouts.' },
                ref: { type: 'string', description: 'A branch or commit, mounted read-only.' },
                repo: { type: 'number', description: "Index into the project's repositories. Default 0." },
                primary: { type: 'boolean', description: 'This one goes at /workspace.' },
              },
              required: ['project'],
            },
          },
          repo: {
            type: 'string',
            description:
              'Without repos: the checkout at /workspace, by key (e.g. gitlab.com/group/repo) or project id. Default: the most recent.',
          },
          restart: {
            type: 'boolean',
            description: 'Restart a running environment (to add repositories: mounts are fixed while it runs).',
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
            description: 'Narrow the allowed hosts to these. Default: all of them.',
          },
          expose: {
            type: 'array',
            items: { type: 'number' },
            description: 'Ports your app serves, e.g. [5173], shown to people as live previews (env.preview).',
          },
          desktop: {
            type: 'boolean',
            description: 'A virtual screen (1440x900, DISPLAY=:99) for GUI programs and headed browsers; people watch it live.',
          },
        },
      },
    },
    (upEnv = async (a, ctx) => {
      let session = await kit.ownSession(undefined, ctx)
      if (a.restart !== undefined && typeof a.restart !== 'boolean') return fail('restart must be true or false')
      // What was asked for, identified before anything changes.
      const requests = a.repos === undefined ? null : parseRepoRequests(a.repos)
      if (typeof requests === 'string') return fail(requests)
      const wanted: Identified[] = []
      for (const r of requests ?? []) {
        const id = await identify(session, r)
        if (typeof id === 'string') return fail(id)
        if (!wanted.some((x) => x.id === id.id)) wanted.push(id)
      }
      let restarted: string | undefined
      const current = envOf(session)
      if (current) {
        const info = await runtime.getEnv(current.id)
        const missing = wanted.filter((x) => !mountedIds(current.checkouts).has(x.id)).map((x) => x.id)
        if (info?.status === 'running' && a.restart !== true) {
          const exposed = exposedOf(current)
          // Running environments keep the network they started with.
          const started = current.networkKey
          const changed =
            typeof started === 'string' && started !== networkKey((await decideNetwork(session, ctx, current.projectId)).net)
          const notes = [
            ...(missing.length
              ? [
                  `the environment is already running without ${missing.join(', ')}: mounts can't be added to a running environment. To restart it with them (files outside the repositories and /files are lost), call ${restartCall(a)}`,
                ]
              : []),
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
            ...(current.checkouts?.length
              ? {
                  repos: current.checkouts
                    .filter((c) => c.path !== '/workspace')
                    .map((c) => ({ path: c.path, key: c.key, ...(c.ref ? { ref: c.ref } : {}), writable: c.writable !== false })),
                }
              : {}),
            ...(missing.length ? { missing } : {}),
            ...(current.network ? { network: current.network } : {}),
            ...(exposed.length ? { previews: exposed.map((port) => ({ port, url: previewLink(session.id, port) })) } : {}),
            ...(current.desktop ? { desktop: desktopOf(session.id) } : {}),
            ...(notes.length ? { note: notes.join('; ') } : {}),
          })
        }
        if (info?.status === 'running' && a.restart === true) {
          await runtime.destroyEnv(current.id)
          await kit.patchMeta(session.id, (m) => {
            delete m.env
            return m
          })
          kit.deps.bus?.publish('env.changed', { sessionId: session.id, envId: current.id, op: 'down' })
          restarted = missing.length
            ? `The environment was restarted to add ${missing.join(', ')}: anything outside the repositories and /files is gone.`
            : 'The environment was restarted: anything outside the repositories and /files is gone.'
        }
      }
      const badExpose = invalidExpose(a.expose)
      if (badExpose.length) return fail('expose must be a list of distinct ports (1-65535)', { issues: badExpose })
      const expose = (a.expose as number[] | undefined) ?? []
      if (a.desktop !== undefined && typeof a.desktop !== 'boolean') return fail('desktop must be true or false')
      const desktop = a.desktop === true
      if (desktop && (!runtime.screenshot || !(await runtime.features?.())?.desktop))
        return fail('this deployment has no desktops: its container runtime cannot run one')
      if (wanted.some((x) => x.kind !== 'checkout') && !kit.deps.git)
        return fail('this deployment has no git: only existing checkouts can be mounted')

      // Which repository goes at /workspace: the primary one, else the first asked for; without repos, the
      // checkout named by repo, else the most recent one.
      const all = worktreesOf(session)
      const primary = wanted.find((x) => x.primary) ?? wanted[0]
      let fallbackNote: string | undefined
      let chosen: WorktreeMeta | null = null
      if (!primary && all.length) {
        if (str(a.repo)) chosen = worktreeFor(session, str(a.repo))
        else {
          chosen = all.at(-1)!
          if (all.length > 1)
            fallbackNote = `/workspace is ${chosen.key}, your most recent checkout: pass repo (or repos with primary) to choose another.`
        }
      }
      if (!str(a.image) && !str(a.profile) && !primary && !chosen)
        return fail('give an image or a profile, or check out a repository first (git.checkout, or env.up with repos)')

      // The employee's network setting with the project, or the deployment default. The model can
      // only narrow it: a direct network to proxied hosts, proxied hosts to fewer. Never to direct.
      const workspaceProject = primary
        ? primary.kind === 'checkout'
          ? primary.w.projectId
          : primary.projectId
        : chosen?.projectId
      const { net, emp, projectId, project } = await decideNetwork(session, ctx, workspaceProject)

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

      // Make what isn't there yet: checkouts of the repositories asked for, read-only worktrees of refs.
      const fs = kit.deps.worktreeFs ?? nodeWorktreeFs()
      const made: Omit<RepoMount, 'containerPath'>[] = []
      let workspaceIndex = -1
      for (const x of wanted) {
        if (x === primary) workspaceIndex = made.length
        if (x.kind === 'checkout') {
          made.push({
            key: x.w.key,
            projectId: x.w.projectId,
            url: x.w.url,
            hostPath: x.w.path,
            branch: x.w.branch,
            writable: true,
          })
        } else if (x.kind === 'new') {
          const r = await checkoutRepo(kit, kit.deps.git!, fs, ctx, { projectId: x.projectId, repoIndex: x.repoIndex })
          if ('failure' in r) return r.failure
          made.push({
            key: r.w.key,
            projectId: r.w.projectId,
            url: r.w.url,
            hostPath: r.w.path,
            branch: r.w.branch,
            writable: true,
          })
        } else {
          const r = await refWorktree(kit, kit.deps.git!, ctx, { projectId: x.projectId, repoIndex: x.repoIndex, ref: x.ref! })
          if ('failure' in r) return r.failure
          made.push({
            key: r.r.key,
            projectId: r.r.projectId,
            url: r.r.url,
            hostPath: r.r.path,
            ref: r.r.ref,
            sha: r.r.sha,
            writable: false,
          })
        }
      }
      // Every other checkout of the session is there too: one environment works across them.
      session = await kit.ownSession(undefined, ctx)
      for (const w of worktreesOf(session)) {
        if (made.some((m) => !m.ref && m.key === w.key)) continue
        if (chosen && w.key === chosen.key) workspaceIndex = made.length
        made.push({ key: w.key, projectId: w.projectId, url: w.url, hostPath: w.path, branch: w.branch, writable: true })
      }
      const repoMounts = nameRepoMounts(made)
      const workspace = workspaceIndex >= 0 ? repoMounts[workspaceIndex]! : null

      // A repository's Dockerfile is usually its production image, not a place to work: build it only when asked
      // (build: true or a dockerfile path). Live, an environment for reading code built a failing app image.
      if (!image && !str(a.dockerfile) && a.build !== true) {
        const p = envProfile(profiles, kit.deps.config.envDefaultProfile ?? 'default') ?? profiles[0]
        if (p) {
          image = p.image
          profile = p.name
        }
      }
      if (!image && !workspace) return fail('nothing to build: give an image or a profile')

      const network: Json = direct
        ? { via: 'direct', note: DIRECT_NOTE }
        : egress
          ? { via: 'proxy', allow: egress.allow, note: PROXY_NOTE }
          : { via: 'none', reason: net.reason ?? 'no network: env.up was asked for no hosts' }

      // Each worktree's .git points into its mirror: mounted read-only at the same path, git log, show, diff,
      // grep and status work inside, and nothing can be committed there (that goes through git.*, with its rules).
      const mirrors = [
        ...new Set(
          repoMounts.flatMap((m) => {
            try {
              const dir = kit.deps.git?.mirrorPath(m.url)
              return dir && isAbsolute(dir) && !dir.includes(':') ? [dir] : []
            } catch {
              return []
            }
          }),
        ),
      ]
      // The employee's own files, at /files: builds can leave their results there for fs.* and chat.
      const filesRoot = kit.deps.config.filesDir
      const ownFiles = filesRoot && /^[A-Za-z0-9_-]+$/.test(ctx.employeeId) ? resolve(filesRoot, ctx.employeeId) : null
      if (ownFiles) await mkdir(ownFiles, { recursive: true })
      const mounts = [
        ...(workspace
          ? [
              { hostPath: workspace.hostPath, containerPath: '/workspace', ...(workspace.writable ? {} : { readOnly: true }) },
              ...repoMounts.map((m) => ({
                hostPath: m.hostPath,
                containerPath: m.containerPath,
                ...(m.writable ? {} : { readOnly: true }),
              })),
              ...mirrors.map((dir) => ({ hostPath: dir, containerPath: dir, readOnly: true })),
            ]
          : []),
        ...(ownFiles ? [{ hostPath: ownFiles, containerPath: FILES_MOUNT }] : []),
      ]
      const envVars = {
        ...(workspace ? GIT_SAFE_ENV : {}),
        ...(a.env ? Object.fromEntries(Object.entries(a.env).map(([k, v]) => [k, String(v)])) : {}),
      }
      const spec: EnvSpec = {
        name: envNameFor(emp.key ?? emp.data.name, session.data.slug || session.id),
        ...(image
          ? { image }
          : { build: { context: workspace!.hostPath, ...(str(a.dockerfile) ? { dockerfile: a.dockerfile } : {}) } }),
        ...(mounts.length ? { mounts } : {}),
        ...(workspace ? { workdir: '/workspace' } : {}),
        ...(Object.keys(envVars).length ? { env: envVars } : {}),
        ...(a.services ? { services: a.services } : {}),
        ...(egress ? { egress } : {}),
        ...(direct ? { direct: { network: directNetworkName(emp.key ?? emp.data.name) } } : {}),
        ...(expose.length ? { expose } : {}),
        ...(desktop ? { desktop: {} } : {}),
        labels: { 'mp.session': session.id, 'mp.employee': ctx.employeeId },
      }
      const info = await runtime.createEnv(spec)
      const checkoutOf = (m: RepoMount, path: string) => ({
        key: m.key,
        path,
        ...(m.ref ? { ref: m.ref } : {}),
        ...(m.writable ? {} : { writable: false }),
      })
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
          ...(workspace
            ? { checkouts: [checkoutOf(workspace, '/workspace'), ...repoMounts.map((r) => checkoutOf(r, r.containerPath))] }
            : {}),
          ...(a.services ? { services: (a.services as { name: unknown }[]).map((x) => String(x.name)) } : {}),
        },
      }))
      kit.deps.bus?.publish('env.changed', { sessionId: session.id, envId: info.id, op: 'up' })
      return ok({
        envId: info.id,
        name: info.name,
        status: info.status,
        ...(restarted ? { restarted: true } : {}),
        ...(workspace ? { workspace: '/workspace', checkout: workspace.key, workspaceIs: workspace.containerPath } : {}),
        ...(image ? { image } : {}),
        ...(profile ? { profile } : {}),
        ...(repoMounts.length ? { repos: repoMounts.map(repoView) } : {}),
        network,
        ...(expose.length ? { previews: expose.map((port) => ({ port, url: previewLink(session.id, port) })) } : {}),
        ...(desktop ? { desktop: desktopOf(session.id) } : {}),
        ...(ownFiles ? { files: FILES_MOUNT } : {}),
        note: [
          ...(restarted ? [restarted] : []),
          ...(fallbackNote ? [fallbackNote] : []),
          ...(workspace ? [ENV_NOTE] : []),
          net.direct || net.allow.length ? NETWORK_NOTE : NO_NETWORK_NOTE,
          ...(ownFiles ? [FILES_NOTE] : []),
        ].join(' '),
      })
    }),
  )

  kit.tool(
    {
      name: 'env.exec',
      description:
        'Run a command in this session\'s environment, in /workspace (/files in it is your filesystem root: /files/a.zip is /a.zip for fs.* and chat attachments). Without one it starts the default environment first (your checkout, in the project\'s profile or the default profile): use env.up yourself to pick a profile, image or ports. An argv list, e.g. ["npm", "test"]; for pipes and globs use ["sh", "-c", "grep -rn router src | wc -l"]. Returns the exit code and the end of stdout/stderr. Default timeout 300 s. Install tools the work needs (a browser, a linter) outside the checkout, e.g. in /tmp: only the project\'s own dependencies belong in it.',
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
