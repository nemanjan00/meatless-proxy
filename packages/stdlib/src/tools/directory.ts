import { ConflictError, type Json } from '@mp/core'
import type { Contact, Procedure, Project } from '@mp/directory'
import type { Session } from '@mp/sessions'
import { Roles, clip, fail, line, ok, str, type Kit } from '../kit.ts'
import { createProcedureContexts, isArchived } from '../procedure-context.ts'

const contactView = (c: Contact): Json => ({
  id: c.id,
  name: c.data.name,
  kind: c.data.kind,
  ...(c.data.role ? { role: c.data.role } : {}),
  ...(c.data.team ? { team: c.data.team } : {}),
  ...(c.data.email ? { email: c.data.email } : {}),
  ...(c.data.status ? { status: c.data.status } : {}),
})

const projectView = (p: Project): Json => ({
  id: p.id,
  name: p.data.name,
  ...(p.data.aliases?.length ? { aliases: p.data.aliases } : {}),
  ...(p.data.status ? { status: p.data.status } : {}),
  ...(p.data.description ? { description: line(p.data.description, 300) } : {}),
})

const procedureView = (p: Procedure): Json => ({
  id: p.id,
  name: p.data.name,
  applies: line(p.data.applies, 300),
  ...(p.data.ownerId ? { ownerId: p.data.ownerId } : {}),
})

export function registerDirectoryTools(kit: Kit): void {
  const { deps } = kit
  const { directory, records, sessions } = deps

  kit.tool(
    {
      name: 'directory.find_contact',
      description:
        'Find people (and AI employees) in the company directory by name, email, role, team or text, or resolve a handle in a system (e.g. {system:"slack", id:"U123"}).',
      effect: 'read',
      params: {
        properties: {
          text: { type: 'string' },
          handle: {
            type: 'object',
            properties: { system: { type: 'string' }, id: { type: 'string' } },
            required: ['system', 'id'],
          },
          limit: { type: 'number' },
        },
      },
    },
    async (a) => {
      if (a.handle) {
        const c = await directory.contacts.byHandle(a.handle.system, a.handle.id)
        return ok({ contacts: c ? [contactView(c)] : [] })
      }
      const text = str(a.text)
      if (!text) return fail('give text or a handle')
      const byEmail = text.includes('@') && !text.startsWith('@') ? await directory.contacts.byEmail(text) : null
      const found = byEmail ? [byEmail] : await directory.contacts.search(text, { limit: Math.min(a.limit ?? 10, 50) })
      return ok({ contacts: found.map(contactView) })
    },
  )

  kit.tool(
    {
      name: 'directory.get_contact',
      description:
        'A contact: role, team, manager, handles, permissions (what they may ask for), bio and the projects they are on.',
      effect: 'read',
      params: { properties: { id: { type: 'string' } }, required: ['id'] },
    },
    async (a) => {
      const c = await directory.contacts.require(a.id)
      const projects = await directory.projects.forContact(c.id)
      const { name, kind, handles, email, role, team, manager, permissions, bio, status, ...extra } = c.data
      return ok({
        id: c.id,
        name,
        kind,
        ...(handles?.length ? { handles: handles as unknown as Json } : {}),
        ...(email ? { email } : {}),
        ...(role ? { role } : {}),
        ...(team ? { team } : {}),
        ...(manager ? { manager } : {}),
        ...(permissions ? { permissions } : {}),
        ...(bio ? { bio: clip(bio, 1000) } : {}),
        ...(status ? { status } : {}),
        ...(Object.keys(extra).length
          ? {
              extra:
                JSON.stringify(extra).length <= 2000 ? (extra as Json) : { keys: Object.keys(extra), note: 'large; keys only' },
            }
          : {}),
        projects: projects.map((m) => ({ id: m.project.id, name: m.project.data.name, roles: m.roles })),
      })
    },
  )

  kit.tool(
    {
      name: 'directory.find_project',
      description: 'Find projects by name, alias or description.',
      effect: 'read',
      params: { properties: { text: { type: 'string' }, limit: { type: 'number' } }, required: ['text'] },
    },
    async (a) => {
      const text = str(a.text)
      if (!text) return fail('text is required')
      const exact = await directory.projects.byName(text)
      const found = await directory.projects.search(text, { limit: Math.min(a.limit ?? 10, 50) })
      const all = exact ? [exact, ...found.filter((p) => p.id !== exact.id)] : found
      return ok({ projects: all.map(projectView) })
    },
  )

  kit.tool(
    {
      name: 'directory.get_project',
      description: 'A project: description, status, owner, members with their roles, repositories, links and its docs.',
      effect: 'read',
      params: { properties: { id: { type: 'string' } }, required: ['id'] },
    },
    async (a) => {
      const p = await directory.projects.require(a.id)
      const owner = await directory.projects.owner(p.id)
      const members = await directory.projects.members(p.id)
      const docs = await deps.docs.forOwner({ kind: 'project', id: p.id })
      return ok({
        ...(projectView(p) as object),
        ...(p.data.description ? { description: clip(p.data.description, 1500) } : {}),
        owner: owner ? { id: owner.id, name: owner.data.name } : null,
        members: members.map((m) => ({ id: m.contact.id, name: m.contact.data.name, roles: m.roles })),
        repositories: (p.data.repositories ?? []).map((r, i) => ({ index: i, ...r })) as Json,
        links: (p.data.links ?? []) as Json,
        docs: docs.map((d) => ({ id: d.id, title: d.data.title, ...(d.data.path ? { path: d.data.path } : {}) })),
      })
    },
  )

  kit.tool(
    {
      name: 'directory.projects_of',
      description:
        'Which projects you work on (no contactId), or the projects a contact is linked to, with their roles (e.g. "what does Ana own?": role owner).',
      effect: 'read',
      params: {
        properties: {
          contactId: { type: 'string', description: 'Default: you.' },
          role: { type: 'string' },
        },
      },
    },
    async (a, ctx) => {
      const contactId = str(a.contactId) ?? (await kit.employee(ctx.employeeId)).data.contactId
      await directory.contacts.require(contactId)
      const list = await directory.projects.forContact(contactId, a.role ? { role: a.role } : {})
      const projects = list.map((m) => ({ ...(projectView(m.project) as object), roles: m.roles }))
      return ok({
        contactId,
        projects,
        ...(!projects.length && !a.contactId
          ? { note: 'No project is assigned to you yet. Ask an admin to assign you projects (on your employee page).' }
          : {}),
      })
    },
  )

  kit.tool(
    {
      name: 'directory.find_procedure',
      description:
        'Find the procedures that apply to a piece of work (deploys, access requests, releases…), best first. Follow a procedure as written; if one is ambiguous, ask its owner.',
      effect: 'read',
      params: {
        properties: {
          text: { type: 'string', description: 'What the work is about.' },
          projectIds: { type: 'array', items: { type: 'string' }, description: 'Only procedures for these projects (or all).' },
          limit: { type: 'number' },
        },
        required: ['text'],
      },
    },
    async (a) => {
      const text = str(a.text)
      if (!text) return fail('text is required')
      const hits = await directory.procedures.find(text, {
        ...(a.projectIds ? { projectIds: a.projectIds } : {}),
        limit: Math.min(a.limit ?? 5, 20),
      })
      return ok({ procedures: hits.map((h) => ({ ...(procedureView(h.record) as object), score: h.score })) })
    },
  )

  kit.tool(
    {
      name: 'directory.get_procedure',
      description: 'A procedure: when it applies, owner, approvals, checklist, skills and its steps (body).',
      effect: 'read',
      params: { properties: { id: { type: 'string' } }, required: ['id'] },
    },
    async (a) => {
      const p = await directory.procedures.require(a.id)
      return ok({
        ...(procedureView(p) as object),
        approvals: p.data.approvals ?? [],
        checklist: p.data.checklist ?? [],
        skills: p.data.skills ?? [],
        projectIds: p.data.projectIds ?? [],
        ...(p.data.contextSessionId ? { contextSessionId: p.data.contextSessionId } : {}),
        body: clip(p.data.body ?? '', 6000),
      })
    },
  )

  /** The procedure's context session, created (from its body) the first time it's needed (../procedure-context.ts). */
  const contexts = createProcedureContexts(kit.registry, deps, kit)
  const contextOf = (p: Procedure, employeeId: string, toolset: string[]): Promise<Session> =>
    contexts.ensure(p.id, employeeId, { toolset })

  kit.tool(
    {
      name: 'procedures.run',
      description:
        "Run a procedure for a piece of work. Always use this when a procedure applies, instead of doing its steps yourself: it forks the procedure's context (which already knows the steps and approvers), copies the procedure's checklist into the fork, links it to this session and starts it with your description of the work. Returns sessionId and runId (sessions.wait on it for the result).",
      effect: 'idempotent',
      params: {
        properties: {
          procedureId: { type: 'string' },
          work: { type: 'string', description: 'The piece of work: what, for whom, and everything the fork needs.' },
          title: { type: 'string' },
        },
        required: ['procedureId', 'work'],
      },
    },
    async (a, ctx) => {
      const work = str(a.work)
      if (!work) return fail('work is required')
      const output = await kit.once('procedures.run', ctx, async () => {
        const caller = await kit.ownSession(undefined, ctx)
        const p = await directory.procedures.require(a.procedureId)
        if (isArchived(p)) throw new ConflictError(`procedure "${p.data.name}" is archived: it no longer runs`)
        const context = await contextOf(p, ctx.employeeId, caller.data.toolset)
        await kit.checkLimits(ctx.employeeId, context, 1)
        const fork = await sessions.fork(context.id, {
          title: str(a.title) ?? `${p.data.name}: ${line(work, 60)}`,
          actor: kit.actor(ctx),
        })
        await kit.patchMeta(fork.id, (m) => ({ ...m, procedureId: p.id }))
        if (p.data.checklist?.length)
          await deps.checklists.fromTemplate(
            fork.id,
            p.data.checklist.map((i) => ({ ...i, addedBy: `procedure:${p.id}` })),
          )
        const act = { actor: kit.actor(ctx) }
        await records.link({ kind: 'session', id: fork.id }, { kind: 'session', id: caller.id }, Roles.procedureFor, {}, act)
        await records.link({ kind: 'session', id: fork.id }, { kind: 'procedure', id: p.id }, Roles.runsProcedure, {}, act)
        for (const pid of p.data.projectIds ?? [])
          await records.link({ kind: 'session', id: fork.id }, { kind: 'project', id: pid }, Roles.worksOn, {}, act)
        if (ctx.requesterId && (await records.get('contact', ctx.requesterId)))
          await records.link(
            { kind: 'session', id: fork.id },
            { kind: 'contact', id: ctx.requesterId },
            Roles.requestedBy,
            {},
            act,
          )
        const run = await kit.startRun(fork.id, ctx, {
          instruction: `Run this procedure for the following work (requested via session ${caller.id}):\n\n${work}`,
          type: 'fork',
          note: `procedure ${p.id}`,
        })
        return { sessionId: fork.id, slug: fork.data.slug, runId: run.id, contextSessionId: context.id, procedure: p.data.name }
      })
      return ok(output)
    },
  )
}
