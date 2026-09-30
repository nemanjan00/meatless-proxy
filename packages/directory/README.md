# @mp/directory

Who is who and what is what: contacts, AI employees, projects and procedures,
as extendable records on top of `@mp/records`.

## API

`createDirectory({ records, clock? })` registers the kinds `contact` (`con_`),
`employee` (`emp_`), `project` (`pro_`), `procedure` (`prc_`) and `contact_suggestion` (`csg_`) on
`records.kinds` and returns:

- `contacts`: `create` (kind `person`, `ai` for an employee's contact, or `agent` for a local agent in chat; defaults to `person`; handles must be unique), `get`, `require`, `update`, `list`, `search(text)`,
  `byHandle(system, id)` (identity resolution; `mp` handles match slugs, so `@Ana` finds `ana`), `byEmail`.
- `employees`: `create` (also creates the AI contact with handle `{system: 'mp', id: <slug>}`, the slug of `handle` when given, else of `name`, and links employee -> contact with role
  `identity`; the slug is the employee's record key), `get`, `require`, `list`, `update` (renaming renames the contact and handle),
  `byContact`, `byHandle('@name')`, `contact(employeeId)`.
- `projects`: `create`, `get`, `require`, `update`, `list`, `search`, `byName` (name or alias), `addMember(projectId, contactId, role)`,
  `removeMember`, `setOwner`, `owner`, `members` (`{contact, roles, links}[]`), `forContact` (`{project, roles, links}[]`).
- `procedures`: `create`, `get`, `require`, `update`, `list`, `find(text, { projectIds })` (keyword scoring over name, applies, body;
  archived procedures are left out). `approvals` are `{ contactId | role, step? }`; `archived: true` retires one.
- `learning` (`learning.ts`, docs/spec.md "What employees learn about people"): `learn({ contactId, employeeId, source,
  role?, team?, manager?, bioNote? })` fills empty fields (recording `{ field, value, employeeId, source, at }` in the
  contact's `learned` list), turns a value for a set field into a `contact_suggestion` record (`csg_`, keyed by contact,
  field, employee and normalised value, so a repeat updates it and a rejected one stays rejected), and appends a bio
  note as `- <date>: <note> [source: <source>]` unless the bio already says it; people only, 120 characters per field,
  280 per note, 4000 for the bio. `suggestions(contactId, { status })`, `getSuggestion`, `accept(id, by)` (applies it,
  records who accepted, settles other employees' suggestions of the same value), `reject(id, by)`, and `facts(contact)`:
  the learned facts that still hold. Contact writes are compare-and-swap, retried. `createDirectory` takes an optional
  `clock` for their timestamps.

A repository is `{ url, httpUrl?, defaultBranch?, path? }`: `url` is what git fetches and pushes (ssh when the
employee pushes with its key), `httpUrl` the same repository over https. An employee works on a project through a
link from its AI contact (the harness's "Your projects" entry and GitLab hook provisioning read it); its older
`scope.projects` is only a fallback that the server migrates to links.

Ownership and membership are links `contact -> project` with a role (`ProjectRoles`: owner, backup, member, reviewer,
stakeholder, or any string), stored once and read from both sides. Any contact can own a project, including an employee's.
A project's optional `egress: { allow: string[] }` is its containers' egress allowlist (see `EnvSpec.egress`). An
employee's optional `network` (`EmployeeNetwork`: `'none'`, `'project'` (the default) or `{ allow: string[] }`) says what
its environments and sandbox may reach on top of that; `create` and `update` refuse other shapes (`invalidNetwork`).
A procedure's `projectIds` are mirrored as `applies_to` links. Schemas (`contactSchema`, ...) and data types are exported;
deployments add fields with `records.kinds.extend(kind, fields)`.

Note: the store treats the query field `kind` as the record kind, so `where: { kind: 'ai' }` can't filter contacts by
their `kind` field; filter in code.

## Tests

`test/directory.test.ts`, against `memoryStore()`: identity resolution across systems, handle conflicts, employees and
their contacts, renames, ownership both ways, an AI owner, referential integrity, procedure search, extension fields, accepting, rejecting and
reopening suggestions. The tool's rules are tested in `packages/stdlib/test/update-contact.test.ts`.

## Replacing it

Write a package with the same `Directory` interface registering the same kinds, and switch the server to it.
