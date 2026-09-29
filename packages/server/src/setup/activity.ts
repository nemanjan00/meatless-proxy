import { errorMessage, type Json } from '@mp/core'
import type { MiddlewareHandler } from 'hono'
import type { Services } from '../services.ts'

/** The setting holding the last signed webhook of an employee (or `deployment`) in an integration. */
export const activitySetting = (owner: string, integration: string) => `webhook.activity:${owner}:${integration}`
/** The activity key of an integration's interactivity requests: `slack.interactive`. */
export const interactiveActivity = (integration: string) => `${integration}.interactive`
/** Activity is written to the database at most this often per employee and integration (a new project writes at once). */
export const ACTIVITY_PERSIST_MS = 30_000
/** Projects remembered per employee and integration. */
const MAX_PROJECTS = 200

/** When signed webhooks last arrived. */
export interface WebhookActivityRecord {
  lastAt: string
  /** Signed requests counted since the harness started (in this process). */
  count: number
  /** GitLab: the last request per project path. */
  projects?: Record<string, string>
}

export interface WebhookActivity {
  /** Records every webhook the integration accepted (2xx), after the handler ran. Mount before the webhook routes. */
  middleware: MiddlewareHandler
  /** The activity of an employee (or `deployment`, for the deployment-wide URL) in an integration. */
  get(owner: string, integration: string): Promise<WebhookActivityRecord | null>
  /** Records one accepted webhook (the middleware calls this). */
  record(owner: string, integration: string, project?: string): Promise<void>
  /** Waits for pending writes (tests, shutdown). */
  idle(): Promise<void>
}

/**
 * Remembers when each employee's webhooks last arrived with a valid signature: only requests the
 * integration accepted count (a bad signature is a 401). Kept in memory, and written to a setting
 * (`webhook.activity:<employee>:<integration>`) at most every 30 s, so a busy webhook doesn't
 * write on every request and the status survives a restart.
 */
export function createWebhookActivity(s: Pick<Services, 'settings' | 'directory' | 'clock' | 'logger'>): WebhookActivity {
  const mem = new Map<string, { value: WebhookActivityRecord; persistedAt: number }>()
  const pending = new Set<Promise<void>>()
  const log = s.logger.child({ component: 'webhook-activity' })

  const persist = (key: string, value: WebhookActivityRecord) => {
    const p = s.settings
      .set(key, value as unknown as Json)
      .catch((err) => log.warn('webhook activity not saved', { key, err: errorMessage(err) }))
    pending.add(p)
    void p.finally(() => pending.delete(p))
  }

  const record: WebhookActivity['record'] = async (owner, integration, project) => {
    const key = activitySetting(owner, integration)
    const now = s.clock.now()
    const at = new Date(now).toISOString()
    let entry = mem.get(key)
    if (!entry) {
      const stored = await s.settings.get<Json>(key).catch(() => undefined)
      const base = (stored && typeof stored === 'object' ? stored : null) as WebhookActivityRecord | null
      entry = {
        value: { lastAt: base?.lastAt ?? at, count: 0, ...(base?.projects ? { projects: base.projects } : {}) },
        persistedAt: 0,
      }
      mem.set(key, entry)
    }
    const isNewProject = !!project && !entry.value.projects?.[project]
    entry.value.lastAt = at
    entry.value.count++
    if (project) {
      const projects = { ...(entry.value.projects ?? {}), [project]: at }
      const names = Object.keys(projects)
      if (names.length > MAX_PROJECTS)
        for (const n of names.sort((a, b) => projects[a]!.localeCompare(projects[b]!)).slice(0, names.length - MAX_PROJECTS))
          delete projects[n]
      entry.value.projects = projects
    }
    if (isNewProject || now - entry.persistedAt >= ACTIVITY_PERSIST_MS) {
      entry.persistedAt = now
      persist(key, { ...entry.value })
    }
  }

  const ownerOf = async (ref: string | undefined): Promise<string | null> => {
    if (!ref) return 'deployment'
    const e = (await s.directory.employees.get(ref)) ?? (await s.directory.employees.byHandle(ref))
    return e?.id ?? null
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    await next()
    if (c.res.status < 200 || c.res.status >= 300) return
    const parts = c.req.path.split('/').filter(Boolean) // webhooks, integration, employee?, interactive?
    if (parts[0] !== 'webhooks' || !parts[1]) return
    if (parts.length > 4 || (parts.length === 4 && parts[3] !== 'interactive')) return
    try {
      const owner = await ownerOf(parts[2] ? decodeURIComponent(parts[2]) : undefined)
      if (!owner) return
      // Interactivity (form-encoded payloads, e.g. Slack's buttons) is tracked apart from events.
      const form = (c.req.header('content-type') ?? '').startsWith('application/x-www-form-urlencoded')
      if (parts[3] === 'interactive' || (parts[1] === 'slack' && form)) {
        await record(owner, interactiveActivity(parts[1]))
        return
      }
      let project: string | undefined
      if (parts[1] === 'gitlab') {
        // The handler has read the body already; hono caches it.
        const body = JSON.parse(await c.req.text()) as { project?: { path_with_namespace?: unknown } }
        if (typeof body.project?.path_with_namespace === 'string') project = body.project.path_with_namespace
      }
      await record(owner, parts[1], project)
    } catch (err) {
      log.debug('webhook activity not recorded', { err: errorMessage(err) })
    }
  }

  return {
    middleware,
    record,
    async get(owner, integration) {
      const hit = mem.get(activitySetting(owner, integration))
      if (hit) return { ...hit.value }
      const stored = await s.settings.get<Json>(activitySetting(owner, integration))
      return stored && typeof stored === 'object' ? (stored as unknown as WebhookActivityRecord) : null
    },
    async idle() {
      while (pending.size) await Promise.all([...pending])
    },
  }
}
