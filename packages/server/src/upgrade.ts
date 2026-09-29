import { errorMessage } from '@mp/core'
import { DEFAULT_REQUESTS_CHANNEL, provisionEmployee } from './provision.ts'
import type { Services } from './services.ts'
import { SettingNames } from './settings.ts'

/** How many earlier requests the reset summary lists. */
const SUMMARY_LINES = 30

type Entry = Awaited<ReturnType<Services['sessions']['history']>>[number]

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The request lines of a router history: the events it got, oldest first. */
function requestLines(history: Entry[]): string[] {
  const lines: string[] = []
  for (const e of history) {
    if (e.kind !== 'event') continue
    const text = String((e.content as { text?: unknown } | null)?.text ?? '')
    const head = text.split('\n')[0] ?? ''
    lines.push(`- ${clip(head.replace(/^\[[^\]]*\]\s*/, ''), 120)}`)
  }
  return lines.slice(-SUMMARY_LINES)
}

/**
 * A router context from before the router flow kept every request it handled
 * in its history (continuing runs). Rewinds it once to its first entry, with a
 * summary listing those requests, so it starts the router flow small. The old
 * entries stay in the session's tree as a branch; nothing is deleted.
 */
async function resetOldRouter(s: Services, routerSessionId: string) {
  const session = await s.sessions.require(routerSessionId)
  if (session.data.meta?.routerInstructions) return false
  const history = await s.sessions.history(routerSessionId)
  const first = history[0]
  if (!first || history.length <= 2) return false
  const lines = requestLines(history)
  const summary = [
    'Before this context used the router flow, it handled these requests itself (their threads are in chat;',
    'read a thread with chat.read before answering a follow-up):',
    ...(lines.length ? lines : ['- (none)']),
  ].join('\n')
  const actor = { type: 'system' as const, id: 'upgrade' }
  const run = await s.sessions.createRun({
    sessionId: routerSessionId,
    mode: 'continuing',
    cause: { type: 'manual', note: 'router flow: reset' },
    actor,
  })
  await s.sessions.transition(run.id, 'queued', 'running')
  await s.sessions.compact(run.id, summary)
  await s.sessions.commit(run.id)
  await s.sessions.transition(run.id, 'running', 'completed', {
    result: { status: 'completed', output: 'router context reset for the router flow' },
  })
  return true
}

/**
 * Brings every existing employee up to what provisioning gives a new one, at
 * every start (idempotent): its router context gets the router instructions and
 * the routing toolset, its requests trigger the current shape. Deployments from
 * earlier versions otherwise never get them, because provisioning ran only once.
 * The default employee keeps `#requests`.
 */
export async function upgradeEmployees(s: Services): Promise<{ upgraded: number; reset: number }> {
  const actor = { type: 'system' as const, id: 'upgrade' }
  const defaultRouter = await s.settings.get<string>(SettingNames.defaultRouter)
  let upgraded = 0
  let reset = 0
  for (const e of (await s.directory.employees.list({ limit: 10_000 })).items) {
    try {
      if (e.data.routerSessionId && (await resetOldRouter(s, e.data.routerSessionId))) {
        reset++
        s.logger.info('upgrade: router context reset for the router flow', { employeeId: e.id })
      }
      const isDefault = !!e.data.routerSessionId && e.data.routerSessionId === defaultRouter
      await provisionEmployee(s, e.id, actor, isDefault ? { requestsChannel: DEFAULT_REQUESTS_CHANNEL } : {})
      upgraded++
    } catch (err) {
      s.logger.warn('upgrade: could not bring an employee up to date', { employeeId: e.id, err: errorMessage(err) })
    }
  }
  return { upgraded, reset }
}
