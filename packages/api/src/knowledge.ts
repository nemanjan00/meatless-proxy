import type { Access, ApiActor, ApiRecord, ApiToken, EmployeeSummary, Page, SessionStatus } from './resources.ts'

// ─── Knowledge: memory, skills and people ───────────────────────────────────
//
// Served by packages/server/src/knowledge. Typed views over the `memory`, `skill` and `contact`
// records, with the facts their pages need (who a memory is about, which employees used a skill,
// who can sign in), so the UI doesn't stitch generic records together.
//
// Who sees what (docs/spec.md "Memory" and "Contacts"):
// - A memory about a person (scoped to them, or linked to them with role `about`) is personal:
//   only that person and admins see it. Every other memory is seen by everyone signed in.
//   Members add memories and edit the ones they see; anyone may correct or forget a memory about
//   themselves, even a viewer. The generic records API serves memories to admins only.
// - Skills: everyone reads, members write.
// - People: everyone reads the directory; admins add people, change access, send sign-in links
//   and deactivate. Last sign-in and API tokens are shown to admins and to the person themselves.

/** A reference to a record, with its name for display. */
export interface KnowledgeRef {
  kind: string
  id: string
  name: string
  /** For contacts: `person`, `ai` (an AI employee) or `agent`. */
  contactKind?: 'person' | 'ai' | 'agent'
  /** For an AI employee's contact: the employee. */
  employeeId?: string
}

/** Someone who did something (taught a memory, edited a skill), with their name. */
export interface KnowledgePerson {
  contactId: string
  name: string
  kind: 'person' | 'ai' | 'agent'
  employeeId?: string
}

// ─── Memory ─────────────────────────────────────────────────────────────────

export type MemoryKind = 'fact' | 'preference' | 'feedback' | 'decision' | 'other'
export const MEMORY_KINDS: readonly MemoryKind[] = ['fact', 'preference', 'feedback', 'decision', 'other']

/** Who may recall a memory: every session, only work on one project, or only work with one person. */
export interface MemoryScope {
  type: 'company' | 'project' | 'contact'
  id?: string
}

/** Kind `memory`, as `@mp/memory` stores it (plus the server's `correction`). */
export interface MemoryRecordData extends Record<string, unknown> {
  summary: string
  kind: MemoryKind
  content?: string
  scope: MemoryScope
  source?: { sessionId?: string; contactId?: string }
  /** When it was last confirmed to still be true. */
  verified?: string
  /** The employee workspace it belongs to; unset means every employee shares it. */
  employeeId?: string
  /** The last correction a person made, and why. */
  correction?: { note: string; contactId: string; at: string }
}

/** Where a memory came from: the session it was learned in (and its message) and who said it. */
export interface MemorySource {
  /** Null when there is none, or it's private work the viewer can't read (then `private` is true). */
  session: { id: string; title: string; slug: string; status: SessionStatus } | null
  private?: boolean
  /** The chat message that started that session, when it came from chat and the viewer may see the channel. */
  message?: { channelId: string; threadId: string; text: string; channelName?: string }
  /** The person who said it, or who added it here. */
  person: KnowledgePerson | null
}

/** A `GET /api/memories` row. */
export interface MemoryItem {
  memory: ApiRecord<MemoryRecordData>
  /** The employee whose memory it is; null when every employee shares it. */
  employee: EmployeeSummary | null
  /** What it's about: its scope's project or person, and records linked with role `about`. */
  about: KnowledgeRef[]
  /** It's about a person: only they and admins see it. */
  personal: boolean
  source: MemorySource
  /** When an employee last recalled it (by `memory.recall`, or loaded at the start of work); null if never. */
  lastUsedAt: string | null
  uses: number
  /** Whether the viewer may edit it, and forget it. */
  canEdit: boolean
}

/** One version of a memory, for its history. */
export interface MemoryRevision {
  version: number
  op: 'create' | 'update' | 'delete'
  at: string
  actor: ApiActor & { name: string }
  /** Fields that changed from the version before. */
  changed: string[]
  summary: string
  content?: string
  /** The correction note saved with this version. */
  note?: string
}

/** `GET /api/memories/:id`. */
export interface MemoryDetail extends MemoryItem {
  history: MemoryRevision[]
}

/** Counts for the filter menus, over every memory the viewer may see. */
export interface MemoryFacets {
  employees: (EmployeeSummary & { count: number })[]
  /** Shared by every employee. */
  shared: number
  kinds: { kind: MemoryKind; count: number }[]
  /** People and projects memories are about. */
  subjects: (KnowledgeRef & { count: number })[]
  /** People who taught memories. */
  teachers: (KnowledgePerson & { count: number })[]
}

/** `GET /api/memories` → a page of rows (most recently learned first), with facets. */
export interface MemoryPage extends Page<MemoryItem> {
  facets: MemoryFacets
}

/** `GET /api/memories` query. */
export interface MemoryListQuery {
  text?: string
  /** An employee id, or `shared` for memories every employee shares. */
  employeeId?: string
  kind?: MemoryKind
  /** A contact or project id: memories about it. */
  about?: string
  /** A contact id: memories they taught. */
  taughtBy?: string
  /** A session id: memories learned in it. */
  sessionId?: string
  /** Only memories about the viewer. */
  mine?: boolean
  /** `learned` (default, newest first), `used` (last recalled first) or `updated`. */
  sort?: 'learned' | 'used' | 'updated'
  /** Default 100, at most 500. */
  limit?: number
  offset?: number
}

/** `POST /api/memories`: a person teaching an employee something. */
export interface CreateMemoryBody {
  summary: string
  kind?: MemoryKind
  content?: string
  /** The employee who remembers it; null or left out: every employee shares it. */
  employeeId?: string | null
  /** Contacts and projects it's about. */
  about?: { kind: 'contact' | 'project'; id: string }[]
  /** Who may recall it. Default: every session (company). */
  scope?: MemoryScope
}

/** `PATCH /api/memories/:id`: an edit, or a correction (with `note`). */
export interface UpdateMemoryBody {
  summary?: string
  kind?: MemoryKind
  content?: string
  employeeId?: string | null
  scope?: MemoryScope
  /** Replaces what it's about. */
  about?: { kind: 'contact' | 'project'; id: string }[]
  /** Why it was wrong: saved with the version, shown in its history, and marks it verified now. */
  note?: string
  /** The version the edit is based on: 409 when it has changed since. */
  version?: number
}

/** `POST /api/memories` → the memory; `created` is false when it updated one with the same summary. */
export interface CreatedMemory {
  created: boolean
  memory: MemoryDetail
}

// ─── Skills ─────────────────────────────────────────────────────────────────

/** Where a skill applies: every employee's work, or work on one project. */
export interface SkillScope {
  type: 'company' | 'project'
  projectId?: string
}

/** Kind `skill`, as `@mp/skills` stores it. */
export interface SkillRecordData extends Record<string, unknown> {
  name: string
  description: string
  /** When to load it, in plain words (shown to the model with the description). */
  whenToUse?: string
  body: string
  scope: SkillScope
  files?: { path: string; content: string }[]
  /** False: switched off, no employee sees it. Default true. */
  enabled?: boolean
}

/** An employee that loaded a skill recently. */
export interface SkillUse {
  employee: EmployeeSummary
  lastAt: string
  count: number
  lastSessionId?: string
}

/** A `GET /api/skills` row. */
export interface SkillListItem {
  skill: ApiRecord<SkillRecordData>
  /** The project of a project skill. */
  project: { id: string; name: string } | null
  /** A project skill with the same name as a company skill replaces it in that project's work. */
  overrides: { id: string; name: string } | null
  /** Employees that loaded it in the last 30 days, most recent first. */
  usedBy: SkillUse[]
  /** Who saved the current version. */
  updatedBy: { type: ApiActor['type']; id: string; name: string } | null
}

/** One version of a skill, for its history. */
export interface SkillVersion {
  version: number
  op: 'create' | 'update' | 'delete'
  at: string
  actor: ApiActor & { name: string }
  changed: string[]
  data: SkillRecordData | null
}

/** `GET /api/skills/:id`. */
export interface SkillDetail extends SkillListItem {
  versions: SkillVersion[]
  /** Procedures that name it among their skills. */
  procedures: { id: string; name: string }[]
}

/** `POST /api/skills` body. */
export interface CreateSkillBody {
  name: string
  description: string
  whenToUse?: string
  body: string
  /** Default: company. */
  scope?: SkillScope
  files?: { path: string; content: string }[]
}

/** `PATCH /api/skills/:id` body. */
export interface UpdateSkillBody {
  name?: string
  description?: string
  whenToUse?: string
  body?: string
  scope?: SkillScope
  enabled?: boolean
  /** The version the edit is based on: 409 when it has changed since. */
  version?: number
}

/** The body a new skill starts from. */
export const SKILL_TEMPLATE = `## When to use

The kind of task this is for, and how to tell.

## How to do it

1. First step.
2. Second step.
3. Third step.

## Check before you finish

- What must be true when it's done.

## Pitfalls

- Mistakes people make, and how to avoid them.
`

/** A parsed `SKILL.md`: YAML front matter (`name`, `description`, `when_to_use`) and a markdown body. */
export interface ParsedSkill {
  name: string
  description: string
  whenToUse: string
  body: string
}

const unquote = (v: string) => {
  const t = v.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
  return t
}

/**
 * Reads a `SKILL.md` (the Claude skill format): front matter between `---` lines with `name` and
 * `description` (and optionally `when_to_use`), then the instructions. Without front matter the
 * first `# Heading` is the name and the first paragraph the description. Missing parts are ''.
 */
export function parseSkillMarkdown(text: string): ParsedSkill {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const out: ParsedSkill = { name: '', description: '', whenToUse: '', body: src.trim() }
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(src)
  if (fm) {
    out.body = src.slice(fm[0].length).trim()
    let key = ''
    for (const line of fm[1]!.split('\n')) {
      const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
      if (m) {
        key = m[1]!.toLowerCase().replace(/-/g, '_')
        const value = unquote(m[2]!)
        if (key === 'name') out.name = value
        else if (key === 'description') out.description = value === '>' || value === '|' ? '' : value
        else if (key === 'when_to_use') out.whenToUse = value === '>' || value === '|' ? '' : value
      } else if (/^\s+\S/.test(line)) {
        // A folded or continued value.
        const more = line.trim()
        if (key === 'description') out.description = `${out.description} ${more}`.trim()
        else if (key === 'when_to_use') out.whenToUse = `${out.whenToUse} ${more}`.trim()
      }
    }
  }
  if (!out.name) {
    const h = /^#\s+(.+)$/m.exec(out.body)
    if (h) out.name = h[1]!.trim()
  }
  if (!out.description) {
    const para = out.body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith('#'))
    if (para) out.description = para.replace(/\s+/g, ' ').slice(0, 200)
  }
  return out
}

/** A skill as a `SKILL.md`, the format `parseSkillMarkdown` reads. */
export function skillMarkdown(s: { name: string; description: string; whenToUse?: string; body: string }): string {
  const q = (v: string) => (/[:#'"\n]|^\s|\s$/.test(v) ? JSON.stringify(v.replace(/\s+/g, ' ')) : v)
  const lines = ['---', `name: ${q(s.name)}`, `description: ${q(s.description)}`]
  if (s.whenToUse?.trim()) lines.push(`when_to_use: ${q(s.whenToUse.trim())}`)
  lines.push('---', '', s.body.trim(), '')
  return lines.join('\n')
}

// ─── People ─────────────────────────────────────────────────────────────────

export type PersonType = 'person' | 'ai' | 'agent'

/** Kind `contact`, with the fields the people pages use. */
export interface PersonRecordData extends Record<string, unknown> {
  name: string
  kind?: PersonType
  email?: string
  role?: string
  team?: string
  manager?: string
  handles?: { system: string; id: string }[]
  permissions?: string
  bio?: string
  access?: Access
  status?: 'active' | 'left'
  /** Set when an admin deactivated them: they can't sign in. */
  deactivatedAt?: string
  deactivatedBy?: string
  /** A local agent: the person it acts for. */
  sponsor?: string
}

/** A `GET /api/people` row. */
export interface PersonItem {
  contact: ApiRecord<PersonRecordData>
  type: PersonType
  /** For AI employees: their employee record (their page is `/employees/<id>`). */
  employeeId?: string
  /** Sign-in access for people; null for AI employees and agents (they never sign in). */
  access: Access | null
  /** Found through an integration (e.g. Slack) and not given access yet: can't sign in until an admin grants it. */
  noAccess?: boolean
  /** Deactivated by an admin: can't sign in, history kept. */
  deactivated: boolean
  /** Their last sign-in (a link or the identity provider). Shown to admins and to the person themselves, else null. */
  lastSignInAt: string | null
  /** When their sign-in was last used. Same visibility as `lastSignInAt`. */
  lastSeenAt: string | null
  projects: { id: string; name: string; roles: string[] }[]
  /** A local agent's sponsor. */
  sponsor: { contactId: string; name: string } | null
}

/** `GET /api/people/:id`. */
export interface PersonDetail extends PersonItem {
  manager: KnowledgePerson | null
  /** People whose manager they are. */
  reports: KnowledgePerson[]
  /** How many memories are about them (only when the viewer may see them: themselves or an admin; else null). */
  memoriesAbout: number | null
  /** Their API tokens (admins, or themselves; else null). */
  tokens: ApiToken[] | null
  /** Whether the viewer may edit their profile, and change their access or deactivate them. */
  canEdit: boolean
  canAdmin: boolean
}

/** `GET /api/people` query. */
export interface PeopleQuery {
  text?: string
  type?: PersonType
  access?: Access
  team?: string
  /** Include deactivated people. Default true. */
  deactivated?: boolean
}

/** A handle in another system: Slack user id, GitLab username, Linear id. */
export interface PersonHandle {
  system: string
  id: string
}

/** `POST /api/people` (admins). */
export interface CreatePersonBody {
  name: string
  email?: string
  /** Default viewer. */
  access?: Access
  role?: string
  team?: string
  manager?: string
  handles?: PersonHandle[]
  /** Also make a one-time sign-in link (and DM it on Slack when they have a Slack handle and Slack is set up). */
  sendSignInLink?: boolean
  /** A repeated key returns the first person instead of adding another. */
  idempotencyKey?: string
}

/** `PATCH /api/people/:id`. `access` needs an admin. Null clears a field. */
export interface UpdatePersonBody {
  name?: string
  email?: string | null
  role?: string | null
  team?: string | null
  manager?: string | null
  handles?: PersonHandle[]
  access?: Access
  version?: number
}

/** A one-time sign-in link, and whether it was sent. */
export interface SignInLinkResult {
  url: string
  expiresAt: string
  /** `slack` when it was sent as a Slack DM; null when it's only shown here. */
  sentVia: 'slack' | null
  /** Why it wasn't sent, in plain words (no Slack handle, Slack not set up, Slack refused). */
  notSent?: string
}

/** `POST /api/people` → the person, and their sign-in link when asked for. */
export interface CreatedPerson {
  created: boolean
  person: PersonDetail
  signInLink?: SignInLinkResult
}

/** The routes of this section (merged into `ROUTES`). */
export const KNOWLEDGE_ROUTES = {
  listMemories: ['GET', '/api/memories'],
  getMemory: ['GET', '/api/memories/:id'],
  createMemory: ['POST', '/api/memories'],
  updateMemory: ['PATCH', '/api/memories/:id'],
  verifyMemory: ['POST', '/api/memories/:id/verify'],
  forgetMemory: ['DELETE', '/api/memories/:id'],
  listSkills: ['GET', '/api/skills'],
  getSkill: ['GET', '/api/skills/:id'],
  createSkill: ['POST', '/api/skills'],
  updateSkill: ['PATCH', '/api/skills/:id'],
  restoreSkill: ['POST', '/api/skills/:id/restore'],
  deleteSkill: ['DELETE', '/api/skills/:id'],
  listPeople: ['GET', '/api/people'],
  getPerson: ['GET', '/api/people/:id'],
  createPerson: ['POST', '/api/people'],
  updatePerson: ['PATCH', '/api/people/:id'],
  personSignInLink: ['POST', '/api/people/:id/sign-in-link'],
  deactivatePerson: ['POST', '/api/people/:id/deactivate'],
  reactivatePerson: ['POST', '/api/people/:id/reactivate'],
} as const

/** The client methods of this section (part of `ApiClient`). */
export interface KnowledgeApi {
  /** `GET /api/memories?text=&employeeId=&kind=&about=&taughtBy=&sessionId=&mine=&sort=&limit=&offset=` → memories the viewer may see, with facets. */
  memories(q?: MemoryListQuery): Promise<MemoryPage>
  /** `GET /api/memories/:id` → the memory with its history (404 when the viewer may not see it). */
  memory(id: string): Promise<MemoryDetail>
  /** `POST /api/memories` → 201 with the memory, or 200 when it updated one with the same summary (members). */
  createMemory(body: CreateMemoryBody): Promise<CreatedMemory>
  /** `PATCH /api/memories/:id` → the memory. With `note` it's a correction (anyone about themselves; members). */
  updateMemory(id: string, body: UpdateMemoryBody): Promise<MemoryDetail>
  /** `POST /api/memories/:id/verify` → the memory, confirmed still true now. */
  verifyMemory(id: string): Promise<MemoryDetail>
  /** `DELETE /api/memories/:id` → 204: forgotten, for good. */
  forgetMemory(id: string): Promise<void>

  /** `GET /api/skills?text=&disabled=` → every skill, company ones first, then by project and name. */
  skills(q?: { text?: string; disabled?: boolean }): Promise<SkillListItem[]>
  /** `GET /api/skills/:id` → the skill, its versions, usage and the procedures that name it. */
  skill(id: string): Promise<SkillDetail>
  /** `POST /api/skills` → 201 with the skill (members). 409 when the name is taken in that scope. */
  createSkill(body: CreateSkillBody): Promise<SkillDetail>
  /** `PATCH /api/skills/:id` → the skill; every save is a version (members). */
  updateSkill(id: string, body: UpdateSkillBody): Promise<SkillDetail>
  /** `POST /api/skills/:id/restore` body `{ version }` → the skill, with that version's text as a new version (members). */
  restoreSkill(id: string, version: number): Promise<SkillDetail>
  /** `DELETE /api/skills/:id` → 204 (members). */
  deleteSkill(id: string): Promise<void>

  /** `GET /api/people?text=&type=&access=&team=&deactivated=` → people, AI employees and agents, by name. */
  people(q?: PeopleQuery): Promise<PersonItem[]>
  /** `GET /api/people/:id` → the person with their manager, reports, memories count and tokens. */
  person(id: string): Promise<PersonDetail>
  /** `POST /api/people` → 201 with the person (admins), and a sign-in link when `sendSignInLink`. 409 for a taken email or handle. */
  createPerson(body: CreatePersonBody): Promise<CreatedPerson>
  /** `PATCH /api/people/:id` → the person (members edit the profile; access needs an admin). */
  updatePerson(id: string, body: UpdatePersonBody): Promise<PersonDetail>
  /** `POST /api/people/:id/sign-in-link` body `{ send? }` → a one-time link, DMed on Slack when possible and `send` isn't false (admins). */
  personSignInLink(id: string, opts?: { send?: boolean }): Promise<SignInLinkResult>
  /** `POST /api/people/:id/deactivate` → the person: they can't sign in, their sign-ins and tokens are revoked (admins). */
  deactivatePerson(id: string): Promise<PersonDetail>
  /** `POST /api/people/:id/reactivate` → the person, able to sign in again with a new link (admins). */
  reactivatePerson(id: string): Promise<PersonDetail>
}

type Call = <T>(
  route: keyof typeof KNOWLEDGE_ROUTES,
  params?: Record<string, string>,
  query?: Record<string, string | number | boolean | undefined | null>,
  body?: unknown,
) => Promise<T>

/** The `KnowledgeApi` part of `createApiClient`. */
export function knowledgeMethods(call: Call): KnowledgeApi {
  return {
    memories: (q = {}) => call('listMemories', undefined, { ...q }),
    memory: (id) => call('getMemory', { id }),
    createMemory: (body) => call('createMemory', undefined, undefined, body),
    updateMemory: (id, body) => call('updateMemory', { id }, undefined, body),
    verifyMemory: (id) => call('verifyMemory', { id }, undefined, {}),
    forgetMemory: (id) => call('forgetMemory', { id }),
    skills: (q = {}) => call('listSkills', undefined, { ...q }),
    skill: (id) => call('getSkill', { id }),
    createSkill: (body) => call('createSkill', undefined, undefined, body),
    updateSkill: (id, body) => call('updateSkill', { id }, undefined, body),
    restoreSkill: (id, version) => call('restoreSkill', { id }, undefined, { version }),
    deleteSkill: (id) => call('deleteSkill', { id }),
    people: (q = {}) => call('listPeople', undefined, { ...q }),
    person: (id) => call('getPerson', { id }),
    createPerson: (body) => call('createPerson', undefined, undefined, body),
    updatePerson: (id, body) => call('updatePerson', { id }, undefined, body),
    personSignInLink: (id, opts = {}) => call('personSignInLink', { id }, undefined, opts),
    deactivatePerson: (id) => call('deactivatePerson', { id }, undefined, {}),
    reactivatePerson: (id) => call('reactivatePerson', { id }, undefined, {}),
  }
}
