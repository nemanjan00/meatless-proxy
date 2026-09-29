import type { KindSchema } from '@mp/core'

const subjectField = (name: string, required = false) => ({
  name,
  type: 'object' as const,
  required,
  description:
    'What the record is about: `{ system, id }`, e.g. `{ system: "linear", id: "PAY-123" }` or `{ system: "mp", id: "ses_…" }`.',
  fields: [
    { name: 'system', type: 'string' as const, required: true },
    { name: 'id', type: 'string' as const, required: true },
  ],
})

/** A durable event. The record key is its dedupe key, so the same event is stored once. */
export const eventSchema: KindSchema = {
  kind: 'event',
  prefix: 'evt',
  description: 'Something that happened, stored before anything acts on it. The payload is untrusted raw content.',
  titleField: 'type',
  core: [
    { name: 'source', type: 'string', required: true, description: 'e.g. `mcp:linear`, `chat`, `timer`, `ui`, `git`, `run`.' },
    { name: 'type', type: 'string', required: true, description: 'e.g. `task.assigned`, `message.posted`, `run.completed`.' },
    subjectField('subject'),
    { name: 'subjectKey', type: 'string', description: 'Derived from `subject` (`system:id`), for queries.' },
    { name: 'actorContactId', type: 'ref', ref: 'contact', description: 'The contact who caused it, if known.' },
    { name: 'employeeId', type: 'ref', ref: 'employee', description: 'The employee it is meant for, if known.' },
    { name: 'payload', type: 'json', description: 'Raw content, kept as untrusted data.' },
    { name: 'text', type: 'string', description: 'Short rendering of the event.' },
    { name: 'routed', type: 'boolean', required: true },
    { name: 'routedAt', type: 'timestamp' },
    { name: 'receivedAt', type: 'timestamp', required: true },
  ],
}

/** Routes new events that match it to a context. */
export const triggerSchema: KindSchema = {
  kind: 'trigger',
  prefix: 'trg',
  description: 'Routes matching new events into a context (a session, a procedure context, or the router).',
  titleField: 'name',
  core: [
    { name: 'name', type: 'string', required: true },
    { name: 'employeeId', type: 'ref', ref: 'employee', required: true },
    { name: 'enabled', type: 'boolean', required: true },
    { name: 'priority', type: 'number', required: true, description: 'Higher matches first.' },
    {
      name: 'match',
      type: 'object',
      required: true,
      fields: [
        { name: 'source', type: 'string', description: 'Glob, e.g. `mcp:*`.' },
        { name: 'type', type: 'string', description: 'Glob, e.g. `task.*`.' },
        { name: 'subject', type: 'json', description: '`{ system?, id? }`, each a glob.' },
        { name: 'where', type: 'json', description: 'Dot path into the event (`payload.x`, `subject.id`) -> expected value.' },
        {
          name: 'filter',
          type: 'json',
          description: 'MongoDB-style query over the event (sift), e.g. `{"payload.priority":{"$gte":2}}`.',
        },
      ],
    },
    {
      name: 'target',
      type: 'json',
      required: true,
      description: '`{type:"session",sessionId}`, `{type:"procedure",procedureId}` or `{type:"router"}`.',
    },
    { name: 'fork', type: 'boolean', required: true, description: 'Route to a fork of the target context.' },
    { name: 'mode', type: 'enum', values: ['continuing', 'ephemeral'], required: true },
    { name: 'fired', type: 'number', required: true },
    { name: 'lastFiredAt', type: 'timestamp' },
    {
      name: 'schedule',
      type: 'json',
      description: '`{ cron, timezone?, graceSeconds? }`: fires on a schedule instead of matching events.',
    },
    {
      name: 'lastScheduledAt',
      type: 'timestamp',
      description: 'The last scheduled firing handled, or when the schedule was set or enabled.',
    },
  ],
}

/** A session's interest in a subject. Record key: `sessionId|subjectKey`. */
export const subscriptionSchema: KindSchema = {
  kind: 'subscription',
  prefix: 'sub',
  description: 'Delivers events about a subject straight to a session, skipping triggers.',
  core: [
    { name: 'sessionId', type: 'ref', ref: 'session', required: true },
    subjectField('subject', true),
    { name: 'subjectKey', type: 'string', required: true },
    { name: 'primary', type: 'boolean', required: true, description: 'Expected to act on untagged events.' },
    { name: 'types', type: 'list', of: { type: 'string' }, description: 'Event type globs; all types when missing.' },
    { name: 'filter', type: 'json', description: 'MongoDB-style query (sift) the event must match.' },
    { name: 'active', type: 'boolean', required: true },
    { name: 'endedReason', type: 'string' },
  ],
}
