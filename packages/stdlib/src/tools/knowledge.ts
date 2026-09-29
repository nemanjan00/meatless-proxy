import { NotFoundError, ValidationError, isMpError, type Json } from '@mp/core'
import type { Memory, MemoryKind } from '@mp/memory'
import { chapters, type DocData } from '@mp/records'
import { snippet } from '@mp/sessions'
import type { Ref, StoredRecord } from '@mp/store'
import type { ToolContext } from '@mp/tools'
import { checkRef, clip, fail, line, ok, str, type Kit } from '../kit.ts'

const OWNER_KINDS = ['project', 'session', 'procedure', 'contact', 'memory', 'employee']
const REF_KINDS = ['contact', 'project', 'session', 'memory', 'procedure', 'doc']

const docBrief = (d: StoredRecord<DocData>): Json => ({
  id: d.id,
  title: d.data.title,
  ...(d.data.owner ? { owner: d.data.owner as unknown as Json } : {}),
  ...(d.data.path ? { path: d.data.path } : {}),
  version: d.version,
})

const memoryView = (m: Memory, full = false): Json => ({
  id: m.id,
  summary: m.data.summary,
  kind: m.data.kind,
  scope: m.data.scope as unknown as Json,
  ...(m.data.content ? { content: full ? clip(m.data.content, 4000) : line(m.data.content, 200) } : {}),
  ...(m.data.verified ? { verified: m.data.verified } : {}),
  updatedAt: m.updatedAt,
  ...(m.data.employeeId ? {} : { shared: true }),
})

export function registerKnowledgeTools(kit: Kit): void {
  const { deps } = kit
  const { docs, records, memory, skills, files } = deps

  // ─── docs ───

  kit.tool(
    {
      name: 'docs.list',
      description: 'The markdown documents owned by a record (a project, session, procedure…).',
      effect: 'read',
      params: {
        properties: {
          owner: {
            type: 'object',
            properties: { kind: { type: 'string' }, id: { type: 'string' } },
            required: ['kind', 'id'],
          },
        },
        required: ['owner'],
      },
    },
    async (a) => {
      const owner = checkRef(a.owner, OWNER_KINDS, 'owner')
      const list = await docs.forOwner(owner)
      return ok({ docs: list.map(docBrief) })
    },
  )

  kit.tool(
    {
      name: 'docs.read',
      description:
        'Read a document, or one chapter of it (by heading). Long documents are truncated; read chapters to get the rest. Links like [[contact:con_…]] point to records by id.',
      effect: 'read',
      params: { properties: { id: { type: 'string' }, chapter: { type: 'string' } }, required: ['id'] },
    },
    async (a) => {
      const d = await docs.get(a.id)
      if (!d) throw new NotFoundError('doc', a.id)
      const heads = chapters(d.data.body).map((c) => `${'#'.repeat(c.level)} ${c.heading}`)
      if (a.chapter) {
        const body = await docs.chapter(d.id, a.chapter)
        if (body === null) return fail(`no chapter "${a.chapter}" in ${d.id}`, { chapters: heads.slice(0, 50) })
        return ok({ ...(docBrief(d) as object), chapter: a.chapter, body: clip(body, 8000) })
      }
      return ok({ ...(docBrief(d) as object), chapters: heads.slice(0, 50), body: clip(d.data.body, 8000) })
    },
  )

  kit.tool(
    {
      name: 'docs.search',
      description: 'Search documents by text. Returns ids, titles, owners and a snippet around the match.',
      effect: 'read',
      params: { properties: { text: { type: 'string' }, limit: { type: 'number' } }, required: ['text'] },
    },
    async (a) => {
      const text = str(a.text)
      if (!text) return fail('text is required')
      const res = await records.query<DocData>('doc', { text, limit: Math.min(Math.max(1, a.limit ?? 10), 50) })
      return ok({
        docs: res.items.map((d) => ({ ...(docBrief(d) as object), snippet: snippet(`${d.data.title}\n${d.data.body}`, text) })),
        total: res.total,
      })
    },
  )

  kit.tool(
    {
      name: 'docs.write',
      description:
        'Create a markdown document (owned by a project, procedure or this session by default), or replace the title/body of an existing one with id. Link records with [[kind:id]] or [[kind:id|label]].',
      effect: 'idempotent',
      params: {
        properties: {
          id: { type: 'string', description: 'Update this document instead of creating one.' },
          title: { type: 'string' },
          body: { type: 'string' },
          owner: {
            type: 'object',
            properties: { kind: { type: 'string' }, id: { type: 'string' } },
            required: ['kind', 'id'],
          },
          path: { type: 'string', description: 'Path-like name within the owner, e.g. runbooks/deploy.' },
        },
        required: ['body'],
      },
    },
    async (a, ctx) => {
      if (typeof a.body !== 'string') return fail('body is required')
      if (a.id) {
        const d = await docs.get(a.id)
        if (!d) throw new NotFoundError('doc', a.id)
        const u = await docs.update(
          d.id,
          { body: a.body, ...(str(a.title) ? { title: a.title } : {}) },
          { actor: kit.actor(ctx) },
        )
        return ok({ ...(docBrief(u) as object), updated: true })
      }
      if (!str(a.title)) return fail('title is required for a new document')
      const owner: Ref = a.owner ? checkRef(a.owner, OWNER_KINDS, 'owner') : { kind: 'session', id: ctx.sessionId }
      if (!(await records.get(owner.kind, owner.id))) throw new NotFoundError(owner.kind, owner.id)
      const output = await kit.once('docs.write', ctx, async () => {
        const d = await docs.create(
          { title: a.title, body: a.body, owner, ...(str(a.path) ? { path: a.path } : {}) },
          kit.actor(ctx),
        )
        return { ...(docBrief(d) as object), created: true }
      })
      return ok(output)
    },
  )

  kit.tool(
    {
      name: 'docs.write_chapter',
      description: "Write one chapter of a document (by heading): replaces the chapter's text, or appends it as a new chapter.",
      effect: 'idempotent',
      params: {
        properties: { id: { type: 'string' }, heading: { type: 'string' }, body: { type: 'string' } },
        required: ['id', 'heading', 'body'],
      },
    },
    async (a, ctx) => {
      if (!str(a.heading)) return fail('heading is required')
      const d = await docs.writeChapter(a.id, a.heading, String(a.body), kit.actor(ctx))
      return ok({ ...(docBrief(d) as object), chapter: a.heading })
    },
  )

  kit.tool(
    {
      name: 'docs.backlinks',
      description: 'What links to a record: the documents, memories and other records that mention it with [[kind:id]].',
      effect: 'read',
      params: {
        properties: { kind: { type: 'string' }, id: { type: 'string' } },
        required: ['kind', 'id'],
      },
    },
    async (a) => {
      const list = await records.backlinks({ kind: a.kind, id: a.id })
      return ok({
        backlinks: list.slice(0, 100).map((r) => ({
          kind: r.kind,
          id: r.id,
          title: String((r.data as any).title ?? (r.data as any).name ?? (r.data as any).summary ?? r.id),
        })),
        total: list.length,
      })
    },
  )

  // ─── memory ───

  const visibleMemory = async (id: string, ctx: ToolContext): Promise<Memory> => {
    const m = await memory.get(id)
    if (!m || (m.data.employeeId && m.data.employeeId !== ctx.employeeId)) throw new NotFoundError('memory', id)
    return m
  }

  kit.tool(
    {
      name: 'memory.remember',
      description:
        'Remember one fact, preference, feedback or decision for later sessions. One fact per memory: the same summary updates the existing memory. Scope it to a project or contact when only they should see it. Memories are yours unless shared: true.',
      effect: 'idempotent',
      params: {
        properties: {
          summary: { type: 'string', description: 'One line, used to decide relevance.' },
          content: { type: 'string', description: 'Markdown details; link records with [[kind:id]].' },
          kind: { type: 'string', enum: ['fact', 'preference', 'feedback', 'decision', 'other'] },
          scope: {
            type: 'object',
            description: '{type: company} (default), {type: project, id} or {type: contact, id}.',
            properties: { type: { type: 'string', enum: ['company', 'project', 'contact'] }, id: { type: 'string' } },
            required: ['type'],
          },
          about: {
            type: 'array',
            description: 'Records it is about: [{kind, id}].',
            items: { type: 'object', properties: { kind: { type: 'string' }, id: { type: 'string' } }, required: ['kind', 'id'] },
          },
          id: { type: 'string', description: 'Update this memory.' },
          shared: { type: 'boolean', description: 'Visible to every employee. Default false.' },
        },
        required: ['summary'],
      },
    },
    async (a, ctx) => {
      if (!str(a.summary)) return fail('summary is required')
      if (a.id) {
        const existing = await memory.get(a.id)
        if (existing) await visibleMemory(a.id, ctx)
      }
      const about = ((a.about ?? []) as unknown[]).map((r, i) => checkRef(r, REF_KINDS, `about[${i}]`))
      const { memory: m, created } = await memory.remember({
        ...(a.id ? { id: a.id } : {}),
        summary: a.summary,
        ...(a.content !== undefined ? { content: a.content } : {}),
        ...(a.kind ? { kind: a.kind as MemoryKind } : {}),
        ...(a.scope ? { scope: a.scope } : {}),
        source: { sessionId: ctx.sessionId, ...(ctx.requesterId ? { contactId: ctx.requesterId } : {}) },
        ...(a.shared ? {} : { employeeId: ctx.employeeId }),
        about,
        actor: kit.actor(ctx),
      })
      return ok({ ...(memoryView(m) as object), created })
    },
  )

  kit.tool(
    {
      name: 'memory.recall',
      description:
        'Recall memories by text and/or the records they are about (contacts, projects, sessions). Only memories this session may see are returned. Memories are claims about the past: check them against the source of truth before acting on them.',
      effect: 'read',
      params: {
        properties: {
          text: { type: 'string' },
          refs: {
            type: 'array',
            items: { type: 'object', properties: { kind: { type: 'string' }, id: { type: 'string' } }, required: ['kind', 'id'] },
          },
          kinds: { type: 'array', items: { type: 'string' } },
          limit: { type: 'number' },
          full: { type: 'boolean', description: 'Include full content. Default false (first line only).' },
        },
      },
    },
    async (a, ctx) => {
      const session = await kit.ownSession(undefined, ctx)
      const projectIds = await kit.projectsOf(session)
      const contactIds = [...(await kit.contactsOf(session)), ...(ctx.requesterId ? [ctx.requesterId] : [])]
      const refs = ((a.refs ?? []) as unknown[]).map((r, i) => checkRef(r, REF_KINDS, `refs[${i}]`))
      const hits = await memory.recall({
        ...(a.text ? { text: a.text } : {}),
        refs,
        ...(a.kinds ? { kinds: a.kinds } : {}),
        context: { employeeId: ctx.employeeId, projectIds, contactIds },
        limit: Math.min(Math.max(1, a.limit ?? 10), 50),
      })
      return ok({ memories: hits.map((h) => ({ ...(memoryView(h.memory, !!a.full) as object), score: h.score })) })
    },
  )

  kit.tool(
    {
      name: 'memory.link',
      description: 'Link a memory to a contact, project, session, procedure or another memory (role default about).',
      effect: 'idempotent',
      params: {
        properties: {
          memoryId: { type: 'string' },
          ref: { type: 'object', properties: { kind: { type: 'string' }, id: { type: 'string' } }, required: ['kind', 'id'] },
          role: { type: 'string' },
          unlink: { type: 'boolean', description: 'Remove the link instead.' },
        },
        required: ['memoryId', 'ref'],
      },
    },
    async (a, ctx) => {
      await visibleMemory(a.memoryId, ctx)
      const ref = checkRef(a.ref, REF_KINDS)
      if (a.unlink) await memory.unlink(a.memoryId, ref, str(a.role), { actor: kit.actor(ctx) })
      else await memory.link(a.memoryId, ref, str(a.role), { actor: kit.actor(ctx) })
      return ok({ memoryId: a.memoryId, [a.unlink ? 'unlinked' : 'linked']: ref as unknown as Json })
    },
  )

  kit.tool(
    {
      name: 'memory.forget',
      description: 'Delete a memory that is wrong or no longer true.',
      effect: 'idempotent',
      params: { properties: { memoryId: { type: 'string' } }, required: ['memoryId'] },
    },
    async (a, ctx) => {
      const m = await memory.get(a.memoryId)
      if (!m) return ok({ memoryId: a.memoryId, forgotten: true, note: 'it was already gone' })
      await visibleMemory(a.memoryId, ctx)
      await memory.forget(a.memoryId, { actor: kit.actor(ctx) })
      return ok({ memoryId: a.memoryId, forgotten: true })
    },
  )

  kit.tool(
    {
      name: 'memory.verify',
      description: 'Mark a memory as confirmed still true now (after checking it against the source of truth).',
      effect: 'idempotent',
      params: { properties: { memoryId: { type: 'string' } }, required: ['memoryId'] },
    },
    async (a, ctx) => {
      await visibleMemory(a.memoryId, ctx)
      const m = await memory.verify(a.memoryId, { actor: kit.actor(ctx) })
      return ok(memoryView(m))
    },
  )

  // ─── skills ───

  kit.tool(
    {
      name: 'skills.list',
      description: 'Skills available in this session (company skills plus those of its projects), with one-line descriptions.',
      effect: 'read',
    },
    async (_a, ctx) => {
      const session = await kit.ownSession(undefined, ctx)
      const list = await skills.available({ projectIds: await kit.projectsOf(session) })
      return ok({
        skills: list.map((s) => ({
          name: s.name,
          description: s.description,
          ...(s.scope.type === 'project' ? { projectId: s.scope.projectId! } : {}),
        })),
      })
    },
  )

  kit.tool(
    {
      name: 'skills.load',
      description: "Load a skill's full instructions (and the names of its attached files) by name.",
      effect: 'idempotent',
      params: {
        properties: { name: { type: 'string' }, file: { type: 'string', description: 'Also return this attached file.' } },
        required: ['name'],
      },
    },
    async (a, ctx) => {
      const session = await kit.ownSession(undefined, ctx)
      const loaded = await skills.load(a.name, { projectIds: await kit.projectsOf(session) })
      await kit.patchMeta(session.id, (m) => ({
        ...m,
        skills: { ...((m.skills as Record<string, Json>) ?? {}), [loaded.skill.data.name]: loaded.version },
      }))
      const file = a.file ? loaded.files.find((f) => f.path === a.file) : undefined
      if (a.file && !file) return fail(`skill ${loaded.skill.data.name} has no file ${a.file}`)
      return ok({
        name: loaded.skill.data.name,
        version: loaded.version,
        body: clip(loaded.body, 20000),
        files: loaded.files.map((f) => f.path),
        ...(file ? { file: { path: file.path, content: clip(file.content, 20000) } } : {}),
      })
    },
  )

  // ─── files ───

  const fsOf = (ctx: ToolContext) => files.forEmployee(ctx.employeeId)

  kit.tool(
    {
      name: 'fs.list',
      description: 'List a directory of your own filesystem (default /). What others share with you is under /shared/<owner>/….',
      effect: 'read',
      params: { properties: { path: { type: 'string' } } },
    },
    async (a, ctx) => {
      const entries = await fsOf(ctx).list(a.path ?? '/')
      return ok({
        entries: entries
          .slice(0, 500)
          .map((e) => ({ name: e.name, path: e.path, type: e.type, ...(e.size !== undefined ? { size: e.size } : {}) })),
        ...(entries.length > 500 ? { note: `showing 500 of ${entries.length}` } : {}),
      })
    },
  )

  kit.tool(
    {
      name: 'fs.read',
      description:
        'Read a file from your filesystem (or one shared with you under /shared/<owner>/…). To look at an image, use image.view instead.',
      effect: 'read',
      params: { properties: { path: { type: 'string' } }, required: ['path'] },
    },
    async (a, ctx) => {
      const f = await fsOf(ctx).read(a.path)
      return ok({
        path: f.path,
        size: f.size,
        mime: f.mime,
        encoding: f.encoding,
        version: f.version,
        content: f.encoding === 'utf8' ? clip(f.content, 20000) : f.size > 15000 ? '(binary; too large to show)' : f.content,
      })
    },
  )

  kit.tool(
    {
      name: 'fs.write',
      description:
        "Create or replace a file in your filesystem. Writing under /shared/<owner>/… needs a write share. Binary files, e.g. a PNG to attach to a chat message, go in as base64 with encoding: 'base64'.",
      effect: 'idempotent',
      params: {
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          encoding: { type: 'string', enum: ['utf8', 'base64'] },
        },
        required: ['path', 'content'],
      },
    },
    async (a, ctx) => {
      const f = await fsOf(ctx).write(a.path, a.content, {
        ...(a.encoding ? { encoding: a.encoding } : {}),
        actor: kit.actor(ctx),
      })
      return ok({ path: f.path, size: f.size, version: f.version })
    },
  )

  kit.tool(
    {
      name: 'fs.move',
      description: 'Move or rename a file or directory within one filesystem.',
      effect: 'idempotent',
      params: {
        properties: { from: { type: 'string' }, to: { type: 'string' }, overwrite: { type: 'boolean' } },
        required: ['from', 'to'],
      },
    },
    async (a, ctx) => {
      const fs = fsOf(ctx)
      try {
        await fs.move(a.from, a.to, { ...(a.overwrite ? { overwrite: true } : {}), actor: kit.actor(ctx) })
      } catch (e) {
        // A retry after the move already happened: the source is gone and the target is there.
        if (
          !isMpError(e, 'not_found') ||
          !(await fs.list(a.to).then(
            (l) => l.length > 0,
            () => false,
          ))
        )
          throw e
        return ok({ moved: { from: a.from, to: a.to }, note: 'already moved' })
      }
      return ok({ moved: { from: a.from, to: a.to } })
    },
  )

  kit.tool(
    {
      name: 'fs.delete',
      description: 'Delete a file, or a directory with recursive: true.',
      effect: 'idempotent',
      params: { properties: { path: { type: 'string' }, recursive: { type: 'boolean' } }, required: ['path'] },
    },
    async (a, ctx) => {
      try {
        await fsOf(ctx).delete(a.path, { ...(a.recursive ? { recursive: true } : {}), actor: kit.actor(ctx) })
      } catch (e) {
        if (!isMpError(e, 'not_found')) throw e
        return ok({ deleted: a.path, note: 'it was already gone' })
      }
      return ok({ deleted: a.path })
    },
  )

  kit.tool(
    {
      name: 'fs.share',
      description:
        'Share a file or directory of your filesystem with a person (contact id) or another employee (name or id), read-only (default) or read-write. They see it under /shared/<your employee id>/….',
      effect: 'idempotent',
      params: {
        properties: {
          path: { type: 'string' },
          with: { type: 'string', description: 'A contact id, an employee id, or an employee name.' },
          permission: { type: 'string', enum: ['read', 'write'] },
          unshare: { type: 'boolean', description: 'Stop sharing instead.' },
        },
        required: ['path', 'with'],
      },
    },
    async (a, ctx) => {
      const w = String(a.with).trim()
      let contactId: string | null = null
      if (/^con_/.test(w)) contactId = (await deps.directory.contacts.require(w)).id
      else {
        const emp = /^emp_/.test(w) ? await deps.directory.employees.get(w) : await deps.directory.employees.byHandle(w)
        contactId = emp?.data.contactId ?? null
      }
      if (!contactId) throw new ValidationError(`no contact or employee ${w}`)
      if (a.unshare) {
        await files.unshare(ctx.employeeId, a.path, contactId, { actor: kit.actor(ctx) })
        return ok({ unshared: a.path, with: contactId })
      }
      const s = await files.share(ctx.employeeId, a.path, contactId, a.permission ?? 'read', { actor: kit.actor(ctx) })
      return ok({
        shared: s.data.path,
        with: contactId,
        permission: s.data.permission,
        as: `/shared/${ctx.employeeId}${s.data.path}`,
      })
    },
  )
}
