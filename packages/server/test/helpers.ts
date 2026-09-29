import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryLogger, sleep, type LogLine } from '@mp/core'
import { fakeGitCache } from '@mp/git'
import { scriptedModel, type Script, type ScriptedModel } from '@mp/model'
import { routerAware } from './router-aware.ts'
export { ROUTER_MARK } from './router-aware.ts'
import { createApp, type App } from '../src/app.ts'
import { loadConfig, type Config } from '../src/config.ts'
import type { AppOverrides } from '../src/services.ts'
import { adminOf, signIn, type SignInOptions } from './auth-helpers.ts'
export { adminOf, cookiesOf, signIn, type SignInOptions } from './auth-helpers.ts'

export interface TestApp {
  a: App
  config: Config
  model: ScriptedModel
  logs: LogLine[]
  /**
   * `app.request()` with JSON in and out, signed in as the admin unless `headers` carry their own
   * `authorization` or `cookie` (an empty `authorization` sends none: anonymous). `x-mp-contact: <id>`
   * is a test shortcut for "signed in as that contact" (see `as`); the server itself ignores that header.
   */
  req<T = any>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: T }>
  /** The bootstrap admin (created on first use when there is none), whom `req` signs in as by default. */
  admin(): Promise<{ contactId: string; headers: Record<string, string> }>
  /** Headers signed in as this contact (a bearer token, cached; `member` unless it has an access already). */
  as(contactId: string, opts?: SignInOptions): Promise<Record<string, string>>
  /** Waits until the queues are idle and the bus has delivered everything. */
  settle(): Promise<void>
  close(): Promise<void>
}

export interface TestAppOptions {
  script?: Script
  env?: Record<string, string>
  overrides?: AppOverrides
  /** Start workers (default true). */
  workers?: boolean
  /** Also listen on a free port. */
  http?: boolean
}

/** A test app with in-memory adapters (unless `env` names Postgres/Redis), a scripted model and a fake git cache. */
export async function testApp(opts: TestAppOptions = {}): Promise<TestApp & { port: number | null }> {
  const dir = mkdtempSync(join(tmpdir(), 'mp-server-'))
  const config = loadConfig({
    MP_BOOTSTRAP: '1',
    LOG_LEVEL: 'debug',
    DATA_DIR: dir,
    RUN_BACKOFF_MS: '10',
    MP_WEB_DIST: join(dir, 'no-web'),
    HOST: '127.0.0.1',
    ...opts.env,
  })
  const logs: LogLine[] = []
  const script = typeof opts.script === 'function' && !(opts.script as any).raw ? routerAware(opts.script as any) : opts.script
  const model = scriptedModel(script ?? [])
  const a = await createApp(config, { model, git: fakeGitCache(), logger: memoryLogger(logs), ...opts.overrides })
  const { port } = await a.start({ http: opts.http ?? false, port: 0, workers: opts.workers ?? true })
  let adminP: Promise<{ contactId: string; headers: Record<string, string> }> | null = null
  const admin = () =>
    (adminP ??= (async () => {
      const contactId = await adminOf(a)
      return { contactId, headers: await signIn(a, contactId, { access: 'admin' }) }
    })())
  const tokens = new Map<string, Record<string, string>>()
  const as = async (contactId: string, o: SignInOptions = {}) => {
    const key = o.via || o.access ? '' : contactId
    const hit = key && tokens.get(key)
    if (hit) return hit
    const h = await signIn(a, contactId, o)
    if (key) tokens.set(key, h)
    return h
  }
  const authHeaders = async (headers: Record<string, string>) => {
    const { 'x-mp-contact': asContact, ...rest } = headers
    if (asContact) return { ...rest, ...(await as(asContact)) }
    if ('authorization' in rest || 'cookie' in rest) {
      if (rest.authorization === '') delete rest.authorization
      return rest
    }
    return { ...rest, ...(await admin()).headers }
  }
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await a.services.queue.idle()
      await a.services.bus.idle()
      await a.live.flush()
      await sleep(5)
    }
  }
  return {
    a,
    config,
    model,
    logs,
    port,
    settle,
    admin,
    as,
    async req(method, path, body, headers = {}) {
      const res = await a.app.request(path, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(await authHeaders(headers)) },
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      })
      const text = await res.text()
      let parsed: any = text
      try {
        parsed = text ? JSON.parse(text) : undefined
      } catch {}
      return { status: res.status, body: parsed }
    },
    async close() {
      await a.stop({ timeoutMs: 2000 })
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Polls until `fn` returns something truthy. */
export async function until<T>(fn: () => Promise<T> | T, what = 'condition', timeoutMs = 5000): Promise<NonNullable<T>> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

/** Errors logged at error level, for asserting a clean run. */
export const errorsIn = (logs: LogLine[]) => logs.filter((l) => l.level === 'error')
