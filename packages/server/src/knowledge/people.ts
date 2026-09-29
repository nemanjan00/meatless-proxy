import type * as Api from '@mp/api'
import { ConflictError, DeniedError, NotFoundError, ValidationError, errorMessage, isMpError, type KindSchema } from '@mp/core'
import type { Contact, ContactData } from '@mp/directory'
import type { StoredRecord } from '@mp/store'
import { type Context, Hono } from 'hono'
import { ACCESS_LEVELS, type Access, type AuthSessionData, defineAuthKinds } from '../auth/access.ts'
import { listApiTokens, revokeApiToken } from '../auth/api-tokens.ts'
import { principalOf } from '../auth/guard.ts'
import { LOGIN_LINK_TTL_MS, contactByEmail, createLoginLink } from '../auth/sessions.ts'
import type { ChatVisibility } from '../auth/visibility.ts'
import { BadRequestError, boolParam, jsonBody, requireString } from '../http/util.ts'
import { actorOf } from '../http/views.ts'
import type { Services } from '../services.ts'
import { MemoryViews } from './memories.ts'
import { DirectorySnapshot, readAll } from './names.ts'

/**
 * The people API (docs/spec.md "Contacts", "Sign-in and roles" and "Web UI › People", `@mp/api`
 * knowledge.ts): the directory of people, AI employees and local agents, with their access,
 * projects and last sign-in. Admins add people (and hand them a one-time sign-in link, sent as
 * a Slack DM when they have a Slack handle and Slack is set up), change access, and deactivate
 * people: a deactivated person can't sign in, and their sign-ins and tokens are revoked at once.
 */

/** Remembers a create by its idempotency key, so a double submit adds one person. */
const REQUEST_KIND = 'person_request'
const requestSchema: KindSchema = {
  kind: REQUEST_KIND,
  prefix: 'peq',
  description: 'The person an add-person request created, by idempotency key: a repeated request returns them.',
  core: [
    { name: 'state', type: 'enum', values: ['pending', 'done'], required: true },
    { name: 'contactId', type: 'string' },
  ],
}

const MAX_FIELD = 200

function optField(v: unknown, name: string): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v !== 'string') throw new BadRequestError(`${name} must be a string`)
  const t = v.trim()
  if (t.length > MAX_FIELD) throw new BadRequestError(`${name} must be at most ${MAX_FIELD} characters`)
  return t || null
}

function parseAccess(v: unknown): Access | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || !(ACCESS_LEVELS as readonly string[]).includes(v))
    throw new BadRequestError('access must be viewer, member or admin')
  return v as Access
}

function parseHandles(v: unknown): Api.PersonHandle[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw new BadRequestError('handles must be a list of { system, id }')
  const out: Api.PersonHandle[] = []
  for (const h of v) {
    const system = typeof h?.system === 'string' ? h.system.trim().toLowerCase() : ''
    const id = typeof h?.id === 'string' ? h.id.trim().replace(/^@/, '') : ''
    if (!system || !id) throw new BadRequestError('each handle needs a system (slack, gitlab, linear…) and an id')
    if (system === 'mp') throw new BadRequestError('the harness handle (mp) is set from the name, not here')
    if (!out.some((x) => x.system === system && x.id === id)) out.push({ system, id })
  }
  return out
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const typeOf = (c: Contact): Api.PersonType => c.data.kind ?? 'person'

/** Builds the people views from one directory snapshot. */
export class PeopleViews {
  private constructor(
    private readonly s: Services,
    readonly names: DirectorySnapshot,
    private readonly me: { contactId: string; access: Access },
    private readonly signIns: Map<string, { lastSignInAt: string | null; lastSeenAt: string | null }>,
    private readonly projects: Map<string, { id: string; name: string; roles: string[] }[]>,
  ) {}

  static async load(s: Services, me: { contactId: string; access: Access }): Promise<PeopleViews> {
    defineAuthKinds(s.records)
    const [names, sessions, links] = await Promise.all([
      DirectorySnapshot.load(s),
      readAll<AuthSessionData>(s, 'auth_session'),
      s.records.links({ from: { kind: 'contact' }, to: { kind: 'project' } }),
    ])
    const signIns = new Map<string, { lastSignInAt: string | null; lastSeenAt: string | null }>()
    for (const a of sessions) {
      const cur = signIns.get(a.data.contactId) ?? { lastSignInAt: null, lastSeenAt: null }
      if (a.data.via !== 'rotation' && (!cur.lastSignInAt || a.data.createdAt > cur.lastSignInAt))
        cur.lastSignInAt = a.data.createdAt
      if (!cur.lastSeenAt || a.data.lastSeenAt > cur.lastSeenAt) cur.lastSeenAt = a.data.lastSeenAt
      signIns.set(a.data.contactId, cur)
    }
    const projects = new Map<string, { id: string; name: string; roles: string[] }[]>()
    for (const l of links) {
      const p = names.projects.get(l.to.id)
      if (!p) continue
      const list = projects.get(l.from.id) ?? []
      const hit = list.find((x) => x.id === p.id)
      if (hit) {
        if (!hit.roles.includes(l.role)) hit.roles.push(l.role)
      } else list.push({ id: p.id, name: p.data.name, roles: [l.role] })
      projects.set(l.from.id, list)
    }
    for (const list of projects.values()) list.sort((a, b) => a.name.localeCompare(b.name))
    return new PeopleViews(s, names, me, signIns, projects)
  }

  /** Admins see everyone's sign-in times and tokens; people see their own. */
  private private(contactId: string) {
    return this.me.access === 'admin' || this.me.contactId === contactId
  }

  item(c: Contact): Api.PersonItem {
    const type = typeOf(c)
    const e = this.names.employeeByContact.get(c.id)
    const seen = this.private(c.id) ? this.signIns.get(c.id) : undefined
    const sponsor = type === 'agent' && typeof c.data.sponsor === 'string' ? this.names.person(c.data.sponsor) : null
    const access = c.data.access as Access | undefined
    return {
      contact: c as unknown as Api.ApiRecord<Api.PersonRecordData>,
      type,
      ...(e ? { employeeId: e.id } : {}),
      access: type === 'person' ? (access && ACCESS_LEVELS.includes(access) ? access : 'viewer') : null,
      deactivated: !!c.data.deactivatedAt,
      lastSignInAt: seen?.lastSignInAt ?? null,
      lastSeenAt: seen?.lastSeenAt ?? null,
      projects: this.projects.get(c.id) ?? [],
      sponsor: sponsor ? { contactId: sponsor.contactId, name: sponsor.name } : null,
    }
  }

  all(): Contact[] {
    return [...this.names.contacts.values()].sort((a, b) => a.data.name.localeCompare(b.data.name))
  }

  canEdit(c: Contact): boolean {
    if (this.me.access === 'admin') return true
    return this.me.access === 'member' && typeOf(c) === 'person'
  }

  async detail(c: Contact, vis: ChatVisibility): Promise<Api.PersonDetail> {
    const item = this.item(c)
    const reports = this.all()
      .filter((o) => o.data.manager === c.id)
      .map((o) => this.names.person(o.id)!)
    // Memories about a person are theirs and admins'; about an AI employee or agent, everyone's.
    let memoriesAbout: number | null = null
    if (item.type !== 'person' || this.private(c.id)) {
      const mv = await MemoryViews.load(this.s, vis, this.me)
      memoriesAbout = (await mv.visibleRows()).filter(
        (r) => r.about.some((a) => a.id === c.id) || r.memory.data.scope?.id === c.id,
      ).length
    }
    const tokens =
      item.type === 'person' && this.private(c.id)
        ? (await listApiTokens(this.s, c.id)).map((t) => ({ ...t }) satisfies Api.ApiToken)
        : null
    return {
      ...item,
      manager: this.names.person(c.data.manager),
      reports,
      memoriesAbout,
      tokens,
      canEdit: this.canEdit(c),
      canAdmin: this.me.access === 'admin' && item.type === 'person',
    }
  }
}

/** Filters `GET /api/people` rows. */
export function filterPeople(items: Api.PersonItem[], q: Record<string, string | undefined>): Api.PersonItem[] {
  const words = (q.text ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const withDeactivated = q.deactivated === undefined || q.deactivated === '' ? true : boolParam(q.deactivated)
  return items.filter((i) => {
    const d = i.contact.data
    if (q.type && i.type !== q.type) return false
    if (q.access && i.access !== q.access) return false
    if (q.team && (d.team ?? '').toLowerCase() !== q.team.toLowerCase()) return false
    if (!withDeactivated && i.deactivated) return false
    if (words.length) {
      const hay = [d.name, d.email, d.role, d.team, ...(d.handles ?? []).map((h) => `${h.system} ${h.id}`)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      if (!words.every((w) => hay.includes(w))) return false
    }
    return true
  })
}

/**
 * Sends a sign-in link as a Slack DM, when the person has a Slack handle and Slack is set up (the
 * deployment's bot token, else the first employee's). Never throws: says why it wasn't sent.
 */
export async function sendSignInDm(
  s: Services,
  c: Contact,
  url: string,
): Promise<Pick<Api.SignInLinkResult, 'sentVia' | 'notSent'>> {
  const handle = c.data.handles?.find((h) => h.system === 'slack')
  if (!handle) return { sentVia: null, notSent: 'They have no Slack handle, so send it yourself.' }
  const ints = s.integrations
  if (!ints?.specs.slack) return { sentVia: null, notSent: 'Slack is not enabled here, so send it yourself.' }
  try {
    const candidates = [undefined, ...(await s.directory.employees.list({ limit: 50 })).items.map((e) => e.id)]
    for (const employeeId of candidates) {
      const inst = await ints.instanceFor('slack', employeeId)
      if (!inst.hasToken) continue
      const dm = await inst.callTool('open_dm', { user: handle.id })
      const channel = (dm.output as { channel?: unknown } | null)?.channel
      if (dm.isError || typeof channel !== 'string' || !channel)
        return { sentVia: null, notSent: "Slack couldn't open a DM with them (check their Slack user id)." }
      const minutes = Math.round(LOGIN_LINK_TTL_MS / 60_000)
      const text = `Here is your sign-in link for the AI employees' workspace. It works once, for ${minutes} minutes: <${url}|Sign in>`
      const posted = await inst.callTool('post_message', { channel, text })
      if (posted.isError) return { sentVia: null, notSent: "Slack didn't take the message, so send it yourself." }
      return { sentVia: 'slack' }
    }
    return { sentVia: null, notSent: 'Slack has no bot token set up, so send it yourself.' }
  } catch (err) {
    s.logger.warn('sign-in link DM failed', { contactId: c.id, err: errorMessage(err) })
    return { sentVia: null, notSent: "Slack couldn't be reached, so send it yourself." }
  }
}

export function peopleRoutes(s: Services, vis: ChatVisibility): Hono {
  const app = new Hono()
  defineAuthKinds(s.records)
  if (!s.records.kinds.has(REQUEST_KIND)) s.records.kinds.define(requestSchema)
  const me = (c: Context) => {
    const p = principalOf(c)
    return { contactId: p.contactId, access: p.access }
  }
  const load = (c: Context) => PeopleViews.load(s, me(c))
  const requireContact = async (id: string) => {
    const c = await s.directory.contacts.get(id)
    if (!c) throw new NotFoundError('person', id)
    return c
  }
  const requirePerson = async (id: string) => {
    const c = await requireContact(id)
    if (typeOf(c) !== 'person') throw new BadRequestError('only people sign in: AI employees and agents are managed elsewhere')
    return c
  }
  const detail = async (c: Context, id: string) => (await load(c)).detail(await requireContact(id), vis)

  const checkEmail = async (email: string | null | undefined, self?: string) => {
    if (!email) return
    if (!EMAIL_RE.test(email)) throw new BadRequestError('that email address looks wrong')
    const other = await contactByEmail(s, email)
    if (other && other.id !== self)
      throw new ConflictError(`${other.data.name} already has the email ${email}`, { contactId: other.id })
  }
  const checkManager = async (manager: string | null | undefined, self?: string) => {
    if (!manager) return
    if (manager === self) throw new BadRequestError('someone cannot be their own manager')
    await requireContact(manager)
  }

  const link = async (c: Context, contact: Contact, send: boolean): Promise<Api.SignInLinkResult> => {
    const l = await createLoginLink(s, contact.id, { createdBy: me(c).contactId })
    s.logger.info('sign-in link created', { contactId: contact.id, by: me(c).contactId })
    const sent = send ? await sendSignInDm(s, contact, l.url) : { sentVia: null }
    return { url: l.url, expiresAt: l.expiresAt, ...sent }
  }

  /** The people with admin access who can still sign in. */
  const activeAdmins = async () =>
    (await readAll<ContactData>(s, 'contact')).filter(
      (x) => x.data.kind === 'person' && x.data.access === 'admin' && !x.data.deactivatedAt && x.data.status !== 'left',
    )

  app.get('/api/people', async (c) => {
    const v = await load(c)
    return c.json(
      filterPeople(
        v.all().map((x) => v.item(x)),
        c.req.query(),
      ),
    )
  })

  app.get('/api/people/:id', async (c) => c.json(await detail(c, c.req.param('id'))))

  app.post('/api/people', async (c) => {
    const body = await jsonBody<Record<string, unknown>>(c)
    const name = optField(requireString(body.name, 'name'), 'name')!
    const email = optField(body.email, 'email')?.toLowerCase() ?? undefined
    const access = parseAccess(body.access) ?? 'viewer'
    const role = optField(body.role, 'role') ?? undefined
    const team = optField(body.team, 'team') ?? undefined
    const manager = optField(body.manager, 'manager') ?? undefined
    const handles = parseHandles(body.handles)
    const key =
      typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim() ? body.idempotencyKey.trim().slice(0, 200) : null
    const send = body.sendSignInLink === true

    // A repeated request (double submit, retry) returns the person the first one added.
    let reservation: StoredRecord | null = null
    if (key) {
      const prev = await s.records.getByKey<{ state: string; contactId?: string }>(REQUEST_KIND, key)
      if (prev?.data.state === 'done' && prev.data.contactId)
        return c.json({ created: false, person: await detail(c, prev.data.contactId) } satisfies Api.CreatedPerson, 200)
      if (prev) throw new ConflictError('the same request is still being handled: try again in a moment')
      try {
        reservation = await s.records.create(REQUEST_KIND, { state: 'pending' }, { key })
      } catch (e) {
        if (isMpError(e, 'conflict')) throw new ConflictError('the same request is still being handled: try again in a moment')
        throw e
      }
    }
    try {
      await checkEmail(email)
      await checkManager(manager)
      const contact = await s.directory.contacts.create(
        {
          name,
          kind: 'person',
          access,
          ...(email ? { email } : {}),
          ...(role ? { role } : {}),
          ...(team ? { team } : {}),
          ...(manager ? { manager } : {}),
          ...(handles?.length ? { handles } : {}),
        },
        { actor: actorOf(me(c).contactId) },
      )
      if (reservation) await s.records.update(REQUEST_KIND, reservation.id, { state: 'done', contactId: contact.id })
      s.logger.info('person added', { contactId: contact.id, access, by: me(c).contactId })
      const signInLink = send ? await link(c, contact, true) : undefined
      return c.json(
        { created: true, person: await detail(c, contact.id), ...(signInLink ? { signInLink } : {}) } satisfies Api.CreatedPerson,
        201,
      )
    } catch (e) {
      if (reservation) await s.records.delete(REQUEST_KIND, reservation.id).catch(() => {})
      throw e
    }
  })

  app.patch('/api/people/:id', async (c) => {
    const contact = await requireContact(c.req.param('id'))
    const v = await load(c)
    if (!v.canEdit(contact)) throw new DeniedError('only admins edit AI employees and agents')
    const body = await jsonBody<Record<string, unknown>>(c)
    if (body.version !== undefined && typeof body.version !== 'number') throw new BadRequestError('version must be a number')
    const patch: Partial<ContactData> = {}
    const name = optField(body.name, 'name')
    if (name === null) throw new BadRequestError('a name is required')
    if (name) patch.name = name
    for (const f of ['role', 'team'] as const) {
      const val = optField(body[f], f)
      if (val !== undefined) patch[f] = val ?? undefined
    }
    const email = optField(body.email, 'email')
    if (email !== undefined) {
      await checkEmail(email, contact.id)
      patch.email = email?.toLowerCase() ?? undefined
    }
    const manager = optField(body.manager, 'manager')
    if (manager !== undefined) {
      await checkManager(manager, contact.id)
      patch.manager = manager ?? undefined
    }
    const handles = parseHandles(body.handles)
    if (handles) {
      // The harness's own handle (@name in chat) stays as it is.
      const own = (contact.data.handles ?? []).filter((h) => h.system === 'mp')
      patch.handles = [...own, ...handles]
    }
    const access = parseAccess(body.access)
    if (access !== undefined) {
      if (me(c).access !== 'admin') throw new DeniedError("only admins can change someone's access")
      if (typeOf(contact) !== 'person') throw new BadRequestError('AI employees and agents have no sign-in access')
      if (contact.data.access === 'admin' && access !== 'admin' && !contact.data.deactivatedAt) {
        const admins = await activeAdmins()
        if (admins.length <= 1 && admins[0]?.id === contact.id)
          throw new ValidationError('they are the last admin: make someone else an admin first')
      }
      patch.access = access
    }
    if (!Object.keys(patch).length) throw new BadRequestError('nothing to change')
    try {
      await s.directory.contacts.update(contact.id, patch, {
        actor: actorOf(me(c).contactId),
        ...(typeof body.version === 'number' ? { expectedVersion: body.version } : {}),
      })
    } catch (e) {
      if (isMpError(e, 'conflict') && typeof body.version === 'number' && !/handle/.test(e.message))
        throw new ConflictError('someone else changed them meanwhile: reload and try again')
      throw e
    }
    return c.json(await detail(c, contact.id))
  })

  app.post('/api/people/:id/sign-in-link', async (c) => {
    const contact = await requirePerson(c.req.param('id'))
    if (contact.data.deactivatedAt) throw new ValidationError('they are deactivated: reactivate them first')
    const body = await jsonBody<{ send?: unknown }>(c)
    return c.json(await link(c, contact, body.send !== false), 201)
  })

  app.post('/api/people/:id/deactivate', async (c) => {
    const contact = await requirePerson(c.req.param('id'))
    const by = me(c).contactId
    if (contact.id === by) throw new ValidationError("you can't deactivate yourself: ask another admin")
    if (!contact.data.deactivatedAt) {
      if (contact.data.access === 'admin') {
        const admins = await activeAdmins()
        if (admins.length <= 1) throw new ValidationError('they are the last admin: make someone else an admin first')
      }
      await s.directory.contacts.update(contact.id, { deactivatedAt: s.clock.iso(), deactivatedBy: by }, { actor: actorOf(by) })
    }
    // Every sign-in and token they have stops working now (the guard refuses them anyway).
    const now = s.clock.iso()
    for (const a of await readAll<AuthSessionData>(s, 'auth_session'))
      if (a.data.contactId === contact.id && !a.data.endedAt)
        await s.records.update('auth_session', a.id, { endedAt: now, expiresAt: now }).catch(() => {})
    for (const t of await listApiTokens(s, contact.id)) if (!t.revoked) await revokeApiToken(s, t.id)
    s.logger.info('person deactivated', { contactId: contact.id, by })
    return c.json(await detail(c, contact.id))
  })

  app.post('/api/people/:id/reactivate', async (c) => {
    const contact = await requirePerson(c.req.param('id'))
    if (contact.data.deactivatedAt)
      await s.directory.contacts.update(
        contact.id,
        { deactivatedAt: undefined, deactivatedBy: undefined },
        { actor: actorOf(me(c).contactId) },
      )
    s.logger.info('person reactivated', { contactId: contact.id, by: me(c).contactId })
    return c.json(await detail(c, contact.id))
  })

  return app
}
