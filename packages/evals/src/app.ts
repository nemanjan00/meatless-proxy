import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@mp/chat'
import { memoryLogger, sleep, type LogLine } from '@mp/core'
import { fakeGitCache } from '@mp/git'
import type { ModelClient } from '@mp/model'
import { createMcpToken, createApp, loadConfig, type App } from '@mp/server'
import type { AssistantContent, Run, RunState, ToolResultContent } from '@mp/sessions'
import type { EvalContext, ToolCall } from './types.ts'
import type { ModelEnv } from './env.ts'

/** A value that must never leave the app: the scenarios check nobody printed it. */
export const CANARY_SECRETS_KEY = 'eval-canary-secrets-key-7f3a9c'

export interface EvalAppOptions {
  /** A model client to use instead of the configured provider (the unit tests' scripted model). */
  model?: ModelClient
  /** The real provider, from `.env`. Ignored when `model` is set. */
  modelEnv?: ModelEnv | null
  /** Default settle timeout (ms). */
  timeoutMs?: number
  /** Model calls per run before it pauses (default 12: evals are meant to be cheap). */
  maxSteps?: number
}

export interface EvalApp {
  ctx: EvalContext
  logs: LogLine[]
  close(): Promise<void>
}

const LIVE: RunState[] = ['queued', 'running']

/**
 * Starts the whole app in-process: memory store and queue, a fake git cache,
 * the standard library, bootstrap (employee, #general, #requests), workers,
 * and the given or configured model. No HTTP port is opened: the API is
 * called through `app.request()`.
 */
export async function startEvalApp(opts: EvalAppOptions = {}): Promise<EvalApp> {
  const dir = mkdtempSync(join(tmpdir(), 'mp-eval-'))
  const env: Record<string, string> = {
    MP_BOOTSTRAP: '1',
    LOG_LEVEL: 'warn',
    DATA_DIR: dir,
    MP_WEB_DIST: join(dir, 'no-web'),
    HOST: '127.0.0.1',
    SECRETS_KEY: CANARY_SECRETS_KEY,
    RUN_BACKOFF_MS: '500',
    MAX_STEPS: String(opts.maxSteps ?? 12),
  }
  if (!opts.model && opts.modelEnv) {
    env.OPENAI_BASE_URL = opts.modelEnv.OPENAI_BASE_URL
    env.OPENAI_API_KEY = opts.modelEnv.OPENAI_API_KEY
    env.MODEL = opts.modelEnv.MODEL
  }
  const config = loadConfig(env)
  const logs: LogLine[] = []
  let app: App
  try {
    app = await createApp(config, {
      git: fakeGitCache(),
      logger: memoryLogger(logs),
      ...(opts.model ? { model: opts.model } : {}),
    })
    await app.start({ http: false, workers: true })
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
  const s = app.services
  const defaultTimeout = opts.timeoutMs ?? 240_000

  const channelId = async (channel: string) => {
    const byId = await s.chat.getChannel(channel)
    if (byId) return byId.id
    const byName = await s.chat.channelByName(channel)
    if (!byName) throw new Error(`no channel ${channel}`)
    return byName.id
  }

  const isAi = async (m: Message) => {
    if (m.data.author.kind === 'session') return true
    return (await s.directory.contacts.get(m.data.author.id))?.data.kind === 'ai'
  }

  const runs = async (): Promise<Run[]> =>
    (await s.sessions.runs({ limit: 10_000 })).sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    )

  /** Posts are signed in, like a person would be: a member token for the contact (default: an eval user). */
  const tokens = new Map<string, string>()
  const tokenFor = async (contactId?: string): Promise<string> => {
    let id = contactId
    if (!id) {
      const existing = await s.directory.contacts.byEmail('eval-user@example.com')
      id =
        existing?.id ??
        (await s.directory.contacts.create({ name: 'Eval user', kind: 'person', email: 'eval-user@example.com' })).id
    }
    const cached = tokens.get(id)
    if (cached) return cached
    const contact = await s.directory.contacts.require(id)
    if (!(contact.data as Record<string, unknown>).access) await s.records.update('contact', id, { access: 'member' })
    const { token } = await createMcpToken(s, id, 'evals')
    tokens.set(id, token)
    return token
  }

  const ctx: EvalContext = {
    app,
    services: s,
    state: {},

    async post(channel, text, o = {}) {
      const id = await channelId(channel)
      const res = await app.app.request(`/api/chat/channels/${id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await tokenFor(o.as)}` },
        body: JSON.stringify({ text, ...(o.threadId ? { threadId: o.threadId } : {}) }),
      })
      const body = await res.text()
      if (res.status !== 201) throw new Error(`posting failed: ${res.status} ${body.slice(0, 200)}`)
      return JSON.parse(body) as Message
    },

    async settle(timeoutMs = defaultTimeout) {
      const start = Date.now()
      let quietFor = 0
      // Quiet twice in a row: a finished run can enqueue a wake-up or a delivery right after.
      while (quietFor < 2) {
        await s.queue.idle()
        await s.bus.idle()
        const live = await s.sessions.runs({ state: LIVE, limit: 1 })
        quietFor = live.length ? 0 : quietFor + 1
        if (quietFor >= 2) break
        if (Date.now() - start > timeoutMs)
          throw new Error(`timed out: runs did not settle within ${Math.round(timeoutMs / 1000)} s`)
        await sleep(live.length ? 250 : 50)
      }
    },

    async replies(rootId) {
      return (await s.chat.thread(rootId)).filter((m) => m.id !== rootId)
    },

    async aiReplies(rootId) {
      const out: Message[] = []
      for (const m of await ctx.replies(rootId)) if (await isAi(m)) out.push(m)
      return out
    },

    async aiMessages() {
      const out: Message[] = []
      for (const m of await s.chat.search('', { limit: 10_000, includeDeleted: true })) if (await isAi(m)) out.push(m)
      return out.sort((a, b) => (a.id < b.id ? -1 : 1))
    },

    runs,

    async toolCalls() {
      const seen = new Set<string>()
      const results = new Map<string, ToolResultContent>()
      const calls: ToolCall[] = []
      for (const run of await runs()) {
        for (const e of await s.sessions.runHistory(run.id)) {
          if (seen.has(e.id)) continue
          seen.add(e.id)
          if (e.kind === 'tool_result') {
            const r = e.content as unknown as ToolResultContent
            results.set(r.toolCallId, r)
          }
          if (e.kind !== 'assistant') continue
          const a = e.content as unknown as AssistantContent
          for (const c of a.toolCalls ?? []) {
            let args: Record<string, unknown> = {}
            try {
              args = JSON.parse(c.arguments || '{}')
            } catch {
              args = { _raw: c.arguments }
            }
            const sessionId = typeof e.meta?.sessionId === 'string' ? e.meta.sessionId : run.data.sessionId
            calls.push({ runId: run.id, sessionId, name: c.name.replace(/__/g, '.'), args, callId: c.id })
          }
        }
      }
      for (const c of calls) {
        const r = results.get(c.callId)
        if (r) {
          c.output = r.output
          if (r.isError) c.isError = true
        }
      }
      return calls
    },

    usage: () => s.usage.totals(),
  }

  return {
    ctx,
    logs,
    async close() {
      await app.stop({ timeoutMs: 5000 }).catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
