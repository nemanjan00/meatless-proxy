import type * as Api from '@mp/api'
import { ConflictError, NotFoundError, isMpError } from '@mp/core'
import type { ProcedureData } from '@mp/directory'
import type { Skill, SkillData, SkillScope } from '@mp/skills'
import { type Context, Hono } from 'hono'
import { principalOf } from '../auth/guard.ts'
import { BadRequestError, boolParam, jsonBody, requireString } from '../http/util.ts'
import { actorOf } from '../http/views.ts'
import type { Services } from '../services.ts'
import { DirectorySnapshot, changedFields, readAll } from './names.ts'
import { type KnowledgeUse, byTarget, usesOf } from './use.ts'

/**
 * The skills API (docs/spec.md "Skills" and "Web UI › Skills", `@mp/api` knowledge.ts): company
 * and project skills with who used them lately, their versions (restorable), and switching one
 * off. Reads for everyone signed in, writes for members.
 */

/** "Used recently" looks this far back. */
export const SKILL_RECENT_MS = 30 * 24 * 3600 * 1000
const MAX_NAME = 80
const MAX_LINE = 400

const norm = (n: string) => n.trim().toLowerCase()

function optLine(v: unknown, name: string, max = MAX_LINE): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new BadRequestError(`${name} must be a string`)
  const t = v.replace(/\s+/g, ' ').trim()
  if (t.length > max) throw new BadRequestError(`${name} must be at most ${max} characters`)
  return t
}

export class SkillViews {
  private constructor(
    private readonly s: Services,
    readonly names: DirectorySnapshot,
    private readonly all: Skill[],
    private readonly uses: Map<string, KnowledgeUse[]>,
  ) {}

  static async load(s: Services): Promise<SkillViews> {
    const since = new Date(s.clock.now() - SKILL_RECENT_MS).toISOString()
    const [names, all, uses] = await Promise.all([DirectorySnapshot.load(s), s.skills.list(), usesOf(s, 'skill', since)])
    return new SkillViews(s, names, all, byTarget(uses))
  }

  get skills(): Skill[] {
    return this.all
  }

  private usedBy(id: string): Api.SkillUse[] {
    const byEmployee = new Map<string, Api.SkillUse>()
    for (const u of this.uses.get(id) ?? []) {
      const e = this.names.employee(u.data.employeeId)
      if (!e) continue
      const prev = byEmployee.get(e.id)
      byEmployee.set(e.id, {
        employee: e,
        lastAt: prev && prev.lastAt > u.data.lastAt ? prev.lastAt : u.data.lastAt,
        count: (prev?.count ?? 0) + u.data.count,
        ...(u.data.lastSessionId && (!prev || u.data.lastAt >= prev.lastAt) ? { lastSessionId: u.data.lastSessionId } : {}),
      })
    }
    return [...byEmployee.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
  }

  async item(k: Skill): Promise<Api.SkillListItem> {
    const scope = k.data.scope
    const project = scope.type === 'project' && scope.projectId ? this.names.ref('project', scope.projectId) : null
    const company =
      scope.type === 'project'
        ? this.all.find((o) => o.data.scope.type === 'company' && norm(o.data.name) === norm(k.data.name))
        : undefined
    const revs = await this.s.records.revisions('skill', k.id)
    const last = revs.at(-1)
    return {
      skill: k as unknown as Api.ApiRecord<Api.SkillRecordData>,
      project: project
        ? { id: project.id, name: project.name }
        : scope.projectId
          ? { id: scope.projectId, name: scope.projectId }
          : null,
      overrides: company ? { id: company.id, name: company.data.name } : null,
      usedBy: this.usedBy(k.id),
      updatedBy: last ? { type: last.actor.type, id: last.actor.id, name: this.names.actorName(last.actor) } : null,
    }
  }

  async detail(k: Skill): Promise<Api.SkillDetail> {
    const revs = await this.s.records.revisions<SkillData>('skill', k.id)
    const versions: Api.SkillVersion[] = revs.map((r, i) => ({
      version: r.version,
      op: r.op,
      at: r.at,
      actor: { type: r.actor.type, id: r.actor.id, name: this.names.actorName(r.actor) },
      changed:
        i === 0
          ? []
          : changedFields(revs[i - 1]!.data as Record<string, unknown> | null, r.data as Record<string, unknown> | null),
      data: r.data as unknown as Api.SkillRecordData | null,
    }))
    const procedures = (await readAll<ProcedureData>(this.s, 'procedure'))
      .filter((p) => p.data.archived !== true && (p.data.skills ?? []).some((n) => norm(n) === norm(k.data.name)))
      .map((p) => ({ id: p.id, name: p.data.name }))
    return { ...(await this.item(k)), versions: versions.reverse(), procedures }
  }
}

export function skillRoutes(s: Services): Hono {
  const app = new Hono()
  const actor = (c: Context) => actorOf(principalOf(c).contactId)
  const requireSkill = async (id: string) => {
    const k = await s.skills.get(id)
    if (!k) throw new NotFoundError('skill', id)
    return k
  }

  const parseScope = async (raw: unknown): Promise<SkillScope | undefined> => {
    if (raw === undefined || raw === null) return undefined
    const type = (raw as { type?: unknown }).type
    const projectId = (raw as { projectId?: unknown }).projectId
    if (type === 'company') return { type: 'company' }
    if (type === 'project' && typeof projectId === 'string' && projectId) {
      await s.directory.projects.require(projectId)
      return { type: 'project', projectId }
    }
    throw new BadRequestError('scope is { type: company } or { type: project, projectId }')
  }

  const parseFiles = (raw: unknown): SkillData['files'] => {
    if (raw === undefined || raw === null) return undefined
    if (!Array.isArray(raw) || raw.some((f) => typeof f?.path !== 'string' || !f.path.trim() || typeof f?.content !== 'string'))
      throw new BadRequestError('files must be a list of { path, content }')
    return raw.map((f) => ({ path: f.path.trim(), content: f.content }))
  }

  /** A clearer message for the one conflict people run into: a taken name. */
  const named = async <T>(name: string | undefined, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      if (isMpError(e, 'conflict') && name && /already exists/.test(e.message))
        throw new ConflictError(`There is already a skill called ${name} here. Pick another name, or edit that one.`)
      throw e
    }
  }

  app.get('/api/skills', async (c) => {
    const q = c.req.query()
    const v = await SkillViews.load(s)
    const words = (q.text ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const showDisabled = q.disabled === undefined ? true : boolParam(q.disabled)
    const shown = v.skills.filter((k) => {
      if (!showDisabled && k.data.enabled === false) return false
      const hay = `${k.data.name} ${k.data.description} ${k.data.whenToUse ?? ''} ${k.data.body}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    const items: Api.SkillListItem[] = []
    for (const k of shown) items.push(await v.item(k))
    // Company skills first, then per project (by project name), each by name.
    const group = (i: Api.SkillListItem) => (i.project ? `1${i.project.name.toLowerCase()}` : '0')
    items.sort((a, b) => group(a).localeCompare(group(b)) || a.skill.data.name.localeCompare(b.skill.data.name))
    return c.json(items)
  })

  app.get('/api/skills/:id', async (c) => {
    const k = await requireSkill(c.req.param('id'))
    return c.json(await (await SkillViews.load(s)).detail(k))
  })

  app.post('/api/skills', async (c) => {
    const body = await jsonBody<Record<string, unknown>>(c)
    const name = optLine(requireString(body.name, 'name'), 'name', MAX_NAME)!
    const description = optLine(requireString(body.description, 'description'), 'description')!
    const whenToUse = optLine(body.whenToUse, 'whenToUse')
    const text = requireString(body.body, 'body')
    const scope = (await parseScope(body.scope)) ?? { type: 'company' as const }
    const files = parseFiles(body.files)
    const k = await named(name, () =>
      s.skills.create(
        { name, description, body: text, scope, ...(whenToUse ? { whenToUse } : {}), ...(files?.length ? { files } : {}) },
        { actor: actor(c) },
      ),
    )
    return c.json(await (await SkillViews.load(s)).detail(k), 201)
  })

  app.patch('/api/skills/:id', async (c) => {
    const k = await requireSkill(c.req.param('id'))
    const body = await jsonBody<Record<string, unknown>>(c)
    if (body.version !== undefined && typeof body.version !== 'number') throw new BadRequestError('version must be a number')
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean')
      throw new BadRequestError('enabled must be true or false')
    const patch: Partial<SkillData> = {}
    if (body.name !== undefined) patch.name = optLine(requireString(body.name, 'name'), 'name', MAX_NAME)!
    if (body.description !== undefined)
      patch.description = optLine(requireString(body.description, 'description'), 'description')!
    if (body.whenToUse !== undefined) patch.whenToUse = optLine(body.whenToUse, 'whenToUse') || undefined
    if (body.body !== undefined) patch.body = requireString(body.body, 'body')
    const scope = await parseScope(body.scope)
    if (scope) patch.scope = scope.type === 'company' ? { type: 'company' } : scope
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
    if (!Object.keys(patch).length) throw new BadRequestError('nothing to change')
    const next = await named(patch.name ?? k.data.name, async () => {
      try {
        return await s.skills.update(k.id, patch, {
          actor: actor(c),
          ...(typeof body.version === 'number' ? { expectedVersion: body.version } : {}),
        })
      } catch (e) {
        if (isMpError(e, 'conflict') && typeof body.version === 'number' && !/already exists/.test(e.message))
          throw new ConflictError('Someone else changed this skill meanwhile: copy your text, reload and try again.')
        throw e
      }
    })
    return c.json(await (await SkillViews.load(s)).detail(next))
  })

  app.post('/api/skills/:id/restore', async (c) => {
    const k = await requireSkill(c.req.param('id'))
    const body = await jsonBody<{ version?: unknown }>(c)
    if (typeof body.version !== 'number') throw new BadRequestError('version is required')
    const rev = (await s.records.revisions<SkillData>('skill', k.id)).find((r) => r.version === body.version)
    if (!rev?.data) throw new NotFoundError(`version ${body.version} of skill`, k.id)
    const old = rev.data
    // The text of that version, as a new version; the scope and on/off switch stay as they are now.
    const patch: Partial<SkillData> = {
      name: old.name,
      description: old.description,
      whenToUse: old.whenToUse,
      body: old.body,
      files: old.files,
    }
    const next = await named(old.name, () => s.skills.update(k.id, patch, { actor: actor(c) }))
    return c.json(await (await SkillViews.load(s)).detail(next))
  })

  app.delete('/api/skills/:id', async (c) => {
    const k = await requireSkill(c.req.param('id'))
    await s.skills.remove(k.id, { actor: actor(c) })
    return c.body(null, 204)
  })

  return app
}
