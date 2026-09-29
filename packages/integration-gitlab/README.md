# @mp/integration-gitlab

The first-party GitLab integration ([spec: Integrations](../../docs/spec.md#integrations)). GitLab is the git host:
employees push their own branches over SSH with their own key, open merge requests, and hear about pipeline results and
review comments on them. **They never merge** ([no production access](../../docs/spec.md#no-production-access)).

It has three parts, all behind one factory:

- **Tools**: an MCP server (`mcp.gitlab.<tool>`) over the REST API v4.
- **Events in**: GitLab webhooks, verified and turned into events with a subject, an actor and a dedupe key.
- **Identity**: `resolveUser(username)` for matching GitLab users to contacts through `{ system: 'gitlab', id: <username> }`.

## API

- `createGitlabIntegration({ secrets: { token, webhookSecret }, baseUrl?, fetch?, clock?, logger?, retry? })` returns a
  `GitlabIntegration`, which is the `Integration` from `@mp/mcp` plus `client`.
  - `name`: `'gitlab'`.
  - `createMcpServer()`: a new SDK `McpServer` with the tools below. Connect one per client.
  - `handleWebhook({ method, headers, body, query })`: `{ status, body, headers, events }`.
  - `resolveUser(username)`: `{ handle: { system: 'gitlab', id }, email?, name? }` (the email is the user's *public*
    email), or `null`.
  - `baseUrl` defaults to `https://gitlab.com`. For self-hosted GitLab, pass the instance URL, including any sub-path
    (`https://git.example.com/gitlab`). The API is at `<baseUrl>/api/v4`.
  - `retry`: `{ maxRetries (3), retryBaseMs (500), retryMaxMs (30 000), timeoutMs (30 000 per attempt) }`.
- `createGitlabClient(opts)`: the REST client, with `get`, `getText`, `post`, `put`, `request` and `paginate` (it follows
  `X-Next-Page`). It sends the token only as `PRIVATE-TOKEN` and redacts it from errors and logs. It retries 408, 429 and
  5xx and network errors with exponential backoff, honouring `Retry-After`. After the last retry it throws
  `UnavailableError`. Other 4xx throw `MpError('integration_request')` with `details.status` and GitLab's message.
- `createGitlabHooks(client)`: project webhooks, for the harness only (never an MCP tool, so the model can't touch
  them). The client's token needs Maintainer on the project.
  - `listProjectHooks(project)`.
  - `ensureProjectHook(project, { url, token, events?, tokenKnownFor? })` → `{ action: 'created' | 'updated' |
    'unchanged', hook, changed, removedDuplicates }`. Finds ours by URL and creates it when it's missing. Otherwise it
    repairs the events (`HOOK_EVENTS` by default), `enable_ssl_verification` (on unless the URL is `http:`) and a push
    branch filter (cleared), and removes other hooks with the same URL. It never creates a second one. GitLab never
    returns a hook's token, so the token is set again on every update unless `tokenKnownFor` is the id of the hook it
    was last set on (the caller keeps a hash of the secret to know that).
  - `removeProjectHook(project, id | { url })` → how many were removed (a missing hook is fine).
- `HOOK_EVENTS`: `push_events`, `note_events`, `issues_events`, `merge_requests_events`, `job_events`,
  `pipeline_events` on, `tag_push_events` off. `sslVerificationFor(url)`.
- `gitlabProjectPath(repoUrl, baseUrl?)`: the project path of a repository URL on this GitLab (https with the instance's
  sub-path, `git@host:group/repo.git`, `ssh://git@host:port/group/repo.git`; gitlab.com always counts), or `null`.
- `assertNotMerging(method, path, body?)`: the guard the client runs before every request (see below).
- `projectRef(project)`: `42` stays `42`, and `group/sub/repo` becomes `group%2Fsub%2Frepo`.
- `handleGitlabWebhook(req, secret)`, `mapGitlabEvent(body)`, `verifyGitlabToken(header, secret)`, `dedupeKey(headers, body,
  kind)`, `mrIidFromRef(ref)`, `TOOL_NAMES`, `LIMITS`.

## Never merging

This is the hard rule, and it's enforced three times:

1. **No tool can merge.** There is no merge, approve or auto-merge tool, and no tool takes an argument that could merge
   (the SDK drops unknown arguments such as `merge_when_pipeline_succeeds`). The tests check this.
2. **The client refuses it.** `assertNotMerging` throws `DeniedError` before sending any request that would merge,
   approve, unapprove, add to a merge train or set auto-merge: `PUT …/merge_requests/:iid/merge`, `POST …/approve`,
   `…/merge_when_pipeline_succeeds`, `…/merge_trains…`, and any merge request body with `state_event: 'merge'`,
   `merge_when_pipeline_succeeds`, `auto_merge`, `auto_merge_strategy` or `merge_commit_message`.
3. **GitLab refuses it.** The bot account has no merge rights on protected branches (set this up below). It doesn't
   depend on the model or on this code.

## Tools

`project` is a numeric id (`42`) or a full path (`group/sub/repo`) everywhere. Results are compact JSON, and errors come
back as `isError` results with `{ error, code, status? }`.

| Tool | What it does |
|------|--------------|
| `get_project` | path, default branch, SSH and HTTP clone URLs, visibility |
| `list_branches` | branches with their last commit, `protected` and `default`; `search`, `limit` |
| `get_file` | a file's raw content at `ref` (default: the default branch), truncated at `max_bytes` (100 KB); binary files are reported, not returned |
| `list_tree` | files and directories at `path` and `ref`, optionally `recursive` |
| `create_merge_request` | `source_branch`, `target_branch` (default: the default branch), `title`, `description`, `draft` (prefixes `Draft:`), `labels`, `reviewers` and `assignees` by username |
| `update_merge_request` | `title`, `description`, `labels` / `add_labels` / `remove_labels`, `draft` |
| `get_merge_request` | the MR with diff stats (files, additions, deletions), the latest pipeline, the count of unresolved discussions and the first 20 of them (id, author, body, path, line) |
| `list_merge_requests` | by `state` (default `opened`), `author`, `source_branch`, `target_branch`, `search` |
| `merge_request_changes` | the diffs per file, within a budget (60 KB total, 20 KB per file), or one file by `path` |
| `comment_merge_request` | a note on an MR |
| `reply_discussion` | a reply in a discussion thread on an MR (default) or an issue (`on: 'issue'`) |
| `pipeline_status` | the latest pipeline for an MR (`iid`) or a `ref` (default: the default branch), with its jobs and the failed ones |
| `job_log` | the last `tail_kb` KB (default 32, max 512) of a job's trace, with ANSI codes and section markers removed |
| `get_issue` | an issue with its description and the last 20 human comments |
| `create_issue` | `title`, `description`, `labels`, `assignees` by username, `confidential` |
| `comment_issue` | a comment on an issue |
| `current_user` | the bot's own id, username and name |

## Events

Every event has `source: 'integration:gitlab'`. The actor is `{ system: 'gitlab', id: <username> }` of whoever caused it.
The text is a short line for the model, e.g. `GitLab acme/billing!12 "Fix rounding": pipeline 900 failed on job test`.

| Webhook (`X-Gitlab-Event`) | Event types | Subject |
|----------------------------|-------------|---------|
| Merge Request Hook | `merge_request.opened` (also reopened), `.updated`, `.approved`, `.unapproved`, `.merged`, `.closed` | `gitlab:<project path>!<mr iid>` |
| Note Hook | `comment.created`, on an MR or an issue (commit and snippet notes are ignored) | the MR's or the issue's subject |
| Pipeline Hook | `pipeline.succeeded`, `.failed`, `.running`, `.canceled` (other statuses are ignored) | the MR's, when the pipeline belongs to one (`merge_request` in the payload, or a `refs/merge-requests/<iid>/…` ref); otherwise `gitlab:<project path>@<ref>` |
| Job Hook | `job.failed` (other statuses are ignored) | the MR's for merge request pipeline refs, otherwise `gitlab:<project path>@<ref>` |
| Push Hook | `push` (tag pushes are ignored) | `gitlab:<project path>@<branch>` |
| Issue Hook | `issue.opened` (also reopened), `.updated`, `.closed` | `gitlab:<project path>#<issue iid>` |

`subject.system` is `gitlab` and `subject.id` is the part after `gitlab:`, e.g. `{ system: 'gitlab', id: 'acme/billing!12' }`.

The payload holds the relevant fields only, always with `actor` (the username that caused it) and `project`, and then what matters for the kind: iid, title,
url, branches, labels, reviewers, note body and discussion id, pipeline and job ids, failed jobs, commits. Never the raw body or anyone's email.

- **Verification.** GitLab sends the webhook's secret token as-is in `X-Gitlab-Token`. It is compared in constant time
  (both sides hashed, then `timingSafeEqual`). A wrong or missing token gets `401` and no events. GitLab doesn't sign
  bodies or timestamps, so there's no staleness check: replays are handled by the dedupe key.
- **Dedupe key.** `gitlab:<object_kind>:<X-Gitlab-Event-UUID>`. The same event delivered again, or to both a project
  and a group hook, has the same key, so the harness stores it once. Without an event UUID, it's the
  `X-Gitlab-Webhook-UUID` plus a hash of the body.
- Other methods get `405`, invalid JSON `400`. Events it doesn't route get `200` with no events, so GitLab doesn't
  disable the hook.

## Setup on GitLab

**Use the guided setup on the employee's page** (`/employees/<id>` → Integrations → GitLab). It checks the token
(scopes, expiry), adds the employee's SSH key to the account for you ("Add it for me"), lists its projects with a
warning for Maintainer access or an unprotected default branch, shows the webhooks the harness registered, and adds
the recommended trigger (`packages/server/src/setup/gitlab.ts`). The steps below are the manual fallback.

Each employee has **its own GitLab identity**: a service account with its own token and SSH key, so its branches,
merge requests and comments show who did them, and its access can be limited and revoked on its own. The server
(`packages/server/src/integrations`) builds one instance per employee from that employee's secrets, and **registers
the webhooks itself** (see [Webhooks](#webhooks)).

1. **A service account per employee, as Developer.** On GitLab Premium or Ultimate, create a *service account* (group
   *Settings → Service accounts*, or *Admin → Service accounts* on self-managed). Otherwise use a dedicated user for the
   employee (for example `billing-bot`, with a name that says it's an AI). Give it the **Developer** role on the
   projects (or the group) it works on: enough to push branches and open merge requests, and GitLab itself stops it
   from merging into protected branches.
2. **Its token.** A personal access token for that account with the **`api`** scope. It doesn't need
   `write_repository`: the harness pushes over SSH. Set an expiry and rotate it.
3. **Its SSH key.** The harness generates an ed25519 keypair per employee and shows the public key, with its fingerprint,
   on the employee's page. "Add it for me" there adds it to the account with the token; by hand, add it under *User
   settings → SSH Keys* (or through the API for a service account). Pushes then go through that key.
4. **Protected branches.** Protect `main` (and release branches): *Allowed to merge* and *Allowed to push and merge*
   set to Maintainers, or to named people, never the service accounts. Leave *Allowed to force push* off. If you use
   merge request approvals, don't count the service accounts as eligible approvers. The harness also refuses to push to
   protected branches, but GitLab must enforce it too. This matters most when an employee's own token registers the
   hooks (step 5): that account is then a Maintainer, and only the branch protection stops it from merging.
5. **Secrets** in the harness ([secrets](../../docs/spec.md#secrets)), under *Settings → Secrets* or through the API:
   - `GITLAB_TOKEN`, **scoped to the employee**: its token from step 2.
   - `GITLAB_HOOKS_TOKEN`, **global**, recommended: a *provisioning token* used only to register webhooks. It's a token
     of a Maintainer of the projects or an Owner of the group (a group access token with the Maintainer role and the
     `api` scope works). With it, the service accounts stay Developer. Without it, each employee's own token registers
     its hooks, and then needs Maintainer.
   - `GITLAB_BASE_URL` (optional): for self-hosted GitLab. The server's `GITLAB_BASE_URL` environment variable sets it
     for the deployment; a secret of that name overrides it (per employee or globally).

   ```sh
   curl -X PUT https://<harness>/api/secrets -H 'content-type: application/json' \
     -d '{ "name": "GITLAB_TOKEN", "value": "glpat-…", "scope": { "type": "employee", "id": "emp_…" } }'
   ```

   GitLab is enabled for an employee when its `GITLAB_TOKEN` resolves (a global one is the fallback). Until then its
   `mcp.gitlab.*` tools answer "GitLab isn't set up for this employee: set the GITLAB_TOKEN secret".
6. **`PUBLIC_URL`** on the server: the address GitLab can reach the harness at, e.g. `https://mp.example.com`.
7. **Link the repositories to projects.** Each project's `repositories` lists its repository URLs (https or SSH), and
   the employee is linked to the project (its contact as a member, owner, …), or one of its sessions `works_on` it. A
   deployment with a single employee gets every project.
8. **Handles**: give each person's contact a handle `{ system: 'gitlab', id: '<username>' }`. Otherwise the server
   looks the actor up (`resolveUser`), matches the contact by the user's public email and records the handle on it. It
   never creates contacts from webhooks.

### Webhooks

Once steps 5 to 7 are done, the webhooks appear by themselves. For each GitLab repository the employee works on, the
harness registers a project hook at `https://<harness>/webhooks/gitlab/<employee id>` with push events (all
branches), comments, issues, merge requests, jobs and pipelines, and SSL verification on. Its secret token is the
employee's `GITLAB_WEBHOOK_SECRET`, generated and stored when it's missing. It runs at start, when one of these secrets
changes, when a repository is linked or the employee joins a project, and every 6 hours. It repairs drift (events, SSL
verification, the token), never creates duplicates, and removes the hook of a repository that is no longer linked.

*Settings → Integrations* in the web UI (and `GET /api/integrations/status`) shows, per employee, which integrations are
set up, and the Webhooks step of the employee's guided setup shows each hook's status and when its project last sent
an event, with "Register webhooks now". The usual error is a 403: "the token needs Maintainer on <project> to register
webhooks; set GITLAB_HOOKS_TOKEN (a Maintainer or group Owner) or give the service account Maintainer".

The model never gets a tool to manage webhooks.

### Manual webhooks (fallback)

When the harness can't register hooks (no Maintainer token at all, or a hook on a group), add one by hand in
*Settings → Webhooks → Add new webhook*:

- Deployment-wide: a group (or project) webhook with URL `https://<harness>/webhooks/gitlab`, and a global
  `GITLAB_WEBHOOK_SECRET`. Its events belong to no employee in particular, so any employee's triggers and
  subscriptions can take them.
- Per employee: `https://<harness>/webhooks/gitlab/<employee id or handle>`, with the employee-scoped
  `GITLAB_WEBHOOK_SECRET`. Its events belong to that employee. Each URL has its own secret.
- Secret token: a long random value, the same as the `GITLAB_WEBHOOK_SECRET` for that URL.
- Trigger: **Push events** (all branches, or a wildcard like `mp/*`), **Comments**, **Issues events**, **Merge request
  events**, **Job events**, **Pipeline events**
- SSL verification: on

A webhook URL without a secret answers `404`. A manual per-employee hook at the same URL as the harness's (the
employee id) is adopted and repaired; one at the handle URL is left alone.

### Self-hosted GitLab

Pass `baseUrl` with the instance URL, including a sub-path if GitLab runs under one (`https://git.example.com/gitlab`).
Everything else is the same. The harness must be able to reach the instance, and the instance must be able to reach
`https://<harness>/webhooks/gitlab`: on a private network, allow outbound webhook requests to it (*Admin → Settings →
Network → Outbound requests*). If the instance uses a private CA, the harness's Node process needs it
(`NODE_EXTRA_CA_CERTS`).

## Recommended triggers and subscriptions

New issues assigned to the employee start work through a trigger. Once a session is working on something, it
subscribes to it, so what happens next comes straight back to it and not to the intake context.

Triggers are not created automatically (the guided setup's "Add recommended trigger" adds one routing issues assigned to
the account to the router context). A trigger (`CreateTriggerInput` in `@mp/events`, e.g. created by the employee
with its `triggers.create` tool) for open issues assigned to the employee, routed to its intake context:

```json
{
  "name": "GitLab issues for billing-bot",
  "employeeId": "emp_…",
  "match": {
    "source": "integration:gitlab",
    "type": "issue.*",
    "filter": { "payload.assignees": "billing-bot", "payload.state": "opened" }
  },
  "target": { "type": "session", "sessionId": "ses_… (the intake context)" }
}
```

After the session pushes its branch (`git.push`) and calls `mcp.gitlab.create_merge_request`, the server subscribes the
session to the MR as its primary subscriber (subject `gitlab:<project path>!<iid>`, read from the result's `web_url`), so
pipeline results, failed jobs and review comments on it go straight to that session. The employee's own MRs need no
trigger. To also skip the bot's own comments and MR updates, the session can subscribe again with a filter:

```json
{
  "subject": { "system": "gitlab", "id": "acme/platform/billing!12" },
  "types": ["pipeline.failed", "pipeline.succeeded", "job.failed", "comment.created", "merge_request.*"],
  "filter": { "payload.actor": { "$ne": "billing-bot" } },
  "primary": true
}
```

The subscription ends when the MR is merged or closed: after delivering `merge_request.merged` or
`merge_request.closed`, the server ends every subscription to the subject (`subscriptions.endForSubject`). A review comment arrives as `comment.created` with the
`discussion_id`, so the session can fix the code, push, and answer with `reply_discussion`. A failed pipeline arrives as
`pipeline.failed` naming the failed jobs, so the session can read `job_log` and fix it.

## Tests

`npx vitest run --project node packages/integration-gitlab` runs everything against a local fake of the GitLab API
(`test/fake-gitlab.ts`, a `node:http` server on port 0 with GitLab's payload shapes, pagination headers and errors).
Every tool goes through a real MCP client over `InMemoryTransport`. Webhook tests cover verification, dedupe and every
event mapping; client tests cover 429 with Retry-After, 5xx retries, 4xx, network failures, token redaction and the
merge guard. Hook tests (`test/hooks.test.ts`) cover create, idempotence, token resets, drift repair, duplicates, http
URLs, 403 and 404, and repository URL parsing; the tools list is checked to have no merge, webhook or admin tool.

`MP_LIVE_GITLAB=1` with `GITLAB_TOKEN` (and optionally `GITLAB_BASE_URL`) runs one harmless read (`GET /user`) against a
real GitLab (`test/live.test.ts`). It's skipped by default.

## Replacing

Any MCP server with GitLab tools can replace this one. Keep the event types and subjects, so triggers and subscriptions
keep working.
