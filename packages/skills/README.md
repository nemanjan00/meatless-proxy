# @mp/skills

Company-level and project-level skills (`skill`, `skl_`): packaged playbooks the model sees by name and description and
loads on demand.

## API

`createSkills({ records })` registers the kind and returns:

- `create` (scope defaults to company; names are unique per scope, case-insensitive), `update`, `get`, `list({ scope })`, `remove`.
- Fields: `name`, `description`, `whenToUse?` (shown with the description), `body`, `scope`, `files?`, `enabled?`: `false`
  switches a skill off, so `available` and `load` leave it out (and a switched-off project skill no longer overrides the
  company one); `list` still returns it.
- `available({ projectIds })`: company skills plus those projects' skills, one per name. A project skill overrides a company
  skill with the same name (`overrides` names the company skill); between projects, the first listed wins. Returns
  `{ id, name, description, whenToUse?, version, scope, overrides? }`.
- `load(nameOrId, { projectIds })`: `{ skill, body, version, files }` resolved the same way, `NotFoundError` if not available.
  Record `version` with the session.

## Tests

`test/skills.test.ts` with `memoryStore()`: validation, uniqueness, overriding, loading with versions and files, switching off,
extension fields.

## Replacing it

Same `SkillsService` interface and `skill` kind.
