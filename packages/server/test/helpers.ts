import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryLogger, sleep, type LogLine } from '@mp/core'
import { fakeGitCache } from '@mp/git'
import { scriptedModel, type Script, type ScriptedModel } from '@mp/model'
import { createApp, type App } from '../src/app.ts'
import { loadConfig, type Config } from '../src/config.ts'
import type { AppOverrides } from '../src/services.ts'

export interface TestApp {
  a: App
  config: Config
  model: ScriptedModel
  logs: LogLine[]
  /** `app.request()` with JSON in and out. */
  req<T = any>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: T }>
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
  const model = scriptedModel(opts.script ?? [])
  const a = await createApp(config, { model, git: fakeGitCache(), logger: memoryLogger(logs), ...opts.overrides })
  const { port } = await a.start({ http: opts.http ?? false, port: 0, workers: opts.workers ?? true })
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
    async req(method, path, body, headers = {}) {
      const res = await a.app.request(path, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
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
