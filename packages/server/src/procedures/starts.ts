import type * as Api from '@mp/api'
import { CATCH_ALL_START_MESSAGE } from '@mp/api'
import { ValidationError, type Json } from '@mp/core'
import { CATCH_ALL_MESSAGE, type CreateTriggerInput, type Trigger, type TriggerMatch, isCatchAll } from '@mp/events'
import { BadRequestError } from '../http/util.ts'

/**
 * "How a procedure starts" (`ProcedureStart`, the UI's terms) to and from triggers. A trigger made
 * here keeps its start in `data.start`, so it reads back exactly; triggers made elsewhere (by an
 * employee's `triggers.*` tools, an import) are read from their match.
 */

/** The friendly refusal of a start that would match every event (the trigger rule is `CATCH_ALL_MESSAGE`). */
export const CATCH_ALL_START = CATCH_ALL_START_MESSAGE

/** Chat messages from people, not from employees' own sessions. */
const FROM_PEOPLE = { 'payload.author.kind': 'contact' }
const TAG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const CRON_FIELD = /^[\d*/,\-A-Za-z?LW#]+$/

const isObject = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Checks a start from a request body. Throws `BadRequestError` (400) for a malformed one. */
export function parseStart(raw: unknown): Api.ProcedureStart {
  if (!isObject(raw)) throw new BadRequestError('start must be an object with a kind')
  const filter = raw.filter
  if (filter !== undefined && filter !== null && !isObject(filter))
    throw new BadRequestError('filter must be a query object, e.g. {"payload.labels": {"$in": ["refund"]}}')
  const f = isObject(filter) && Object.keys(filter).length ? { filter } : {}
  const where = (v: unknown, what: string) => {
    if (v === undefined || v === null) return {}
    if (!isObject(v)) throw new BadRequestError(`${what}.where must be an object of field → value`)
    const clean = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x !== null && x !== undefined))
    return Object.keys(clean).length ? { where: clean } : {}
  }
  switch (raw.kind) {
    case 'channel': {
      const channelId = str(raw.channelId)
      if (!channelId) throw new BadRequestError('pick a channel')
      return { kind: 'channel', channelId, ...f }
    }
    case 'tag': {
      const tag = str(raw.tag)?.replace(/^@/, '')
      if (!tag || !TAG_RE.test(tag))
        throw new BadRequestError('a tag is letters, digits, dots, dashes or underscores, e.g. access-request')
      return { kind: 'tag', tag: tag.toLowerCase(), ...f }
    }
    case 'schedule': {
      const cron = str(raw.cron)
      const fields = cron?.split(/\s+/) ?? []
      if (!cron || fields.length !== 5 || !fields.every((x) => CRON_FIELD.test(x)))
        throw new BadRequestError('a schedule is a cron expression with five fields, e.g. 0 9 * * 1 (Mondays at 09:00)')
      const timezone = str(raw.timezone)
      return { kind: 'schedule', cron, ...(timezone ? { timezone } : {}), ...f }
    }
    case 'integration': {
      const source = str(raw.source)
      const type = str(raw.type)
      if (!source || !type) throw new BadRequestError('pick an integration and an event')
      return { kind: 'integration', source, type, ...where(raw.where, 'integration'), ...f }
    }
    case 'custom': {
      const source = str(raw.source)
      const type = str(raw.type)
      return { kind: 'custom', ...(source ? { source } : {}), ...(type ? { type } : {}), ...where(raw.where, 'custom'), ...f }
    }
    default:
      throw new BadRequestError('start.kind must be channel, tag, schedule, integration or custom')
  }
}

/** The trigger match (or schedule) for a start. A match that would catch everything is a `ValidationError` (422). */
export function matchFor(start: Api.ProcedureStart): { match: TriggerMatch; schedule?: { cron: string; timezone?: string } } {
  const filter = start.filter !== undefined && start.filter !== null ? start.filter : undefined
  let match: TriggerMatch
  switch (start.kind) {
    case 'schedule':
      return { match: {}, schedule: { cron: start.cron, ...(start.timezone ? { timezone: start.timezone } : {}) } }
    case 'channel':
      match = {
        source: 'chat',
        type: 'message.posted',
        where: { 'payload.channelId': start.channelId, ...FROM_PEOPLE },
        ...(filter ? { filter } : {}),
      }
      break
    case 'tag': {
      const tagged: Json = {
        type: { $in: ['message.posted', 'message.replied'] },
        'payload.tags': { $elemMatch: { type: 'unresolved', name: { $regex: `^${escapeRe(start.tag)}$`, $options: 'i' } } },
      }
      match = { source: 'chat', filter: filter ? { $and: [tagged, filter] } : tagged }
      break
    }
    case 'integration':
    case 'custom':
      match = {
        ...(start.source ? { source: start.source } : {}),
        ...(start.type ? { type: start.type } : {}),
        ...(start.where && Object.keys(start.where).length ? { where: start.where } : {}),
        ...(filter ? { filter } : {}),
      }
      break
  }
  if (isCatchAll(match)) throw new ValidationError(CATCH_ALL_START, [], { rule: CATCH_ALL_MESSAGE })
  return { match }
}

/** A new trigger for a start: it targets the procedure and forks its context per event. */
export function triggerInputFor(
  start: Api.ProcedureStart,
  o: { procedureId: string; employeeId: string; name: string; enabled?: boolean },
): CreateTriggerInput {
  const { match, schedule } = matchFor(start)
  return {
    name: o.name,
    employeeId: o.employeeId,
    ...(schedule ? { schedule } : { match }),
    target: { type: 'procedure', procedureId: o.procedureId },
    fork: true,
    // Each fork is one instance of the procedure: its work is kept, so follow-ups continue it.
    mode: 'continuing',
    enabled: o.enabled ?? true,
  }
}

/** The start of a trigger: the one it was made from, else read from its match. */
export function startOf(t: Trigger): Api.ProcedureStart {
  const stored = (t.data as { start?: unknown }).start
  if (isObject(stored)) {
    try {
      return parseStart(stored)
    } catch {
      // fall through to the match
    }
  }
  const d = t.data
  if (d.schedule)
    return { kind: 'schedule', cron: d.schedule.cron, ...(d.schedule.timezone ? { timezone: d.schedule.timezone } : {}) }
  const m = d.match ?? {}
  const filter = m.filter !== undefined ? { filter: m.filter } : {}
  const channelId = m.where?.['payload.channelId']
  if (m.source === 'chat' && typeof channelId === 'string') return { kind: 'channel', channelId, ...filter }
  const { 'payload.author.kind': _author, ...where } = m.where ?? {}
  if (m.source?.startsWith('integration:') && m.type && !m.type.includes('*'))
    return { kind: 'integration', source: m.source, type: m.type, ...(Object.keys(where).length ? { where } : {}), ...filter }
  return {
    kind: 'custom',
    ...(m.source ? { source: m.source } : {}),
    ...(m.type ? { type: m.type } : {}),
    ...(m.where && Object.keys(m.where).length ? { where: m.where } : {}),
    ...filter,
  }
}

/** A trigger's default name: the start in words, shortened. */
export function nameFor(description: string): string {
  return description.length <= 80 ? description : `${description.slice(0, 79)}…`
}
