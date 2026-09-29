import { errorMessage } from '@mp/core'
import { covers, dmMarkOfEvent, markOf, mergeMarks, type PrivateMark } from './auth/visibility.ts'
import { isSharedContext } from './private-work.ts'
import { DEFAULT_REQUESTS_CHANNEL, provisionEmployee, routerToolset } from './provision.ts'
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

/** A prompt without its start time, for comparing what two prompts say. */
const normalizePrompt = (text: string) => text.replace(/Session started: [^\n]*/g, '').trim()

/** At most this many decisions are carried over to a rebuilt router context. */
const CARRIED_DECISIONS = 60

const rebuilding = new Map<string, Promise<boolean>>()

/**
 * A router context keeps the employee prompt it was created with as its first entry, and the work it
 * starts learns from it (its hand-off instructions echo the tone and rules). When the employee's prompt
 * has changed since (personality, instructions, name, role, a new prompt version), this starts a fresh
 * router context with the current prompt, the router instructions and the decision log carried over,
 * and points the employee, the default router, its channels and its triggers at it. The old context is
 * kept (slug `router-<time>`, status done) with its history. Work sessions already started are untouched.
 */
export function refreshRouterPrompt(s: Services, employeeId: string): Promise<boolean> {
  const inFlight = rebuilding.get(employeeId)
  if (inFlight) return inFlight
  const run = (async () => {
    if (!s.stdlib) return false
    const employee = await s.directory.employees.require(employeeId)
    const oldId = employee.data.routerSessionId
    const old = oldId ? await s.sessions.get(oldId) : null
    if (!old) return false
    const history = await s.sessions.history(old.id)
    const firstText = String((history[0]?.content as { text?: unknown } | null)?.text ?? '')
    const contact = await s.directory.employees.contact(employee.id)
    const prompt = s.stdlib.employeePrompt({ employee, contact, now: s.clock.iso() })
    if (normalizePrompt(firstText) === normalizePrompt(prompt)) return false

    const actor = { type: 'system' as const, id: 'upgrade' }
    const decisions = history
      .filter((e) => e.kind === 'summary')
      .map((e) => String((e.content as { text?: unknown } | null)?.text ?? '').trim())
      .filter(Boolean)
      .slice(-CARRIED_DECISIONS)
    const stamp = s.clock.iso().replace(/[-:]/g, '').slice(0, 13).toLowerCase()
    const retiredSlug = `router-${stamp}`
    // The slug's unique key moves with it, so the new context can take `router`.
    await s.records.update(
      'session',
      old.id,
      { slug: retiredSlug, meta: { ...(old.data.meta ?? {}), role: 'router-retired' } },
      { key: `${employee.id}:${retiredSlug}` },
    )
    await s.sessions.update(old.id, { status: 'done' }, actor)
    const fresh = await s.sessions.create({
      employeeId: employee.id,
      title: `${employee.data.name}: router`,
      slug: 'router',
      toolset: routerToolset(s, await s.toolListsFor(employee.id)),
      ...(old.data.document ? { document: old.data.document } : {}),
      entries: [
        { kind: 'system', content: { text: prompt } },
        { kind: 'system', content: { text: s.stdlib.ROUTER_INSTRUCTIONS } },
        ...(decisions.length
          ? [
              {
                kind: 'summary' as const,
                content: { text: `Your routing decisions so far (from your previous router context):\n${decisions.join('\n')}` },
              },
            ]
          : []),
      ],
      meta: {
        role: 'router',
        routerInstructions: s.stdlib.ROUTER_INSTRUCTIONS_VERSION,
        routerToolset: 1,
        previousRouter: old.id,
      },
      actor,
    })
    await s.directory.employees.update(employee.id, { routerSessionId: fresh.id }, { actor })
    if ((await s.settings.get<string>(SettingNames.defaultRouter)) === old.id)
      await s.settings.set(SettingNames.defaultRouter, fresh.id, actor)
    for (const ch of await s.chat.listChannels())
      if (ch.data.contextSessionId === old.id) await s.chat.updateChannel(ch.id, { contextSessionId: fresh.id }, actor)
    for (const t of await s.events.triggers.list())
      if (t.data.target.type === 'session' && t.data.target.sessionId === old.id)
        await s.events.triggers.update(t.id, { target: { type: 'session', sessionId: fresh.id } }, actor)
    s.logger.info('upgrade: router context rebuilt with the current employee prompt', {
      employeeId: employee.id,
      from: old.id,
      to: fresh.id,
      decisions: decisions.length,
    })
    return true
  })().finally(() => rebuilding.delete(employeeId))
  rebuilding.set(employeeId, run)
  return run
}

/** Rebuilds an employee's router context shortly after the employee changes (debounced), if its prompt changed. */
export function watchEmployeePrompts(s: Services, delayMs = 2000): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const off = s.bus.subscribe<{ kind: string; id: string; op: string }>('record.changed', async (m) => {
    if (m.payload.kind !== 'employee' || m.payload.op !== 'update') return
    const id = m.payload.id
    clearTimeout(timers.get(id))
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        refreshRouterPrompt(s, id).catch((err) =>
          s.logger.warn('could not rebuild the router context', { employeeId: id, err: errorMessage(err) }),
        )
      }, delayMs),
    )
  })
  return () => {
    for (const t of timers.values()) clearTimeout(t)
    off()
  }
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
      await refreshRouterPrompt(s, e.id)
      upgraded++
    } catch (err) {
      s.logger.warn('upgrade: could not bring an employee up to date', { employeeId: e.id, err: errorMessage(err) })
    }
  }
  return { upgraded, reset }
}

const PRIVATE_BACKFILL = 'upgrade.privateBackfill'

/**
 * Private work is marked when it happens (src/private-work.ts). Work from before that existed isn't:
 * this marks it once, oldest run first, so a mark flows from the run a DM caused to the runs and
 * sessions it started. Shared contexts (routers, procedure and trigger contexts) stay readable, as
 * for new work. Runs once per deployment (a setting records it).
 */
export async function backfillPrivateWork(s: Services): Promise<{ runs: number; sessions: number }> {
  if (await s.settings.get(PRIVATE_BACKFILL)) return { runs: 0, sessions: 0 }
  const actor = { type: 'system' as const, id: 'upgrade' }
  const marks = new Map<string, PrivateMark>()
  let runs = 0
  let sessions = 0
  const pageSize = 500
  for (let offset = 0; ; offset += pageSize) {
    const page = await s.records.query<Record<string, any>>('run', {
      orderBy: { field: 'createdAt', dir: 'asc' },
      limit: pageSize,
      offset,
    })
    for (const run of page.items) {
      const cause = (run.data.cause ?? {}) as { eventId?: string; parentRunId?: string }
      let mark: PrivateMark | null = markOf(run as any)
      if (cause.eventId) mark = mergeMarks(mark, await dmMarkOfEvent(s, await s.records.get('event', cause.eventId)))
      if (cause.parentRunId) mark = mergeMarks(mark, marks.get(cause.parentRunId) ?? null)
      if (!mark) continue
      marks.set(run.id, mark)
      if (!covers(markOf(run as any), mark)) {
        await s.records.update('run', run.id, { private: mark as any })
        runs++
      }
      const session = await s.sessions.get(String(run.data.sessionId))
      if (session && !(await isSharedContext(s.records, session)) && !covers(markOf(session as any), mark)) {
        await s.records.update('session', session.id, { private: mergeMarks(markOf(session as any), mark) as any })
        sessions++
      }
    }
    if (page.items.length < pageSize) break
  }
  await s.settings.set(PRIVATE_BACKFILL, { at: s.clock.iso(), runs, sessions }, actor)
  if (runs || sessions) s.logger.info('upgrade: marked earlier DM work private', { runs, sessions })
  return { runs, sessions }
}
