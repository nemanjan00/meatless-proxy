import type { KindSchema } from '@mp/core'

export const SESSION_KIND = 'session'
export const RUN_KIND = 'run'
export const INBOX_KIND = 'inbox'
export const TEMPLATE_KIND = 'template'

/** Link roles used by sessions. */
export const SessionRoles = {
  /** fork -> parent session */
  forkedFrom: 'forked_from',
  /** suspended run -> each run it waits for */
  waitsOn: 'waits_on',
} as const

const runMode: { type: 'enum'; values: string[] } = { type: 'enum', values: ['continuing', 'ephemeral'] }
const runStates = ['queued', 'running', 'suspended', 'paused', 'completed', 'failed', 'cancelled']

export const sessionSchema: KindSchema = {
  kind: SESSION_KIND,
  prefix: 'ses',
  description: 'One line of work by an employee: a pointer (head) into the entry tree, plus metadata and a document.',
  titleField: 'title',
  core: [
    { name: 'title', type: 'string', required: true },
    { name: 'slug', type: 'string', required: true, description: 'Unique per employee, for @employee#slug' },
    { name: 'employeeId', type: 'string', required: true },
    { name: 'status', type: 'enum', values: ['active', 'waiting', 'done', 'abandoned'], required: true },
    { name: 'head', type: 'string', description: 'Last committed entry' },
    { name: 'rootId', type: 'ref', ref: SESSION_KIND, required: true },
    {
      name: 'parent',
      type: 'object',
      fields: [
        { name: 'sessionId', type: 'ref', ref: SESSION_KIND, required: true },
        { name: 'entryId', type: 'string' },
      ],
    },
    { name: 'depth', type: 'number', required: true },
    {
      name: 'template',
      type: 'object',
      fields: [
        { name: 'id', type: 'ref', ref: TEMPLATE_KIND, required: true },
        { name: 'version', type: 'number', required: true },
      ],
    },
    { name: 'toolset', type: 'list', of: { type: 'string' }, required: true },
    { name: 'model', type: 'string' },
    { name: 'document', type: 'text', required: true },
    { name: 'defaultRunMode', ...runMode },
    { name: 'meta', type: 'json' },
  ],
}

export const runSchema: KindSchema = {
  kind: RUN_KIND,
  prefix: 'run',
  description: 'One piece of work in a session.',
  core: [
    { name: 'sessionId', type: 'ref', ref: SESSION_KIND, required: true },
    { name: 'employeeId', type: 'string', required: true },
    { name: 'rootSessionId', type: 'ref', ref: SESSION_KIND, required: true },
    { name: 'mode', ...runMode, required: true },
    { name: 'state', type: 'enum', values: runStates, required: true },
    { name: 'base', type: 'string' },
    { name: 'tip', type: 'string' },
    {
      name: 'cause',
      type: 'object',
      required: true,
      fields: [
        { name: 'type', type: 'enum', values: ['event', 'fork', 'loop', 'manual', 'wake'], required: true },
        { name: 'eventId', type: 'string' },
        { name: 'parentRunId', type: 'string' },
        { name: 'note', type: 'string' },
      ],
    },
    { name: 'requesterId', type: 'string' },
    { name: 'priority', type: 'number', required: true },
    { name: 'wait', type: 'json' },
    { name: 'commit', type: 'boolean' },
    { name: 'commitSummary', type: 'string' },
    { name: 'steps', type: 'number', required: true },
    { name: 'pauseReason', type: 'string' },
    { name: 'result', type: 'json' },
    { name: 'startedAt', type: 'timestamp' },
    { name: 'endedAt', type: 'timestamp' },
    { name: 'runningSince', type: 'timestamp' },
    { name: 'activeMs', type: 'number' },
    { name: 'limitPaused', type: 'enum', values: ['steps', 'wall'] },
    { name: 'stepsFrom', type: 'number' },
    { name: 'committed', type: 'json' },
  ],
}

export const inboxSchema: KindSchema = {
  kind: INBOX_KIND,
  prefix: 'inb',
  description: "A delivery waiting for a session's continuing run to pick it up.",
  core: [
    { name: 'sessionId', type: 'ref', ref: SESSION_KIND, required: true },
    { name: 'eventId', type: 'string', required: true },
    { name: 'expectedToAct', type: 'boolean', required: true },
    { name: 'trusted', type: 'boolean', required: true },
    // Deliberately `string`, not `text`: untrusted content must not create mention links.
    { name: 'text', type: 'string', required: true },
    { name: 'source', type: 'string', required: true },
    { name: 'type', type: 'string', required: true },
    { name: 'consumed', type: 'boolean', required: true },
    { name: 'consumedByRun', type: 'string' },
  ],
}

export const templateSchema: KindSchema = {
  kind: TEMPLATE_KIND,
  prefix: 'tpl',
  description: 'How to start a session: instructions with {{param}} placeholders, tools, links, checklist.',
  titleField: 'name',
  core: [
    { name: 'name', type: 'string', required: true },
    { name: 'description', type: 'string' },
    { name: 'instructions', type: 'text', required: true },
    {
      name: 'params',
      type: 'list',
      of: {
        type: 'object',
        fields: [
          { name: 'name', type: 'string', required: true },
          { name: 'description', type: 'string' },
          { name: 'required', type: 'boolean' },
        ],
      },
    },
    { name: 'toolset', type: 'list', of: { type: 'string' } },
    { name: 'defaultRunMode', ...runMode },
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
    { name: 'links', type: 'json' },
    { name: 'document', type: 'text' },
  ],
}

export const sessionSchemas: KindSchema[] = [sessionSchema, runSchema, inboxSchema, templateSchema]
