import type { Json } from '@mp/core'
import type { Subscription } from '@mp/events'
import { LOCAL_GIT_SYSTEM } from '@mp/git'
import { TERMINAL_RUN_STATES, type Run, type Session } from '@mp/sessions'
import type { Entry } from '@mp/store'
import { line } from './kit.ts'
import type { StdlibDeps } from './types.ts'

/**
 * What a session did and what it is waiting for, as `sessions.get`, `sessions.tree`, `sessions.list` and
 * the web UI show it (docs/spec.md#session-outcomes): each run with who asked, the request and the
 * outcome; and per session its last outcome, what it produced (merge requests, branches, shared files),
 * its document's first line and a derived `waitingFor`. Everything comes from records the harness
 * already keeps (runs, events, subscriptions, the session's meta), so it is the record, not a summary.
 */

/** Session meta key: what the session produced (branches pushed, files shared), newest last. */
export const PRODUCED_META = 'produced'
/** The most produced items a session keeps. */
const MAX_PRODUCED = 30
/** How long a one-line request or outcome may be. */
const LINE_CHARS = 200

export interface ProducedItem {
  kind: 'branch' | 'merge_request' | 'file'
  /** What it is: `mp/fix-login in local:portal`, a merge request URL, `/reports/q3.csv shared with Ana`. */
  what: string
  url?: string
  at: string
}

/** What a session produced, from its meta. */
export const producedOf = (s: Session): ProducedItem[] =>
  Array.isArray(s.data.meta?.[PRODUCED_META]) ? (s.data.meta![PRODUCED_META] as unknown as ProducedItem[]) : []

/** Adds a produced item to a session's meta (a repeat of the same item moves it to the end). */
export function withProduced(meta: Record<string, Json>, item: ProducedItem): Record<string, Json> {
  const list = (Array.isArray(meta[PRODUCED_META]) ? (meta[PRODUCED_META] as unknown as ProducedItem[]) : []).filter(
    (p) => !(p.kind === item.kind && p.what === item.what),
  )
  list.push(item)
  return { ...meta, [PRODUCED_META]: list.slice(-MAX_PRODUCED) as unknown as Json }
}

type Deps = Pick<StdlibDeps, 'directory' | 'events' | 'sessions' | 'records' | 'localProjects'>

/** A person or employee as runs name them: name and handles. */
export interface PersonView {
  contactId: string
  name: string
  kind?: string
  handles?: string[]
}

/** Caches lookups across the sessions of one call. */
export interface OutcomeCache {
  people: Map<string, Promise<PersonView | null>>
  branches: Map<string, Promise<Map<string, { ahead: number; behind: number }> | null>>
}

export const outcomeCache = (): OutcomeCache => ({ people: new Map(), branches: new Map() })

export function personView(deps: Pick<Deps, 'directory'>, id: string, cache?: OutcomeCache): Promise<PersonView | null> {
  const hit = cache?.people.get(id)
  if (hit) return hit
  const p = (async () => {
    const c = await deps.directory.contacts.get(id).catch(() => null)
    if (!c) return null
    const handles = (c.data.handles ?? []).map((h) => `${h.system}:${h.id}`)
    return { contactId: c.id, name: c.data.name, kind: c.data.kind, ...(handles.length ? { handles } : {}) }
  })()
  cache?.people.set(id, p)
  return p
}

/** "Ana Lima (slack:U0TEST0001, mp:ana)". */
export const personLine = (p: PersonView): string => (p.handles?.length ? `${p.name} (${p.handles.join(', ')})` : p.name)

/**
 * The request that started a run, in one line: the text of the event that caused it, else the
 * instruction it was started with (the first user entry it added), else its cause.
 */
export async function requestLine(deps: Deps, run: Run): Promise<string | undefined> {
  const eventId = run.data.cause.eventId
  if (eventId) {
    const ev = await deps.events.get(eventId).catch(() => null)
    const text = ev?.data.text ?? (ev?.data.payload as { text?: unknown } | undefined)?.text
    if (typeof text === 'string' && text.trim()) return line(text, LINE_CHARS)
  }
  // The run's own first entries, from its base: the "Your projects" note, then the instruction or event.
  const entries = deps.records.store.entries
  let at: string | null = run.data.base
  for (let i = 0; i < 4 && at; i++) {
    const next: Entry | undefined = (await entries.children(at)).find((e) => e.meta?.runId === run.id)
    if (!next) break
    const c = next.content as { text?: unknown } | null
    if ((next.kind === 'user' || next.kind === 'event') && typeof c?.text === 'string') return line(c.text, LINE_CHARS)
    at = next.id
  }
  const note = run.data.cause.note
  return note ? `${run.data.cause.type}: ${note}` : undefined
}

/** What a run that hasn't finished is waiting for, in one line. */
export function runWaitLine(run: Run): string | undefined {
  const d = run.data
  if (d.state === 'paused') return `paused${d.pauseReason ? `: ${line(d.pauseReason, 160)}` : ''}`
  if (d.state !== 'suspended' || !d.wait) return undefined
  const w = d.wait
  if (w.type === 'runs') return `run${w.runIds.length > 1 ? 's' : ''} ${w.runIds.join(', ')} (${w.mode})`
  if (w.type === 'delivery') return `a reply or event delivered to this session${w.timeoutAt ? ` (until ${w.timeoutAt})` : ''}`
  return `a timer until ${w.until}`
}

/** One run as sessions.get lists it. */
export async function runView(deps: Deps, run: Run, cache?: OutcomeCache): Promise<Record<string, Json>> {
  const d = run.data
  const requester = d.requesterId ? await personView(deps, d.requesterId, cache) : null
  const later: Json[] = []
  for (const r of d.requests ?? []) {
    const who = r.requesterId ? await personView(deps, r.requesterId, cache) : null
    const ev = await deps.events.get(r.eventId).catch(() => null)
    later.push({
      at: r.at,
      ...(who ? { by: personLine(who), contactId: who.contactId } : {}),
      ...(ev?.data.text ? { request: line(ev.data.text, LINE_CHARS) } : {}),
    })
  }
  const request = await requestLine(deps, run)
  const wait = runWaitLine(run)
  return {
    runId: run.id,
    at: d.startedAt ?? run.createdAt,
    ...(d.endedAt ? { endedAt: d.endedAt } : {}),
    state: d.state,
    mode: d.mode,
    cause: d.cause.type,
    ...(requester ? { requestedBy: personLine(requester), requesterId: requester.contactId } : {}),
    ...(request ? { request } : {}),
    ...(later.length ? { laterRequests: later } : {}),
    ...(d.result?.output ? { outcome: line(d.result.output, LINE_CHARS) } : {}),
    ...(d.result?.error ? { error: line(d.result.error, LINE_CHARS) } : {}),
    ...(d.result?.result !== undefined ? { result: d.result.result } : {}),
    ...(wait ? { waitingFor: wait } : {}),
  }
}

const MR_URL_RE = /https?:\/\/[^\s)>\]"'`]+\/-\/merge_requests\/\d+/g

/** The first line of a session document, without markdown heading marks. */
export function documentLine(doc: string | undefined): string | undefined {
  const first = (doc ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*#+\s*/, '').trim())
    .find(Boolean)
  return first ? line(first, 160) : undefined
}

/** The ahead/behind of a local repository's branches, cached per call. */
function localBranches(deps: Deps, slug: string, cache: OutcomeCache) {
  const hit = cache.branches.get(slug)
  if (hit) return hit
  const p = (async () => {
    if (!deps.localProjects?.branches) return null
    try {
      const b = await deps.localProjects.branches(slug)
      return new Map(b.branches.map((x) => [x.name, { ahead: x.ahead, behind: x.behind }]))
    } catch {
      return null
    }
  })()
  cache.branches.set(slug, p)
  return p
}

/** What one subscription says the session is waiting for: a review of its branch or merge request. */
async function subscriptionWait(deps: Deps, sub: Subscription, cache: OutcomeCache): Promise<string | undefined> {
  const { system, id } = sub.data.subject
  if (system === LOCAL_GIT_SYSTEM) {
    const slash = id.indexOf('/')
    if (slash < 0) return undefined
    const slug = id.slice(0, slash)
    const branch = id.slice(slash + 1)
    const branches = await localBranches(deps, slug, cache)
    if (!branches) return `review of ${branch} in local project ${slug}`
    const b = branches.get(branch)
    // Gone: merged or deleted (its subscription ends shortly).
    if (!b) return undefined
    if (b.ahead === 0) return undefined
    return `review of ${branch} in local project ${slug} (${b.ahead} commit${b.ahead === 1 ? '' : 's'} ahead)`
  }
  if (system === 'gitlab') {
    // Merge request subscriptions end when it's merged or closed: an active one is an open merge request.
    const m = /^(.+)!(\d+)$/.exec(id)
    if (m) return `MR !${m[2]} review (${m[1]})`
  }
  return undefined
}

export interface SessionOutcome {
  /** The last finished run's outcome, shortened. */
  lastOutcome?: string
  /** When that run ended. */
  lastOutcomeAt?: string
  /** Merge requests, branches and shared files. */
  produced?: string[]
  /** The session document's first line. */
  document?: string
  /** What the session is waiting for: reviews of what it produced, a suspended or paused run's wait. */
  waitingFor?: string[]
}

/** The outcome of a session (see the file comment). */
export async function sessionOutcome(deps: Deps, s: Session, cache: OutcomeCache = outcomeCache()): Promise<SessionOutcome> {
  const runs = await deps.sessions.runs({ sessionId: s.id, newestFirst: true, limit: 10 })
  const last = runs.find((r) => TERMINAL_RUN_STATES.includes(r.data.state) && (r.data.result?.output || r.data.result?.error))
  const subs = await deps.events.subscriptions.forSession(s.id).catch(() => [] as Subscription[])

  const produced: string[] = []
  const add = (what: string) => {
    if (!produced.includes(what)) produced.push(what)
  }
  for (const sub of subs) {
    const { system, id } = sub.data.subject
    if (system === 'gitlab' && /!\d+$/.test(id)) add(`merge request gitlab:${id}`)
  }
  for (const r of runs)
    for (const url of `${r.data.result?.output ?? ''}`.match(MR_URL_RE) ?? []) add(`merge request ${url.replace(/[.,;:]+$/, '')}`)
  for (const p of producedOf(s)) add(p.kind === 'merge_request' ? `merge request ${p.what}` : `${p.kind} ${p.what}`)
  // Branches checked out but not recorded as pushed (older sessions): their checkouts say which.
  if (!producedOf(s).some((p) => p.kind === 'branch'))
    for (const sub of subs) if (sub.data.subject.system === LOCAL_GIT_SYSTEM) add(`branch ${sub.data.subject.id} (local)`)

  const waitingFor: string[] = []
  if (s.data.status !== 'abandoned') {
    for (const r of runs) {
      if (TERMINAL_RUN_STATES.includes(r.data.state)) continue
      const w = runWaitLine(r)
      if (w) waitingFor.push(w)
    }
    for (const sub of subs) {
      const w = await subscriptionWait(deps, sub, cache)
      if (w && !waitingFor.includes(w)) waitingFor.push(w)
    }
  }
  const doc = documentLine(s.data.document)
  return {
    ...(last
      ? {
          lastOutcome: line(last.data.result?.output ?? `failed: ${last.data.result?.error ?? ''}`, LINE_CHARS),
          ...(last.data.endedAt ? { lastOutcomeAt: last.data.endedAt } : {}),
        }
      : {}),
    ...(produced.length ? { produced: produced.slice(0, 10) } : {}),
    ...(doc ? { document: doc } : {}),
    ...(waitingFor.length ? { waitingFor } : {}),
  }
}
