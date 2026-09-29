import { createHash } from 'node:crypto'
import type { Json } from '@mp/core'
import { egressEntryCovered, type ContainerRuntime, type EnvSpec } from '@mp/containers'
import { envOf, fail, ok, str, worktreesOf, type Kit } from '../kit.ts'
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

/** Keeps the end of long output, which is usually where the error is. */
const tail = (text: string, max = 8000) =>
  text.length <= max ? text : `[… ${text.length - max} earlier characters truncated]\n${text.slice(-max)}`

export function registerEnvTools(kit: Kit, runtime: ContainerRuntime): void {
  kit.tool(
    {
      name: 'env.up',
      description:
        "Start this session's isolated environment (containers on a private network) with your checkout mounted at /workspace: from an image, or built from the checkout's Dockerfile. Network access goes only through a proxy (HTTP_PROXY/HTTPS_PROXY) that allows the project's egress allowlist; without one there is no network. Calling it again returns the running one. Use env.exec to build, test or run.",
      effect: 'idempotent',
      params: {
        properties: {
          image: { type: 'string', description: 'Image to run. Default: build the checkout.' },
          dockerfile: { type: 'string', description: 'Dockerfile path in the checkout, when building.' },
          repo: { type: 'string', description: 'Which checkout to mount/build (key or project id).' },
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
            description: "Narrow the project's egress allowlist to these hosts (a subset of it). Default: the whole list.",
          },
        },
      },
    },
    async (a, ctx) => {
      const session = await kit.ownSession(undefined, ctx)
      const current = envOf(session)
      if (current) {
        const info = await runtime.getEnv(current.id)
        if (info?.status === 'running') return ok({ envId: info.id, name: info.name, status: info.status, existing: true })
      }
      const w = worktreesOf(session).length ? worktreeFor(session, str(a.repo)) : null
      if (!str(a.image) && !w) return fail('give an image, or check out a repository first (git.checkout) to build it')

      // Egress: the checkout's project (else the session's first linked project) sets the allowlist.
      const projectId = w?.projectId ?? (await kit.projectsOf(session))[0]
      const project = projectId ? await kit.deps.directory.projects.get(projectId) : null
      const projectAllow = project?.data.egress?.allow
      let egress: EnvSpec['egress']
      if (a.egress !== undefined) {
        if (!Array.isArray(a.egress)) return fail('egress must be a list of hosts')
        const requested = (a.egress as unknown[]).map(String)
        const wider = requested.filter((e) => !projectAllow || !egressEntryCovered(e, projectAllow))
        if (wider.length)
          return fail(
            projectAllow
              ? "egress can only narrow the project's allowlist"
              : 'the project has no egress allowlist, so there is no network to narrow',
            { notAllowed: wider },
          )
        if (projectAllow) egress = { allow: requested }
      } else if (projectAllow) egress = { allow: [...projectAllow] }

      const emp = await kit.employee(ctx.employeeId)
      const spec: EnvSpec = {
        name: envNameFor(emp.key ?? emp.data.name, session.data.slug || session.id),
        ...(str(a.image)
          ? { image: a.image }
          : { build: { context: w!.path, ...(str(a.dockerfile) ? { dockerfile: a.dockerfile } : {}) } }),
        ...(w ? { mounts: [{ hostPath: w.path, containerPath: '/workspace' }], workdir: '/workspace' } : {}),
        ...(a.env ? { env: Object.fromEntries(Object.entries(a.env).map(([k, v]) => [k, String(v)])) } : {}),
        ...(a.services ? { services: a.services } : {}),
        ...(egress ? { egress } : {}),
        labels: { 'mp.session': session.id, 'mp.employee': ctx.employeeId },
      }
      const info = await runtime.createEnv(spec)
      await kit.patchMeta(session.id, (m) => ({ ...m, env: { id: info.id, name: info.name } }))
      return ok({
        envId: info.id,
        name: info.name,
        status: info.status,
        ...(w ? { workspace: '/workspace' } : {}),
        network: egress ? { via: 'proxy', allow: egress.allow } : 'none',
      })
    },
  )

  kit.tool(
    {
      name: 'env.exec',
      description:
        'Run a command in this session\'s environment (argv list, e.g. ["npm", "test"]), in /workspace. Returns the exit code and the end of stdout/stderr. Default timeout 300 s.',
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
      const session = await kit.ownSession(undefined, ctx)
      const env = envOf(session)
      if (!env) return fail('no environment yet: call env.up first')
      const cmd = (a.cmd as unknown[]).map(String)
      if (!cmd.length) return fail('cmd is empty')
      const timeoutMs = Math.min(Math.max(1, a.timeoutSeconds ?? 300), 3600) * 1000
      const r = await runtime.exec(env.id, cmd, {
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
