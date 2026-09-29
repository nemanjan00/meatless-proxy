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
    { name: 'kind', type: 'enum', values: ['person', 'ai'], required: true, description: 'A person or an AI employee.' },
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
  ],
}

export interface ContactData extends Record<string, unknown> {
  name: string
  kind: 'person' | 'ai'
  handles?: Handle[]
  email?: string
  role?: string
  team?: string
  manager?: string
  permissions?: string
  bio?: string
  status?: 'active' | 'left'
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

export interface EmployeeData extends Record<string, unknown> {
  contactId: string
  name: string
  personality?: string
  instructions?: string
  scope?: EmployeeScope
  toolAllow?: string[]
  toolDeny?: string[]
  model?: string
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
          { name: 'defaultBranch', type: 'string' },
          { name: 'path', type: 'string' },
        ],
      },
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
  url: string
  defaultBranch?: string
  path?: string
}

export interface ProjectData extends Record<string, unknown> {
  name: string
  aliases?: string[]
  description?: string
  status?: 'active' | 'maintenance' | 'sunset'
  repositories?: Repository[]
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
  approvals?: { contactId?: string; role?: string }[]
  contextSessionId?: string
  checklist?: ChecklistItem[]
  skills?: string[]
  projectIds?: string[]
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

export const directorySchemas: KindSchema[] = [contactSchema, employeeSchema, projectSchema, procedureSchema]
