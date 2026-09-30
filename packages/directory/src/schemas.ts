import type { KindSchema } from '@mp/core'
import type { Ref } from '@mp/store'

/** An identity in one connected system, e.g. `{ system: 'slack', id: 'U123' }`. The harness's own is `{ system: 'mp', id: 'ana' }`. */
export interface Handle {
  system: string
  id: string
}

/** The harness's own handle system: `@name` tags in harness chat resolve through it. */
export const MP_SYSTEM = 'mp'

export const contactSchema: KindSchema = {
  kind: 'contact',
  prefix: 'con',
  description: 'A person or an AI employee in the company directory.',
  titleField: 'name',
  core: [
    { name: 'name', type: 'string', required: true, description: 'Display name.' },
    {
      name: 'kind',
      type: 'enum',
      values: ['person', 'ai', 'agent'],
      required: true,
      description: 'A person, an AI employee, or a local AI agent that joined chat over MCP on behalf of a person.',
    },
    {
      name: 'handles',
      type: 'list',
      description: 'Identity in each connected system, e.g. {slack, U123}.',
      of: {
        type: 'object',
        fields: [
          { name: 'system', type: 'string', required: true },
          { name: 'id', type: 'string', required: true },
        ],
      },
    },
    { name: 'email', type: 'string' },
    { name: 'role', type: 'string', description: 'Job title.' },
    { name: 'team', type: 'string' },
    { name: 'manager', type: 'ref', ref: 'contact' },
    { name: 'permissions', type: 'string', description: 'What this contact may ask for, in plain words.' },
    { name: 'bio', type: 'text' },
    { name: 'status', type: 'enum', values: ['active', 'left'] },
    {
      name: 'learned',
      type: 'list',
      description:
        'Where role, team, manager and bio notes came from when an AI employee learned them (directory.update_contact): who, when, from what.',
      of: {
        type: 'object',
        fields: [
          { name: 'field', type: 'enum', values: ['role', 'team', 'manager', 'bio'], required: true },
          { name: 'value', type: 'string', required: true },
          { name: 'employeeId', type: 'ref', ref: 'employee', required: true },
          { name: 'source', type: 'string', required: true },
          { name: 'at', type: 'timestamp', required: true },
          { name: 'line', type: 'string', description: 'For a bio note: the line appended to the bio.' },
          { name: 'acceptedBy', type: 'ref', ref: 'contact', description: 'Who accepted it, when it was a suggestion.' },
          { name: 'acceptedAt', type: 'timestamp' },
        ],
      },
    },
  ],
}

/** Contact fields an AI employee may learn (directory.update_contact). Bio notes are appended, not set. */
export const LEARNABLE_FIELDS = ['role', 'team', 'manager'] as const
export type LearnableField = (typeof LEARNABLE_FIELDS)[number]

/** Where a contact field (or a bio note) came from, when an AI employee learned it. */
export interface LearnedFact {
  field: LearnableField | 'bio'
  value: string
  employeeId: string
  /** Where it was learned: a message, thread, ticket or event reference, or a one-line quote. */
  source: string
  at: string
  /** For a bio note: the exact line appended to the bio. */
  line?: string
  /** Set when the value came from an accepted suggestion. */
  acceptedBy?: string
  acceptedAt?: string
}

export interface ContactData extends Record<string, unknown> {
  name: string
  kind: 'person' | 'ai' | 'agent'
  handles?: Handle[]
  email?: string
  role?: string
  team?: string
  manager?: string
  permissions?: string
  bio?: string
  status?: 'active' | 'left'
  learned?: LearnedFact[]
}

/**
 * A change an AI employee proposed to a contact field that already had a value. An admin or the
 * person themself accepts it (the value is applied) or rejects it. One per employee, contact,
 * field and proposed value (its record key), so saying it again updates it instead of adding one.
 */
export const contactSuggestionSchema: KindSchema = {
  kind: 'contact_suggestion',
  prefix: 'csg',
  description: 'A proposed change to a contact field that already has a value, waiting for an admin or the person to decide.',
  core: [
    { name: 'contactId', type: 'ref', ref: 'contact', required: true },
    { name: 'field', type: 'enum', values: ['role', 'team', 'manager'], required: true },
    { name: 'current', type: 'string', description: 'The value when it was (last) suggested.' },
    { name: 'proposed', type: 'string', required: true },
    { name: 'employeeId', type: 'ref', ref: 'employee', required: true },
    { name: 'source', type: 'string', required: true },
    { name: 'status', type: 'enum', values: ['pending', 'accepted', 'rejected'], required: true },
    { name: 'times', type: 'number', description: 'How many times the employee suggested it.' },
    { name: 'suggestedAt', type: 'timestamp', required: true, description: 'When it was last suggested.' },
    { name: 'decidedBy', type: 'ref', ref: 'contact' },
    { name: 'decidedAt', type: 'timestamp' },
  ],
}

export interface ContactSuggestionData extends Record<string, unknown> {
  contactId: string
  field: LearnableField
  current?: string
  proposed: string
  employeeId: string
  source: string
  status: 'pending' | 'accepted' | 'rejected'
  times?: number
  suggestedAt: string
  decidedBy?: string
  decidedAt?: string
}

export const employeeSchema: KindSchema = {
  kind: 'employee',
  prefix: 'emp',
  description: 'An AI employee: an isolated workspace with its own identity, personality, scope and tools.',
  titleField: 'name',
  core: [
    { name: 'contactId', type: 'ref', ref: 'contact', required: true, description: "The employee's own contact (kind ai)." },
    { name: 'name', type: 'string', required: true },
    { name: 'personality', type: 'text', description: 'A few quirks, in plain words. Shapes tone only.' },
    { name: 'instructions', type: 'text', description: 'Standing instructions for every session of this employee.' },
    {
      name: 'scope',
      type: 'object',
      description: 'The slice of the company this employee is responsible for.',
      fields: [
        { name: 'projects', type: 'list', of: { type: 'ref', ref: 'project' } },
        { name: 'teams', type: 'list', of: { type: 'string' } },
        { name: 'procedures', type: 'list', of: { type: 'ref', ref: 'procedure' } },
      ],
    },
    { name: 'toolAllow', type: 'list', of: { type: 'string' }, description: 'Tool name patterns this employee may use.' },
    { name: 'toolDeny', type: 'list', of: { type: 'string' }, description: 'Tool name patterns this employee may never use.' },
    { name: 'model', type: 'string' },
    {
      name: 'network',
      type: 'json',
      description:
        "Where this employee's environments and sandbox may connect: 'none', 'project' (the project's egress allowlist, through the egress proxy), { allow: [hosts] } (its own list through the proxy; with a project, only hosts both allow; ['*'] allows any public host), or 'direct' (a real network with no proxy, no allowlist and no log, for trusted employees). Unset: the deployment's DEFAULT_NETWORK (direct unless set).",
    },
    {
      name: 'git',
      type: 'object',
      fields: [
        { name: 'name', type: 'string' },
        { name: 'email', type: 'string' },
        { name: 'branchPrefix', type: 'string' },
      ],
    },
    { name: 'routerSessionId', type: 'ref', ref: 'session' },
    { name: 'limits', type: 'json' },
    { name: 'taskSystem', type: 'json', description: 'How real forks become tasks, e.g. {server, createTool, ...}.' },
    { name: 'notify', type: 'json' },
  ],
}

export interface EmployeeScope {
  projects?: string[]
  teams?: string[]
  procedures?: string[]
}

/**
 * An employee's network: `none` (never any), `project` (the default: the session's project allowlist),
 * its own hostname allowlist (both through the egress proxy, see `EnvSpec.egress` in `@mp/containers`),
 * or `direct`: a real network with no proxy, no allowlist and nothing logged (see `EnvSpec.direct`).
 */
export type EmployeeNetwork = 'none' | 'project' | 'direct' | { allow: string[] }

/** Why a network setting is unusable, or null when it's fine. Entries are checked where they're used. */
export function invalidNetwork(v: unknown): string | null {
  if (v === undefined || v === 'none' || v === 'project' || v === 'direct') return null
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const allow = (v as { allow?: unknown }).allow
    if (Object.keys(v).length === 1 && Array.isArray(allow) && allow.every((e) => typeof e === 'string' && e.trim())) return null
  }
  return "network must be 'none', 'project', 'direct' or { allow: [hosts] }"
}

export interface EmployeeData extends Record<string, unknown> {
  contactId: string
  name: string
  personality?: string
  instructions?: string
  scope?: EmployeeScope
  toolAllow?: string[]
  toolDeny?: string[]
  model?: string
  network?: EmployeeNetwork
  git?: { name?: string; email?: string; branchPrefix?: string }
  routerSessionId?: string
  limits?: unknown
  taskSystem?: unknown
  notify?: unknown
}

export const projectSchema: KindSchema = {
  kind: 'project',
  prefix: 'pro',
  description: "A company project. Owner and members are links from contacts (see the directory's project roles).",
  titleField: 'name',
  core: [
    { name: 'name', type: 'string', required: true },
    { name: 'aliases', type: 'list', of: { type: 'string' }, description: 'Other names people use for it.' },
    { name: 'description', type: 'text', description: 'One paragraph.' },
    { name: 'status', type: 'enum', values: ['active', 'maintenance', 'sunset'] },
    {
      name: 'repositories',
      type: 'list',
      of: {
        type: 'object',
        fields: [
          { name: 'url', type: 'string', required: true },
          { name: 'httpUrl', type: 'string', description: 'The https URL of the same repository, when url is ssh.' },
          { name: 'defaultBranch', type: 'string' },
          { name: 'path', type: 'string' },
          {
            name: 'previousUrl',
            type: 'string',
            description: "The repository's earlier url, e.g. its local repository (local:<slug>) before a remote was attached.",
          },
        ],
      },
    },
    {
      name: 'envProfile',
      type: 'string',
      description:
        "The environment profile its work runs in by default (env.up), e.g. 'analyst' for data work: one of the deployment's profiles.",
    },
    {
      name: 'egress',
      type: 'object',
      description:
        "Where the project's containers may connect, through the egress proxy: hostname globs with optional ports, e.g. registry.npmjs.org, *.github.com:443.",
      fields: [{ name: 'allow', type: 'list', required: true, of: { type: 'string' } }],
    },
    {
      name: 'links',
      type: 'list',
      description: 'Task boards, chat channels, other.',
      of: {
        type: 'object',
        fields: [
          { name: 'system', type: 'string' },
          { name: 'ref', type: 'string' },
        ],
      },
    },
  ],
}

export interface Repository {
  /** The remote git fetches and pushes (ssh when the employee pushes with its key). */
  url: string
  /** The same repository over https, when `url` is ssh. */
  httpUrl?: string
  defaultBranch?: string
  path?: string
  /** The earlier url, e.g. `local:<slug>` before a remote was attached (the local repository is kept). */
  previousUrl?: string
}

export interface ProjectData extends Record<string, unknown> {
  name: string
  aliases?: string[]
  description?: string
  status?: 'active' | 'maintenance' | 'sunset'
  repositories?: Repository[]
  /** Egress allowlist for the project's environments (see `EnvSpec.egress` in `@mp/containers`). */
  egress?: { allow: string[] }
  /** The environment profile its work runs in by default (env.up). */
  envProfile?: string
  links?: { system?: string; ref?: string }[]
}

export const procedureSchema: KindSchema = {
  kind: 'procedure',
  prefix: 'prc',
  description: 'How something is done here: when it applies, who approves, and its steps.',
  titleField: 'name',
  core: [
    { name: 'name', type: 'string', required: true },
    { name: 'applies', type: 'string', required: true, description: 'When it applies, in plain words.' },
    { name: 'body', type: 'text', description: 'Steps and details, markdown.' },
    { name: 'ownerId', type: 'ref', ref: 'contact', description: "Who to ask when it's unclear or out of date." },
    {
      name: 'approvals',
      type: 'list',
      description: 'Who has to say yes: a contact or a role.',
      of: {
        type: 'object',
        fields: [
          { name: 'contactId', type: 'ref', ref: 'contact' },
          { name: 'role', type: 'string' },
          { name: 'step', type: 'string', description: 'At which step, e.g. "before issuing the refund".' },
        ],
      },
    },
    { name: 'contextSessionId', type: 'ref', ref: 'session', description: 'The procedure context.' },
    {
      name: 'checklist',
      type: 'list',
      of: {
        type: 'object',
        fields: [
          { name: 'text', type: 'string', required: true },
          { name: 'required', type: 'boolean' },
          { name: 'review', type: 'boolean' },
        ],
      },
    },
    { name: 'skills', type: 'list', of: { type: 'string' }, description: 'Names of skills its steps use.' },
    {
      name: 'projectIds',
      type: 'list',
      of: { type: 'ref', ref: 'project' },
      description: 'Projects it applies to (empty: all).',
    },
    { name: 'archived', type: 'boolean', description: 'Archived: not found, not run, its triggers off.' },
  ],
}

export interface ChecklistItem {
  text: string
  required?: boolean
  review?: boolean
}

export interface ProcedureData extends Record<string, unknown> {
  name: string
  applies: string
  body?: string
  ownerId?: string
  /** Who has to say yes (a contact or a role), and at which step. */
  approvals?: { contactId?: string; role?: string; step?: string }[]
  contextSessionId?: string
  checklist?: ChecklistItem[]
  skills?: string[]
  projectIds?: string[]
  /** Archived procedures are not found or run, and their triggers are off. */
  archived?: boolean
}

/** Common roles on contact -> project links. Any other string is allowed too. */
export const ProjectRoles = {
  owner: 'owner',
  backup: 'backup',
  member: 'member',
  reviewer: 'reviewer',
  stakeholder: 'stakeholder',
} as const

/** Role of the link from an employee to its own contact. */
export const IDENTITY = 'identity'
/** Role of the links from a procedure to the projects in its `projectIds`. */
export const APPLIES_TO = 'applies_to'

export const contactRef = (id: string): Ref => ({ kind: 'contact', id })
export const projectRef = (id: string): Ref => ({ kind: 'project', id })

export const directorySchemas: KindSchema[] = [
  contactSchema,
  employeeSchema,
  projectSchema,
  procedureSchema,
  contactSuggestionSchema,
]
