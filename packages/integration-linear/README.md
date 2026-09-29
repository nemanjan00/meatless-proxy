# @mp/integration-linear

The first-party **Linear** integration (docs/spec.md#integrations): Linear is the task system. It has three parts,
all behind one factory that implements `Integration` from `@mp/mcp`:

- **Tools**: an MCP server named `linear` over Linear's GraphQL API, so the tools are `mcp.linear.<tool>`.
- **Events in**: signed Linear webhooks, verified and turned into events with subject `linear:<issue identifier>`.
- **Identity**: `resolveUser(id)` returns a Linear user's email and name, so the server can match them to a contact.

Layer 2. Depends on `@mp/core`, `@mp/mcp`, `@modelcontextprotocol/sdk` and `zod`. There is no Linear SDK: the
GraphQL client is a thin wrapper over `fetch`.

## API

```ts
import { createLinearIntegration } from '@mp/integration-linear'

const linear = createLinearIntegration({
  secrets: { apiKey, webhookSecret }, // plain values, resolved by the server
  fetch, // optional
  baseUrl, // optional, default https://api.linear.app/graphql
  clock, // optional
  logger, // optional
  retry, // optional: { maxRetries, retryBaseMs, retryMaxMs, timeoutMs, sleep }
})
linear.name // 'linear'
linear.createMcpServer() // a fresh SDK McpServer; connect it in-process (InMemoryTransport)
await linear.handleWebhook({ method, headers, body, query }) // { status, body, headers, events }
await linear.resolveUser('<linear user id>') // { handle: { system: 'linear', id }, email, name } | null
```

Lower-level exports: `createLinearClient` (`request(query, variables, { mutation?, maxRetries? })` and
`paginate(query, variables, select, limit)`), `createLinearApi`, `createLinearMcpServer`, `LINEAR_TOOLS`,
`verifySignature`, `mapWebhook`, `waitFor`, `summarize` and `parsePriority`.

### The API client

- Sends `Authorization: <apiKey>` exactly as configured: a personal API key as is, or `Bearer <token>` for OAuth.
- **Rate limits** (HTTP 429, or HTTP 400 with a `RATELIMITED` GraphQL error) are retried after `Retry-After`, else
  after `X-RateLimit-Requests-Reset` (epoch ms), else with exponential backoff. Each delay is capped at `retryMaxMs`.
- **5xx, network errors and timeouts** are retried for queries. Mutations are retried only on rate limits, because
  Linear provably didn't run them then. A mutation that fails with a 5xx or a dropped connection is reported as
  "may have been applied", so an issue is never created twice.
- After the retries run out: `UnavailableError`. Every other failure (a GraphQL error, a 4xx, authentication) is
  `MpError('integration_request')` with `details.status` and `details.code` (Linear's `extensions.code`). The message
  is Linear's `userPresentableMessage` when it has one. The key is never logged, and it's redacted from error texts.
- **Pagination** follows `first`/`after` and `pageInfo { hasNextPage endCursor }` in pages of 50, up to the limit.
  Tools that page return `nextCursor`.

## Tools

Every tool returns compact JSON text (not raw API objects). A failure is an `isError` result with
`{ error, code, status?, hint? }`. Issues are returned as
`{ id, identifier, title, url, state, stateType, priority, assignee: { id, name, email }, team, labels, project, parent, updatedAt }`.
References are resolved for the model: team keys (`PAY`), state names, label names, user emails or names, `me`,
issue identifiers (`PAY-123`) and project names are all accepted where an id is.

| Tool | Arguments | Returns |
|---|---|---|
| `search_issues` | `text?` (full-text), `team?`, `state?` (names or types), `assignee?` (`me`, `none`, email, name, id), `labels?` (all must match), `limit?` (25, max 100), `cursor?` | `{ issues, nextCursor }`, most recently updated first |
| `get_issue` | `issue` (identifier or id), `comments?` (10, max 50) | the issue plus `description`, `creator`, `cycle`, `parent`, `children`, and the latest comments, oldest first |
| `create_issue` | `teamId?` (key or id; default the parent's team), `title`, `description?` (markdown), `priority?` (0-4 or name), `assigneeId?`, `labelIds?` (names or ids), `parentId?` (identifier or id), `projectId?` (name or id), `state?` | the new issue |
| `update_issue` | `issue`, `title?`, `description?`, `state?` (by name), `assignee?` (`null` or `none` unassigns), `priority?`, `labels?` (replace), `addLabels?`, `removeLabels?` | the updated issue |
| `create_sub_issue` | `parent`, `title`, `description?`, `assignee?`, `priority?`, `labels?` | `{ id, identifier, url, title, parent }` |
| `comment` | `issue`, `body` (markdown) | `{ id, url, identifier, createdAt }` |
| `list_teams` | `limit?` | `{ teams: [{ id, key, name }] }` |
| `list_workflow_states` | `team` | `{ states: [{ id, name, type }] }` in board order |
| `list_users` | `query?`, `includeInactive?`, `limit?` | `{ users: [{ id, name, displayName, email }] }` |
| `list_projects` | `team?`, `limit?` | `{ projects: [{ id, name, state, lead, targetDate, url }] }` |
| `list_labels` | `team?` (the team's plus workspace labels), `limit?` | `{ labels: [{ id, name, team }] }` |
| `list_cycles` | `team?`, `limit?` | `{ cycles: [{ id, number, name, team, startsAt, endsAt, active, completed }] }` |
| `viewer` | | `{ id, name, displayName, email, organization }`: who the key acts as |

Priorities: 0 none, 1 urgent, 2 high, 3 medium (`normal`), 4 low. A label name that exists both in the team and in
the workspace resolves to the team's label.

## Events

`handleWebhook` checks, in order:

1. `POST` only (405 otherwise).
2. The `Linear-Signature` header must be the hex HMAC-SHA256 of the raw body with the webhook secret, compared in
   constant time (`crypto.timingSafeEqual`). Without a configured secret, every webhook is rejected. 401 otherwise.
3. The body must be JSON (400), and `webhookTimestamp` must be within 60 seconds of now (401 otherwise).

It then answers `200 ok` with the events. The **dedupe key** is `linear:<Linear-Delivery header>`, or
`linear:body:<sha256 of the body>` without the header. Derived events add a suffix (`:assigned`, `:state`,
`:labels`), so a redelivered webhook maps to exactly the same keys and is stored once.

Every event has `source: 'integration:linear'`, **subject** `{ system: 'linear', id: '<identifier>' }` (e.g.
`PAY-123`) and **actor** `{ system: 'linear', id: actor.id ?? data.creatorId ?? data.userId }`. The text looks like
`Linear PAY-123 "Refunds fail for EUR cards": moved to In Progress by Ana Example`.

| Linear | Event types |
|---|---|
| `Issue` create | `issue.created`, plus `issue.assigned` when it already has an assignee |
| `Issue` update | `issue.updated` (always, with `changed` and `changes: { field: { from, to } }`), plus `issue.assigned` / `issue.unassigned` when `assigneeId` changed (`previousAssigneeId`), `issue.state_changed` when `stateId` changed (`previousStateId`), `issue.labeled` when `labelIds` changed (`addedLabels` names, `removedLabelIds`) |
| `Issue` remove | `issue.removed` |
| `Comment` create / update / remove | `comment.created` / `comment.updated` / `comment.removed` |
| `IssueLabel` create / update / remove | `label.created` / `label.updated` / `label.removed` (no subject) |
| `Reaction` create / remove | `reaction.added` / `reaction.removed`, subject = the issue |
| anything else | `<type in snake_case>.<action>`, e.g. `project.update` |

Issue payloads: `action, id, identifier, title, state, stateType, assignee: { id, name, email }, priority,
priorityLabel, labels (names), team (key), url, actor: { id, name }`. Comment payloads: `action, commentId, body,
identifier, issueId, issueTitle, author, parentCommentId, url`.

What the body doesn't carry is looked up, best effort and with one attempt, so a slow API never fails a webhook: an
issue's identifier (from `identifier`, else `team.key-number`, else the API, else the issue id) and the assignee's
email (cached per user).

## Setup on the Linear side

Each employee acts in Linear as **its own member**, with its own API key, so its issues and comments show who did them.
The server (`packages/server/src/integrations`) builds one instance per employee from that employee's secrets.

1. **An API key per employee.** Invite a dedicated member for the employee (such as "Kai", with a name that says it's
   an AI), sign in as it, then open *Settings → Account → Security & access → Personal API keys → New API key*. Give it
   read and write access, limited to the teams it works in if you like. The key starts with `lin_api_`.
   - Or an **OAuth app** (*Settings → API → OAuth applications → New*), installed with `actor=app` so the app acts as
     its own user. Scopes: `read`, `write` (or `issues:create` and `comments:create`). Set the secret to
     `Bearer <access token>`.
2. **A webhook**: *Settings → API → Webhooks → New webhook*. Linear webhooks belong to the workspace, so usually there is
   one for the deployment; a webhook per employee works too.
   - URL: `https://<harness>/webhooks/linear` (deployment-wide), or `https://<harness>/webhooks/linear/<employee id or
     handle>` (its events then belong to that employee, and only its triggers match them).
   - Data change events (resource types): **Issues**, **Comments**, **Issue labels**, and optionally **Emoji
     reactions**.
   - Teams: the teams the employees work in, or all public teams.
   - Save, then copy the **signing secret** Linear shows for the webhook.
3. **Secrets** in the harness (docs/spec.md#secrets):
   - `LINEAR_API_KEY`: the employee's key from step 1, **scoped to the employee**.
   - `LINEAR_WEBHOOK_SECRET`: the signing secret from step 2. Global scope for `/webhooks/linear`; scoped to the
     employee for `/webhooks/linear/<employee>`.

   Set them in the web UI under *Settings → Secrets*, or through the API:

   ```sh
   curl -X PUT https://<harness>/api/secrets -H 'content-type: application/json' \
     -d '{ "name": "LINEAR_API_KEY", "value": "lin_api_…", "scope": { "type": "employee", "id": "emp_…" } }'
   ```

   A global secret is the fallback for an employee without its own. Linear is enabled for an employee when its
   `LINEAR_API_KEY` resolves; until then its `mcp.linear.*` tools answer "Linear isn't set up for this employee: set
   the LINEAR_API_KEY secret". A webhook URL without a signing secret answers `404`. The server passes the values as
   `secrets: { apiKey, webhookSecret }`.
4. **Handles**: give each person's contact a handle `{ system: 'linear', id: '<their Linear user id>' }` (the ids are
   in `list_users`). Otherwise the server looks the actor up with `resolveUser`, matches the contact by email and
   records the handle on it. It never creates contacts from webhooks. Call `viewer` with the employee's key to learn
   its own Linear user id.

## Recommended trigger

Triggers are not created automatically: add this one per employee, e.g. by asking the employee in harness chat to
create it with its `triggers.create` tool. A new issue assigned to the employee then goes to its router context
([the router context](../../docs/spec.md#the-router-context)): it checks its log of decisions, starts a session for the
issue (which then owns it), and keeps a one-line decision. `<kai-linear-id>` is the `id` that `viewer` returns for the employee's key:

```json
{
  "name": "Linear: issue assigned to Kai",
  "employeeId": "emp_kai",
  "match": {
    "source": "integration:linear",
    "type": "issue.assigned",
    "where": { "payload.assignee.id": "<kai-linear-id>" }
  },
  "target": { "type": "router" },
  "fork": false,
  "mode": "ephemeral"
}
```

The session that takes the issue subscribes to `{ system: 'linear', id: 'PAY-123' }`, so comments, state changes and
reassignments on it (all with that subject) go straight to it instead of to the trigger
(docs/spec.md#subscriptions). When the issue is removed (`issue.removed`) or moves to a completed or canceled state
(`issue.state_changed` with `stateType` `completed` or `canceled`), the server ends every subscription to it after
delivering that event.

## Real forks: the employee's `taskSystem`

With `sessions.loop` and `realTasks: true`, each item becomes a Linear issue (docs/spec.md#real-forks-go-through-the-task-system),
and the child session is subscribed to it. Set the employee's `taskSystem` (`TaskSystemConfig` in
`@mp/stdlib`) like this:

```json
{
  "taskSystem": {
    "tool": "mcp.linear.create_issue",
    "args": { "teamId": "PAY" },
    "titleArg": "title",
    "descriptionArg": "description",
    "parentArg": "parentId",
    "idPath": "identifier",
    "subjectSystem": "linear"
  }
}
```

- `idPath: "identifier"` matters: the subscription subject must be `PAY-123` (what webhooks carry), not the issue's
  UUID, which the default `id` path would pick up.
- With `parentTaskId: "PAY-123"` on the loop, each item becomes a sub-issue of PAY-123 (`parentId` takes an
  identifier). Leave out `args.teamId` to always use the parent's team.
- To require a parent, use `"tool": "mcp.linear.create_sub_issue"` with `"parentArg": "parent"` and no `args`
  instead. Every loop then needs a `parentTaskId`.

## Tests

`npx vitest run --project node packages/integration-linear`: every tool through a real MCP client over
`InMemoryTransport` against a local fake of Linear's GraphQL API (`test/fake-linear.ts`: connections, filters,
payloads and error shapes following Linear's schema); the client's retries (429 with Retry-After, RATELIMITED with
the reset header, 5xx backoff, no retry of mutations on 5xx, network errors, timeouts, give-up), error mapping and
pagination; webhook verification (valid, bad/missing/truncated signature, stale and future timestamps, no secret,
replay and dedupe keys) and the mapping of every event type; `resolveUser`.

Live smoke test (skipped by default, one `viewer` read): `MP_LIVE_LINEAR=1 LINEAR_API_KEY=… npx vitest run --project node packages/integration-linear`.

## Replacing

Any MCP server with tools under the same names can replace the tools. Any `Integration` from `@mp/mcp` that emits the
same event types and subjects can replace the whole package.
