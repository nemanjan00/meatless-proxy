import { timingSafeEqual } from 'node:crypto'
import { errorMessage } from '@mp/core'
import { afterModelCall, beforeModelCall } from '@mp/runner'
import type { MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import { matchedRoutes } from 'hono/route'
import { bearerOf, maybePrincipal } from '../auth/guard.ts'
import { QUEUES } from '../queues.ts'
import type { Services } from '../services.ts'

/**
 * Prometheus metrics, written by hand in the text exposition format (0.0.4).
 * Counters and histograms are kept in memory from the bus and hooks; gauges
 * (runs by state, queue depth, environments) are read on each scrape.
 */

type Labels = Record<string, string>

const RUN_STATES = ['queued', 'running', 'suspended', 'paused', 'completed', 'failed', 'cancelled'] as const
/** Latency buckets in seconds. */
export const LATENCY_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120]

const escapeLabel = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
const labelText = (l: Labels) => {
  const keys = Object.keys(l).sort()
  return keys.length ? `{${keys.map((k) => `${k}="${escapeLabel(l[k]!)}"`).join(',')}}` : ''
}
const fmt = (n: number) => (Number.isFinite(n) ? String(n) : n > 0 ? '+Inf' : n < 0 ? '-Inf' : 'NaN')

/** A family of counters (or gauges) keyed by labels. */
class Family {
  readonly values = new Map<string, { labels: Labels; value: number }>()
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: 'counter' | 'gauge',
  ) {}
  inc(labels: Labels = {}, by = 1) {
    const k = labelText(labels)
    const cur = this.values.get(k)
    if (cur) cur.value += by
    else this.values.set(k, { labels, value: by })
  }
  set(labels: Labels, value: number) {
    this.values.set(labelText(labels), { labels, value })
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`]
    for (const { labels, value } of this.values.values()) out.push(`${this.name}${labelText(labels)} ${fmt(value)}`)
    return out
  }
}

class Histogram {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>()
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[],
  ) {}
  observe(labels: Labels, v: number) {
    const k = labelText(labels)
    let s = this.series.get(k)
    if (!s) {
      s = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 }
      this.series.set(k, s)
    }
    this.buckets.forEach((b, i) => {
      if (v <= b) s.counts[i]!++
    })
    s.sum += v
    s.count++
  }
  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`]
    for (const s of this.series.values()) {
      this.buckets.forEach((b, i) => {
        out.push(`${this.name}_bucket${labelText({ ...s.labels, le: String(b) })} ${s.counts[i]}`)
      })
      out.push(`${this.name}_bucket${labelText({ ...s.labels, le: '+Inf' })} ${s.count}`)
      out.push(`${this.name}_sum${labelText(s.labels)} ${fmt(s.sum)}`)
      out.push(`${this.name}_count${labelText(s.labels)} ${s.count}`)
    }
    return out
  }
}

export class Metrics {
  readonly modelCalls = new Family('mp_model_calls_total', 'Model calls by model.', 'counter')
  readonly tokens = new Family('mp_model_tokens_total', 'Model tokens by model and type (prompt, completion, cached).', 'counter')
  readonly latency = new Histogram('mp_model_call_duration_seconds', 'Model call latency by model.', LATENCY_BUCKETS)
  readonly toolCalls = new Family('mp_tool_calls_total', 'Tool calls by tool.', 'counter')
  readonly toolErrors = new Family('mp_tool_errors_total', 'Tool calls that returned an error, by tool.', 'counter')
  readonly events = new Family('mp_events_total', 'Events ingested (new, not deduplicated) by source.', 'counter')
  readonly http = new Family('mp_http_requests_total', 'HTTP requests by route and status.', 'counter')
  private readonly started = new Map<string, number>()
  private offs: (() => void)[] = []

  constructor(private s: Services) {
    const bus = s.bus
    this.offs.push(
      bus.subscribe<{ id?: string; model?: string; promptTokens?: number; completionTokens?: number; cachedTokens?: number }>(
        'usage.recorded',
        (m) => {
          // The usage ledger's message (it has an id); the runner's raw one is skipped.
          const p = m.payload
          if (typeof p.id !== 'string' || typeof p.promptTokens !== 'number') return
          const model = p.model ?? 'unknown'
          this.tokens.inc({ model, type: 'prompt' }, p.promptTokens)
          this.tokens.inc({ model, type: 'completion' }, p.completionTokens ?? 0)
          this.tokens.inc({ model, type: 'cached' }, p.cachedTokens ?? 0)
        },
      ),
      bus.subscribe<{ name: string }>('tool.called', (m) => this.toolCalls.inc({ tool: m.payload.name })),
      bus.subscribe<{ name: string; isError?: boolean }>('tool.result', (m) => {
        if (m.payload.isError) this.toolErrors.inc({ tool: m.payload.name })
      }),
      bus.subscribe<{ eventId: string; created?: boolean }>('event.ingested', async (m) => {
        if (m.payload.created === false) return
        const e = await s.rawEvents.get(m.payload.eventId).catch(() => null)
        this.events.inc({ source: e?.data.source ?? 'unknown' })
      }),
    )
    // Model call latency: from the hook before the call to the hook after it.
    s.hooks.on(beforeModelCall, ({ run }) => {
      this.started.set(run.id, s.clock.now())
      return undefined
    })
    s.hooks.on(afterModelCall, ({ run, model }) => {
      const t0 = this.started.get(run.id)
      this.started.delete(run.id)
      this.modelCalls.inc({ model })
      if (t0 !== undefined) this.latency.observe({ model }, (s.clock.now() - t0) / 1000)
      return undefined
    })
  }

  /** Middleware counting requests by matched route pattern and status. */
  middleware(): MiddlewareHandler {
    return async (c, next) => {
      await next()
      const route = matchedRoutes(c)[c.req.routeIndex]?.path
      const label = !route || route === '*' || route === '/*' ? (c.res.status === 404 ? 'unmatched' : 'web') : route
      this.http.inc({ method: c.req.method, route: label, status: String(c.res.status) })
    }
  }

  /** The exposition text. Reads the gauges now. */
  async render(): Promise<string> {
    const s = this.s
    const runs = new Family('mp_runs', 'Runs by state.', 'gauge')
    for (const st of RUN_STATES) runs.set({ state: st }, await s.store.records.count('run', { state: st }))
    const queue = new Family('mp_queue_jobs', 'Queue depth: jobs by queue and state.', 'gauge')
    for (const q of Object.values(QUEUES)) {
      const counts = await s.queue.counts(q).catch(() => null)
      if (!counts) continue
      for (const st of ['waiting', 'delayed', 'active'] as const) queue.set({ queue: q, state: st }, counts[st])
    }
    const envs = new Family('mp_environments_running', 'Environments (containers) running.', 'gauge')
    let running = 0
    if (s.containers) {
      running = await s.containers
        .listEnvs()
        .then((l) => l.filter((e) => e.status === 'running').length)
        .catch((err) => {
          s.logger.debug('metrics: environments unavailable', { err: errorMessage(err) })
          return 0
        })
    }
    envs.set({}, running)
    const lines = [
      ...runs.render(),
      ...queue.render(),
      ...this.modelCalls.render(),
      ...this.tokens.render(),
      ...this.latency.render(),
      ...this.toolCalls.render(),
      ...this.toolErrors.render(),
      ...this.events.render(),
      ...envs.render(),
      ...this.http.render(),
    ]
    return `${lines.join('\n')}\n`
  }

  close() {
    for (const off of this.offs) off()
  }
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** `GET /metrics`: for admins (signed in) or the `METRICS_TOKEN` bearer. */
export function metricsRoutes(s: Services, metrics: Metrics): Hono {
  const app = new Hono()
  app.get('/metrics', async (c) => {
    const bearer = bearerOf(c)
    const byToken = !!(s.config.METRICS_TOKEN && bearer && safeEqual(bearer, s.config.METRICS_TOKEN))
    const p = maybePrincipal(c)
    if (!byToken && p?.access !== 'admin') {
      const body = { error: { code: p ? 'denied' : 'unauthorized', message: 'metrics are for admins or the metrics token' } }
      return c.json(body, p ? 403 : 401)
    }
    return c.body(await metrics.render(), 200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
  })
  return app
}
