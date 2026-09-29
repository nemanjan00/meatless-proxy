import { createHash, randomBytes } from 'node:crypto'
import { type Clock, type EventBus, errorMessage, isMpError, type KindSchema, type Logger } from '@mp/core'
import type { Directory, Employee } from '@mp/directory'
import {
  createGitlabClient,
  createGitlabHooks,
  DEFAULT_BASE_URL,
  gitlabProjectPath,
  HOOK_EVENTS,
  type EnsureHookResult,
} from '@mp/integration-gitlab'
import type { Records } from '@mp/records'
import type { SecretStore } from '@mp/secrets'
import type { StoredRecord } from '@mp/store'
import type { Services } from '../services.ts'
import type { IntegrationsOptions } from './index.ts'

/**
 * GitLab webhook self-provisioning (docs/spec.md#integrations, "Webhooks set themselves up").
 *
 * For every employee with GitLab set up (its `GITLAB_TOKEN` resolves), the harness registers one
 * project hook per GitLab repository the employee works on, at `<PUBLIC_URL>/webhooks/gitlab/<employee id>`,
 * with the events the integration handles and the employee's `GITLAB_WEBHOOK_SECRET` (generated
 * when missing). It repairs drift and never duplicates. The status of each hook is a `gitlab_hook` record.
 *
 * **Which repositories** (the rule): the repositories of every project
 * 1. its AI contact is linked to (any role: owner, backup, member, reviewer, …),
 * 2. one of its sessions is linked to with `works_on`,
 * 3. and, when it is the deployment's only employee, every project.
 * A repository counts when its `url` is on the employee's GitLab (`GITLAB_BASE_URL`, or gitlab.com).
 * Hooks of repositories that drop out of the set are removed.
 */

/** The record kind holding each hook's status, keyed `<employee id>:<gitlab project path>`. */
export const GITLAB_HOOK_KIND = 'gitlab_hook'
/** A deployment-wide token (Maintainer or group Owner) used only to register hooks. */
export const HOOKS_TOKEN_SECRET = 'GITLAB_HOOKS_TOKEN'
const TOKEN_SECRET = 'GITLAB_TOKEN'
const WEBHOOK_SECRET = 'GITLAB_WEBHOOK_SECRET'
const BASE_URL_SECRET = 'GITLAB_BASE_URL'
/** Secrets whose change re-runs provisioning. */
export const PROVISIONING_SECRETS = [TOKEN_SECRET, HOOKS_TOKEN_SECRET, WEBHOOK_SECRET, BASE_URL_SECRET]
/** Quiet time after a change before provisioning runs. */
export const PROVISIONING_DEBOUNCE_MS = 2000
/** The slow repair pass. */
export const PROVISIONING_REPAIR_MS = 6 * 60 * 60 * 1000

export const gitlabHookSchema: KindSchema = {
  kind: GITLAB_HOOK_KIND,
  prefix: 'glh',
  description: 'A GitLab project webhook the harness registered for an employee, and how the last attempt went.',
  core: [
    { name: 'employeeId', type: 'ref', ref: 'employee', required: true },
    { name: 'gitlabProject', type: 'string', required: true, description: 'The GitLab project path, e.g. acme/billing.' },
    { name: 'repository', type: 'string', description: 'The repository URL it came from.' },
    { name: 'projectIds', type: 'list', of: { type: 'string' }, description: 'The harness projects with this repository.' },
    { name: 'url', type: 'string', description: 'The hook URL.' },
    { name: 'hookId', type: 'number' },
    { name: 'tokenVersion', type: 'string', description: 'A hash of the secret token last set on the hook.' },
    { name: 'status', type: 'enum', values: ['ok', 'error'], required: true },
    { name: 'error', type: 'text' },
    { name: 'lastAction', type: 'string', description: 'created, updated, unchanged or removed.' },
    { name: 'lastAttemptAt', type: 'timestamp', required: true },
    { name: 'lastOkAt', type: 'timestamp' },
  ],
}

export interface GitlabHookData extends Record<string, unknown> {
  employeeId: string
  gitlabProject: string
  repository?: string
  projectIds?: string[]
  url?: string
  hookId?: number
  tokenVersion?: string
  status: 'ok' | 'error'
  error?: string
  lastAction?: string
  lastAttemptAt: string
  lastOkAt?: string
}

export interface ProvisioningDeps {
  records: Records
  directory: Directory
  secrets: SecretStore
  bus: EventBus
  clock: Clock
  logger: Logger
  /** `PUBLIC_URL`. Without it provisioning is off. */
  publicUrl: string | undefined
  /** The deployment's GitLab URL (`GITLAB_BASE_URL`); a secret of that name overrides it. */
  baseUrl?: string
  fetch?: typeof fetch
}

export interface ProvisioningOptions {
  debounceMs?: number
  repairEveryMs?: number
  /** GitLab client retries (tests). */
  retry?: { maxRetries?: number; retryBaseMs?: number; retryMaxMs?: number; timeoutMs?: number }
}

/** One employee's pass. */
export interface ProvisioningResult {
  employeeId: string
  outcome: 'off' | 'not_set_up' | 'done' | 'failed'
  reason?: string
  hooks: StoredRecord<GitlabHookData>[]
}

export interface HookProvisioning {
  /** False without `PUBLIC_URL`; `reason` says why. */
  readonly enabled: boolean
  readonly reason: string | undefined
  /** Subscribes to changes, starts the repair schedule and schedules a pass for every employee. */
  start(): void
  /** Schedules a debounced pass for one employee, or for all. */
  schedule(employeeId?: string): void
  /** Runs one employee's pass now (serialized with its other passes). */
  run(employeeId: string): Promise<ProvisioningResult>
  /** Resolves when nothing is scheduled or running. */
  idle(): Promise<void>
  /** When the last pass finished. */
  lastRunAt(): string | null
  close(): Promise<void>
}

/** A short hash of a webhook secret, to tell when the one set on a hook is out of date. */
export const tokenVersionOf = (secret: string) =>
  createHash('sha256').update(`mp-gitlab-hook\0${secret}`).digest('hex').slice(0, 16)

/** The hook URL of an employee. */
export const employeeHookUrl = (publicUrl: string, employeeId: string) =>
  `${publicUrl.replace(/\/+$/, '')}/webhooks/gitlab/${employeeId}`

/** A message a person can act on. GitLab's own text is kept for everything else. */
export function hookErrorMessage(err: unknown, project: string): string {
  const status = isMpError(err) ? (err.details?.status as number | undefined) : undefined
  if (status === 403)
    return `the token needs Maintainer on ${project} to register webhooks; set ${HOOKS_TOKEN_SECRET} (a Maintainer or group Owner) or give the service account Maintainer`
  if (status === 401) return `GitLab rejected the token (401): check ${HOOKS_TOKEN_SECRET} or the employee's ${TOKEN_SECRET}`
  if (status === 404) return `GitLab project ${project} was not found, or the token can't see it (404)`
  return errorMessage(err)
}

/** Defines the `gitlab_hook` kind (idempotent). */
export function defineGitlabHookKind(records: Records) {
  if (!records.kinds.has(GITLAB_HOOK_KIND)) records.kinds.define(gitlabHookSchema)
}

export function createHookProvisioning(deps: ProvisioningDeps, opts: ProvisioningOptions = {}): HookProvisioning {
  const log = deps.logger.child({ component: 'gitlab-hooks' })
  const debounceMs = opts.debounceMs ?? PROVISIONING_DEBOUNCE_MS
  const repairEveryMs = opts.repairEveryMs ?? PROVISIONING_REPAIR_MS
  const publicUrl = deps.publicUrl?.replace(/\/+$/, '') || undefined
  const reason = publicUrl
    ? undefined
    : 'PUBLIC_URL is not set: GitLab needs the address it can reach the harness at, so webhook provisioning is off'
  defineGitlabHookKind(deps.records)

  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const chains = new Map<string, Promise<ProvisioningResult>>()
  const background = new Set<Promise<unknown>>()
  /** Employees whose webhook secret this module just generated: that change needs no new pass. */
  const selfWritten = new Set<string>()
  /** Repository URLs per project, to tell a repository change from other project edits. */
  const repoSignatures = new Map<string, string>()
  const offs: (() => void)[] = []
  let interval: ReturnType<typeof setInterval> | undefined
  let closed = false
  let started = false
  let last: string | null = null

  const track = <T>(p: Promise<T>) => {
    const t = p.catch((err) => log.error('webhook provisioning failed', { err: errorMessage(err) }))
    background.add(t)
    void t.finally(() => background.delete(t))
    return p
  }

  // ── Which projects and repositories ─────────────────────────────────────
  const sessionEmployee = new Map<string, string | null>()
  const employeeOfSession = async (id: string) => {
    if (!sessionEmployee.has(id)) {
      const s = await deps.records.get<{ employeeId?: string }>('session', id)
      sessionEmployee.set(id, s?.data.employeeId ?? null)
    }
    return sessionEmployee.get(id)!
  }

  const projectIdsFor = async (employee: Employee): Promise<Set<string>> => {
    const ids = new Set<string>()
    for (const m of await deps.directory.projects.forContact(employee.data.contactId)) ids.add(m.project.id)
    for (const l of await deps.records.links({ from: { kind: 'session' }, to: { kind: 'project' }, role: 'works_on' }))
      if ((await employeeOfSession(l.from.id)) === employee.id) ids.add(l.to.id)
    const { total } = await deps.directory.employees.list({ limit: 1 })
    if (total === 1) for (const p of (await deps.directory.projects.list()).items) ids.add(p.id)
    return ids
  }

  const reposFor = async (employee: Employee, baseUrl: string) => {
    const wanted = new Map<string, { repository: string; projectIds: string[] }>()
    for (const id of await projectIdsFor(employee)) {
      const project = await deps.directory.projects.get(id)
      for (const r of project?.data.repositories ?? []) {
        const path = gitlabProjectPath(r.url, baseUrl)
        if (!path) continue
        const hit = wanted.get(path)
        if (hit) hit.projectIds.push(id)
        else wanted.set(path, { repository: r.url, projectIds: [id] })
      }
    }
    return wanted
  }

  // ── Secrets ─────────────────────────────────────────────────────────────
  const ensureWebhookSecret = async (employeeId: string) => {
    const own = (await deps.secrets.list()).some(
      (m) => m.name === WEBHOOK_SECRET && m.scope.type === 'employee' && m.scope.id === employeeId,
    )
    if (!own) {
      selfWritten.add(employeeId)
      await deps.secrets.set(
        WEBHOOK_SECRET,
        randomBytes(32).toString('base64url'),
        { type: 'employee', id: employeeId },
        'system',
      )
      log.info('generated the GitLab webhook secret', { employeeId })
    }
    return (await deps.secrets.resolve([WEBHOOK_SECRET], { employeeId }))[WEBHOOK_SECRET]!
  }

  // ── One employee's pass ─────────────────────────────────────────────────
  const saveStatus = async (existing: StoredRecord<GitlabHookData> | null, key: string, data: GitlabHookData) => {
    if (existing) return deps.records.update<GitlabHookData>(GITLAB_HOOK_KIND, existing.id, data, { replace: true })
    return deps.records.create<GitlabHookData>(GITLAB_HOOK_KIND, data, { key })
  }

  const pass = async (employeeId: string): Promise<ProvisioningResult> => {
    if (!publicUrl) return { employeeId, outcome: 'off', reason: reason!, hooks: [] }
    const employee = await deps.directory.employees.get(employeeId)
    if (!employee) return { employeeId, outcome: 'not_set_up', reason: 'no such employee', hooks: [] }
    const values = await deps.secrets.resolve([TOKEN_SECRET, HOOKS_TOKEN_SECRET, BASE_URL_SECRET], { employeeId })
    if (!values[TOKEN_SECRET])
      return { employeeId, outcome: 'not_set_up', reason: `${TOKEN_SECRET} is not set for this employee`, hooks: [] }
    const baseUrl = values[BASE_URL_SECRET] || deps.baseUrl || DEFAULT_BASE_URL
    const secret = await ensureWebhookSecret(employeeId)
    const version = tokenVersionOf(secret)
    const url = employeeHookUrl(publicUrl, employeeId)
    const client = createGitlabClient({
      baseUrl,
      token: values[HOOKS_TOKEN_SECRET] || values[TOKEN_SECRET]!,
      logger: log,
      clock: deps.clock,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...opts.retry,
    })
    const hooks = createGitlabHooks(client)
    const wanted = await reposFor(employee, baseUrl)
    const existing = new Map(
      (await deps.records.query<GitlabHookData>(GITLAB_HOOK_KIND, { where: { employeeId } })).items.map((r) => [
        r.data.gitlabProject,
        r,
      ]),
    )
    const out: StoredRecord<GitlabHookData>[] = []

    for (const [path, repo] of wanted) {
      const rec = existing.get(path) ?? null
      const now = deps.clock.iso()
      const base: GitlabHookData = {
        employeeId,
        gitlabProject: path,
        repository: repo.repository,
        projectIds: repo.projectIds,
        url,
        status: 'ok',
        lastAttemptAt: now,
        ...(rec?.data.hookId !== undefined ? { hookId: rec.data.hookId } : {}),
        ...(rec?.data.tokenVersion ? { tokenVersion: rec.data.tokenVersion } : {}),
        ...(rec?.data.lastOkAt ? { lastOkAt: rec.data.lastOkAt } : {}),
      }
      try {
        // PUBLIC_URL (or the id scheme) changed: the old hook goes first.
        if (rec?.data.url && rec.data.url !== url) await hooks.removeProjectHook(path, { url: rec.data.url })
        const known = rec && rec.data.url === url && rec.data.tokenVersion === version ? rec.data.hookId : undefined
        const r: EnsureHookResult = await hooks.ensureProjectHook(path, {
          url,
          token: secret,
          events: HOOK_EVENTS,
          ...(known !== undefined ? { tokenKnownFor: known } : {}),
        })
        if (r.action !== 'unchanged' || r.removedDuplicates.length)
          log.info('gitlab hook provisioned', {
            employeeId,
            project: path,
            action: r.action,
            changed: r.changed,
            removedDuplicates: r.removedDuplicates,
          })
        out.push(
          await saveStatus(rec, `${employeeId}:${path}`, {
            ...base,
            hookId: r.hook.id,
            tokenVersion: version,
            lastAction: r.action,
            lastOkAt: now,
          }),
        )
      } catch (err) {
        const error = hookErrorMessage(err, path)
        log.warn('gitlab hook could not be provisioned', { employeeId, project: path, error })
        out.push(await saveStatus(rec, `${employeeId}:${path}`, { ...base, status: 'error', error, lastAction: 'failed' }))
      }
    }

    // Repositories no longer worked on: remove their hooks.
    for (const [path, rec] of existing) {
      if (wanted.has(path)) continue
      try {
        await hooks.removeProjectHook(path, rec.data.hookId ?? { url: rec.data.url ?? url })
        await deps.records.delete(GITLAB_HOOK_KIND, rec.id)
        log.info('gitlab hook removed: the repository is no longer linked', { employeeId, project: path })
      } catch (err) {
        const error = `no longer linked, and the hook could not be removed: ${hookErrorMessage(err, path)}`
        out.push(
          await saveStatus(rec, rec.key ?? `${employeeId}:${path}`, {
            ...rec.data,
            status: 'error',
            error,
            lastAction: 'failed',
            lastAttemptAt: deps.clock.iso(),
          }),
        )
      }
    }
    return { employeeId, outcome: 'done', hooks: out }
  }

  const run = (employeeId: string): Promise<ProvisioningResult> => {
    const prev = chains.get(employeeId) ?? Promise.resolve(null)
    const next = prev
      .catch(() => null)
      .then(() => pass(employeeId))
      .catch((err): ProvisioningResult => {
        log.error('webhook provisioning failed', { employeeId, err: errorMessage(err) })
        return { employeeId, outcome: 'failed', reason: errorMessage(err), hooks: [] }
      })
      .finally(() => {
        last = deps.clock.iso()
        if (chains.get(employeeId) === next) chains.delete(employeeId)
      })
    chains.set(employeeId, next)
    return next
  }

  const scheduleOne = (employeeId: string) => {
    if (closed || !publicUrl) return
    clearTimeout(timers.get(employeeId))
    const t = setTimeout(() => {
      timers.delete(employeeId)
      void track(run(employeeId))
    }, debounceMs)
    t.unref?.()
    timers.set(employeeId, t)
  }

  const scheduleAll = () => {
    if (closed || !publicUrl) return
    void track(
      (async () => {
        for (const e of (await deps.directory.employees.list()).items) scheduleOne(e.id)
      })(),
    )
  }

  const schedule = (employeeId?: string) => (employeeId ? scheduleOne(employeeId) : scheduleAll())

  // ── What triggers a pass ────────────────────────────────────────────────
  const onRecord = async (m: { kind: string; id: string; op: string }) => {
    if (m.kind === 'secret') {
      const r = await deps.records.get<{ name?: string; scope?: { type: string; id?: string } }>('secret', m.id)
      if (!r) return scheduleAll() // deleted: we can't tell whose it was
      if (!PROVISIONING_SECRETS.includes(r.data.name ?? '')) return
      const scope = r.data.scope
      if (scope?.type === 'employee' && scope.id) {
        if (r.data.name === WEBHOOK_SECRET && selfWritten.delete(scope.id)) return
        return scheduleOne(scope.id)
      }
      if (scope?.type === 'global') return scheduleAll()
      return
    }
    if (m.kind === 'project') {
      const p = m.op === 'delete' ? null : await deps.directory.projects.get(m.id)
      const sig = JSON.stringify((p?.data.repositories ?? []).map((r) => r.url).sort())
      const before = repoSignatures.get(m.id)
      repoSignatures.set(m.id, sig)
      if (m.op === 'delete') repoSignatures.delete(m.id)
      if (m.op !== 'delete' && (before === sig || (before === undefined && sig === '[]'))) return
      return scheduleAll()
    }
    if (m.kind === 'employee' && m.op !== 'update') return scheduleAll()
  }

  const onLink = async (m: { from: { kind: string; id: string }; to: { kind: string; id: string }; role: string }) => {
    if (m.to.kind !== 'project') return
    if (m.from.kind === 'contact') {
      const e = await deps.directory.employees.byContact(m.from.id)
      if (e) scheduleOne(e.id)
      return
    }
    if (m.from.kind === 'session' && m.role === 'works_on') {
      const id = await employeeOfSession(m.from.id)
      if (id) scheduleOne(id)
    }
  }

  return {
    enabled: !!publicUrl,
    reason,
    start() {
      if (started || closed) return
      started = true
      if (!publicUrl) {
        log.warn(reason!)
        return
      }
      offs.push(
        deps.bus.subscribe<{ kind: string; id: string; op: string }>('record.changed', (m) => {
          void track(onRecord(m.payload))
        }),
        deps.bus.subscribe<{ from: { kind: string; id: string }; to: { kind: string; id: string }; role: string }>(
          'link.changed',
          (m) => {
            void track(onLink(m.payload))
          },
        ),
      )
      interval = setInterval(scheduleAll, repairEveryMs)
      interval.unref?.()
      scheduleAll()
    },
    schedule,
    run,
    async idle() {
      while (timers.size || chains.size || background.size) {
        if (timers.size && !chains.size && !background.size) await new Promise((r) => setTimeout(r, Math.max(5, debounceMs)))
        await Promise.all([...chains.values(), ...background])
      }
    },
    lastRunAt: () => last,
    async close() {
      closed = true
      if (interval) clearInterval(interval)
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      for (const off of offs.splice(0)) off()
      await Promise.all([...chains.values(), ...background]).catch(() => {})
    },
  }
}

/** The provisioning for a composed server, or null when the GitLab integration is disabled. */
export function gitlabHookProvisioning(
  s: Pick<Services, 'config' | 'records' | 'directory' | 'secrets' | 'bus' | 'clock' | 'logger' | 'integrations'>,
  o: IntegrationsOptions = {},
): HookProvisioning | null {
  if (!s.integrations?.specs.gitlab) return null
  const baseUrl = o.baseUrls?.gitlab ?? s.config.GITLAB_BASE_URL
  return createHookProvisioning(
    {
      records: s.records,
      directory: s.directory,
      secrets: s.secrets,
      bus: s.bus,
      clock: s.clock,
      logger: s.logger,
      publicUrl: s.config.PUBLIC_URL,
      ...(baseUrl ? { baseUrl } : {}),
      ...(o.fetch ? { fetch: o.fetch } : {}),
    },
    o.provisioning ?? {},
  )
}
