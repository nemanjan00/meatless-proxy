# @mp/skills

Company-level and project-level skills (`skill`, `skl_`): packaged playbooks the model sees by name and description and
loads on demand.

## API

`createSkills({ records })` registers the kind and returns:

- `create` (scope defaults to company; names are unique per scope, case-insensitive), `update`, `get`, `list({ scope })`, `remove`.
- `available({ projectIds })`: company skills plus those projects' skills, one per name. A project skill overrides a company
  skill with the same name (`overrides` names the company skill); between projects, the first listed wins. Returns
  `{ id, name, description, version, scope, overrides? }`.
- `load(nameOrId, { projectIds })`: `{ skill, body, version, files }` resolved the same way, `NotFoundError` if not available.
  Record `version` with the session.

## Tests

`test/skills.test.ts` with `memoryStore()`: validation, uniqueness, overriding, loading with versions and files, extension fields.

## Replacing it

Same `SkillsService` interface and `skill` kind.
