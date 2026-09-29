# @mp/directory

Who is who and what is what: contacts, AI employees, projects and procedures,
as extendable records on top of `@mp/records`.

## API

`createDirectory({ records })` registers the kinds `contact` (`con_`),
`employee` (`emp_`), `project` (`pro_`) and `procedure` (`prc_`) on
`records.kinds` and returns:

- `contacts`: `create` (kind `person`, `ai` for an employee's contact, or `agent` for a local agent in chat; defaults to `person`; handles must be unique), `get`, `require`, `update`, `list`, `search(text)`,
  `byHandle(system, id)` (identity resolution; `mp` handles match slugs, so `@Ana` finds `ana`), `byEmail`.
- `employees`: `create` (also creates the AI contact with handle `{system: 'mp', id: <slug>}`, the slug of `handle` when given, else of `name`, and links employee -> contact with role
  `identity`; the slug is the employee's record key), `get`, `require`, `list`, `update` (renaming renames the contact and handle),
  `byContact`, `byHandle('@name')`, `contact(employeeId)`.
- `projects`: `create`, `get`, `require`, `update`, `list`, `search`, `byName` (name or alias), `addMember(projectId, contactId, role)`,
  `removeMember`, `setOwner`, `owner`, `members` (`{contact, roles, links}[]`), `forContact` (`{project, roles, links}[]`).
- `procedures`: `create`, `get`, `require`, `update`, `list`, `find(text, { projectIds })` (keyword scoring over name, applies, body).

Ownership and membership are links `contact -> project` with a role (`ProjectRoles`: owner, backup, member, reviewer,
stakeholder, or any string), stored once and read from both sides. Any contact can own a project, including an employee's.
A project's optional `egress: { allow: string[] }` is its containers' egress allowlist (see `EnvSpec.egress`).
A procedure's `projectIds` are mirrored as `applies_to` links. Schemas (`contactSchema`, ...) and data types are exported;
deployments add fields with `records.kinds.extend(kind, fields)`.

Note: the store treats the query field `kind` as the record kind, so `where: { kind: 'ai' }` can't filter contacts by
their `kind` field; filter in code.

## Tests

`test/directory.test.ts`, against `memoryStore()`: identity resolution across systems, handle conflicts, employees and
their contacts, renames, ownership both ways, an AI owner, referential integrity, procedure search, extension fields.

## Replacing it

Write a package with the same `Directory` interface registering the same kinds, and switch the server to it.
