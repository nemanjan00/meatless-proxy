import { ConflictError, NotFoundError, ValidationError, type KindSchema } from '@mp/core'
import type { Records } from '@mp/records'
import type { Actor, StoredRecord } from '@mp/store'

/** `Omit` that keeps known keys of types with an index signature. */
type Without<T, K extends PropertyKey> = { [P in keyof T as P extends K ? never : P]: T[P] }

export const skillSchema: KindSchema = {
  kind: 'skill',
  prefix: 'skl',
  description: 'A packaged playbook: instructions for doing one kind of work well, company-wide or for one project.',
  titleField: 'name',
  core: [
    { name: 'name', type: 'string', required: true },
    { name: 'description', type: 'string', required: true, description: 'One line, used to decide relevance.' },
    { name: 'body', type: 'text', required: true, description: 'Markdown instructions. Link records with [[kind:id]].' },
    {
      name: 'scope',
      type: 'object',
      required: true,
      fields: [
        { name: 'type', type: 'enum', values: ['company', 'project'], required: true },
        { name: 'projectId', type: 'ref', ref: 'project' },
      ],
    },
    {
      name: 'files',
      type: 'list',
      description: 'Attached files (scripts, templates).',
      of: {
        type: 'object',
        fields: [
          { name: 'path', type: 'string', required: true },
          { name: 'content', type: 'string', required: true },
        ],
      },
    },
  ],
}

export interface SkillScope {
  type: 'company' | 'project'
  projectId?: string
}

export interface SkillFile {
  path: string
  content: string
}

export interface SkillData extends Record<string, unknown> {
  name: string
  description: string
  body: string
  scope: SkillScope
  files?: SkillFile[]
}

export type Skill = StoredRecord<SkillData>

/** What the model sees up front: enough to decide whether to load it. */
export interface SkillSummary {
  id: string
  name: string
  description: string
  version: number
  scope: SkillScope
  /** The company skill this project skill overrides, if any. */
  overrides?: string
}

export interface LoadedSkill {
  skill: Skill
  body: string
  /** Record it with the session, so it's known which version was used. */
  version: number
  files: SkillFile[]
}

/** Where a session is: its projects decide which project skills it sees. */
export interface SkillContext {
  projectIds?: string[]
}

export interface SkillsService {
  /** `ConflictError` if a skill with the same name exists in the same scope (company, or that project). */
  create(data: Without<SkillData, 'scope'> & { scope?: SkillScope }, opts?: { actor?: Actor }): Promise<Skill>
  update(id: string, patch: Partial<SkillData>, opts?: { actor?: Actor; expectedVersion?: number }): Promise<Skill>
  get(id: string): Promise<Skill | null>
  /** All skills, or only company skills (`{ type: 'company' }`) or one project's. */
  list(filter?: { scope?: SkillScope }): Promise<Skill[]>
  /**
   * Company skills plus the skills of `projectIds`, one per name. A project
   * skill overrides a company skill with the same name; between projects, the
   * one listed first wins.
   */
  available(ctx?: SkillContext): Promise<SkillSummary[]>
  /** Loads the skill with this name (or id) as `available` resolves it. `NotFoundError` if there's none. */
  load(nameOrId: string, ctx?: SkillContext): Promise<LoadedSkill>
  remove(id: string, opts?: { actor?: Actor }): Promise<void>
}

export interface SkillsDeps {
  records: Records
}

const normName = (n: string) => n.trim().toLowerCase()

function skillKey(d: Pick<SkillData, 'name' | 'scope'>): string {
  return `${d.scope.type === 'company' ? 'company' : d.scope.projectId}:${normName(d.name)}`
}

function checkData(d: SkillData) {
  if (!d.name?.trim()) throw new ValidationError('skill name is required')
  if (d.scope?.type === 'project' && !d.scope.projectId) throw new ValidationError('a project skill needs scope.projectId')
  if (d.scope?.type === 'company' && d.scope.projectId) throw new ValidationError('a company skill has no scope.projectId')
  const paths = (d.files ?? []).map((f) => f.path)
  if (new Set(paths).size !== paths.length) throw new ValidationError('skill file paths must be unique')
}

const summary = (s: Skill, overrides?: string): SkillSummary => ({
  id: s.id,
  name: s.data.name,
  description: s.data.description,
  version: s.version,
  scope: s.data.scope,
  ...(overrides ? { overrides } : {}),
})

/** Registers the `skill` kind and returns the skills service. */
export function createSkills({ records }: SkillsDeps): SkillsService {
  records.kinds.define(skillSchema)

  /** Name -> the winning skill, plus the company skill it replaced. */
  const resolve = async (ctx: SkillContext = {}) => {
    const all = (await records.query<SkillData>('skill', { orderBy: { field: 'createdAt' } })).items
    const out = new Map<string, { skill: Skill; overrides?: string }>()
    for (const s of all) if (s.data.scope.type === 'company') out.set(normName(s.data.name), { skill: s })
    const claimed = new Set<string>()
    for (const pid of ctx.projectIds ?? []) {
      for (const s of all) {
        if (s.data.scope.type !== 'project' || s.data.scope.projectId !== pid) continue
        const n = normName(s.data.name)
        if (claimed.has(n)) continue
        claimed.add(n)
        const company = out.get(n)
        out.set(n, { skill: s, ...(company ? { overrides: company.skill.id } : {}) })
      }
    }
    return out
  }

  const service: SkillsService = {
    async create(input, opts = {}) {
      const data = { ...input, scope: input.scope ?? { type: 'company' } } as SkillData
      checkData(data)
      try {
        return await records.create<SkillData>('skill', data, { ...opts, key: skillKey(data) })
      } catch (e) {
        if (e instanceof ConflictError) throw new ConflictError(`a skill named ${data.name} already exists in this scope`)
        throw e
      }
    },

    async update(id, patch, opts = {}) {
      const current = await records.require<SkillData>('skill', id)
      const next = { ...current.data, ...patch } as SkillData
      checkData(next)
      const key = skillKey(next)
      try {
        return await records.update<SkillData>('skill', id, patch, {
          ...(opts.actor ? { actor: opts.actor } : {}),
          ...(opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
          ...(key !== current.key ? { key } : {}),
        })
      } catch (e) {
        if (e instanceof ConflictError && key !== current.key && opts.expectedVersion === undefined)
          throw new ConflictError(`a skill named ${next.name} already exists in this scope`)
        throw e
      }
    },

    get: (id) => records.get<SkillData>('skill', id),

    async list(filter = {}) {
      const where: Record<string, string> = {}
      if (filter.scope) {
        where['scope.type'] = filter.scope.type
        if (filter.scope.projectId) where['scope.projectId'] = filter.scope.projectId
      }
      return (await records.query<SkillData>('skill', { where, orderBy: { field: 'createdAt' } })).items
    },

    async available(ctx) {
      const out = [...(await resolve(ctx)).values()].map((v) => summary(v.skill, v.overrides))
      return out.sort((a, b) => a.name.localeCompare(b.name))
    },

    async load(nameOrId, ctx) {
      const resolved = await resolve(ctx)
      let skill = resolved.get(normName(nameOrId))?.skill
      if (!skill) {
        // By id, as long as it's available here.
        skill = [...resolved.values()].find((v) => v.skill.id === nameOrId)?.skill
      }
      if (!skill) throw new NotFoundError('skill', nameOrId)
      return { skill, body: skill.data.body, version: skill.version, files: skill.data.files ?? [] }
    },

    remove: (id, opts = {}) => records.delete('skill', id, { cascade: true, ...opts }),
  }
  return service
}
