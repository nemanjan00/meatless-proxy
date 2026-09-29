# @mp/api

The HTTP and WebSocket contract shared by `@mp/server` and `@mp/web` (layer L1).
Types only, plus two tiny clients. No runtime dependencies, not even `@mp/core`,
so the browser bundle stays free of Node code.

## Public API

| Export | What it is |
|--------|------------|
| `resources.ts` types | `ApiRecord`, `ApiLink`, `ApiEntry`, `ApiKindSchema`, `ApiRevision`, `Page`, and the typed data of each kind the UI knows (`SessionData`, `RunData`, `EventData`, `TriggerData`, `MessageData`, `UsageData`, …) plus view shapes (`SessionDetail`, `SessionTreeNode`, `EntryTree`, `NowSnapshot`, `LineageGraph`, `TriggerStats`, `UsageBreakdown`, `UsageSeries`, `InboxItem`, …) |
| `ROUTES` | every endpoint as `[method, path]`; the server can check it implements each one |
| `ApiClient` | the endpoint contract: one method per route, each documented with its method, path, query, body and response |
| `createApiClient({ baseUrl, fetch?, headers?, onUnauthorized? })` | typed `fetch` client implementing `ApiClient`. `headers` is an object or a function called per request (the web UI echoes its CSRF cookie); `onUnauthorized` runs on every 401 |
| `Access`, `Me`, `AuthConfig`, `LoginLink`, `ApiToken`, `CreatedApiToken` | sign-in: who is signed in and with what access (`viewer` < `member` < `admin`), what the login page offers, sign-in links and API tokens |
| `ApiRequestError`, `ApiErrorCode`, `ERROR_STATUS` | error body `{ error: { code, message, details? } }` and status mapping |
| `LiveChannel`, `channels.*` | WebSocket channels: `now`, `events`, `session:<id>`, `run:<id>`, `chat:<channelId>`, `records:<kind>`, `person:<contactId>` (yours only: topics `inbox.item` and `inbox.read`) |
| `LiveTopics`, `LiveEvent`, `LiveClientMessage`, `LiveServerMessage` | the `/ws` protocol: client sends `subscribe` / `unsubscribe` / `ping`; server sends `{ type: 'event', channel, topic, payload, at }` |
| `channelsFor(topic, payload)` | which channels a bus event fans out to (used by the server and the web mock) |
| `createLiveClient({ url, WebSocket?, … })` | `LiveSource` over a WebSocket: ref-counted subscriptions, reconnect with backoff, resubscribe on reconnect, ping |

## Endpoints (summary; details on `ApiClient`)

- Records: `GET /api/kinds`, `GET|POST /api/records/:kind`, `GET|PATCH|DELETE /api/records/:kind/:id`, `…/links`, `…/revisions`, `…/backlinks`, `DELETE /api/links/:id`
- Sessions and runs: `GET /api/sessions`, `GET /api/sessions/:id` (+ `/history`, `/tree`, `/entry-tree`, `/runs`), `POST /api/sessions/:id/fork`, `POST /api/sessions/:id/message`, `GET /api/entries/:id/children`, `GET /api/runs/:id` (+ `/history`), `POST /api/runs/:id/pause|resume|cancel`, `GET /api/lineage/:id`
- Activity: `GET /api/now`, `GET /api/inbox` (`InboxItem`: `mention`, `reply`, `dm`, `alert`, `paused_run`, `waiting`, `limit`, …, with `author` and `channel` for chat items), `POST /api/inbox/read`
- Notifications (`src/notifications.ts`, `NOTIFICATION_ROUTES`): `GET|PUT /api/me/notifications` (`NotificationPrefs { toasts, desktop, sound, hideDmText, mutedChannels }`, `DEFAULT_NOTIFICATION_PREFS`; `PUT` takes the fields to change); new items live on `person:<contactId>`
- Events: `GET|POST /api/events`, `GET /api/events/:id`, `GET /api/triggers`, `GET /api/subscriptions`
- Chat: `GET|POST /api/chat/channels`, `GET|POST /api/chat/channels/:id/messages`, `POST /api/chat/channels/:id/members`, `GET /api/chat/threads/:id`
- Everyday chat: `PATCH|DELETE /api/chat/messages/:id` (author only, 403 otherwise), `POST|DELETE /api/chat/messages/:id/reactions` (`{ emoji }` / `?emoji=`), `POST /api/chat/read` (`{ scope, messageId? }`), `GET /api/chat/unread`, `POST /api/chat/dms` (`{ members }`, you're added), `GET /api/chat/search?text=&channelId=&author=&tagged=&threadId=`
- `GET /api/me`: who is signed in (`contactId`, `name`, `access`, `email?`, `via`: `session` or `token`, and `deployment`: `DeploymentNetwork { defaultNetwork, directNetwork }`, what an employee with no network setting gets and whether direct networks are on); 401 when nobody is
- Sign-in and tokens: `GET /api/auth/config` (public), `POST /api/auth/logout`, `GET|POST /api/auth/tokens`, `DELETE /api/auth/tokens/:id`, `POST /api/auth/links` (admins)
- Usage: `GET /api/usage/totals|breakdown|series`
- Limits and pricing (`src/limits.ts`, `LIMIT_ROUTES`, admins only, reading included): `GET /api/limits` (`LimitsOverview`: the defaults, the overrides, `scopes` with the effective caps and budgets of every employee, each employee and each requester with an override, and budget usage; `unpricedModels`), `POST /api/limits` (`LimitData`: `target { type: global|employee|contact|…, id? }`, caps, `maxTokens`/`maxCostUsd` with a `period`; `null` lifts a default), `PUT|DELETE /api/limits/:id`, `GET|PUT /api/pricing` (`PricingInfo`: `custom`, `env`, `builtin` tables and the models in use; `PUT { pricing }` replaces the custom prices)
- Files: `GET /api/files/:employeeId`, `GET|PUT /api/files/:employeeId/content`. `FileContent` carries `encoding` (`utf8`, or `base64` for binary files) and `size`. `writeFile(employeeId, path, content, version?, { encoding? })` uploads binary files as base64; version `0` writes only if the file doesn't exist yet (409 otherwise), and a file over `FILE_WRITE_MAX_BYTES` (10 MB, after decoding) is 413
- Secrets: `GET|PUT|DELETE /api/secrets` (names and scopes only; values are write-only)
- Live previews: `GET /api/sessions/:id/preview` (`SessionPreview`: ports, status, running commit), `POST /api/previews/token` (`{ envId, port }` → `PreviewToken`, members); live topic `preview.commit` on `session:<id>`
- Employees and guided setup (`src/setup.ts`, `SETUP_ROUTES`): `POST /api/employees` (`CreateEmployeeBody` → `CreatedEmployee`, admins; 409 for a taken handle), `GET|POST /api/employees/:id/ssh-key` (`SshKeyInfo`: public key, `SHA256:` fingerprint, created; POST rotates, admins), `GET /api/employees/:id/integrations?refresh=` (`EmployeeIntegrations`: per integration its state and steps `{ id, title, status: done|todo|warning|error, detail?, data? }`), `POST /api/employees/:id/integrations/:name/secrets` (`{ values }`, validated then stored scoped to the employee) and `…/actions/:action` (an optional JSON body as the action's input, e.g. GitLab's `add-projects` takes `{ projects: [GitLab project ids] }`; → `SetupResult`, admins), `GET /api/employees/:id/integrations/slack/manifest` (admins), `GET /api/employees/:id/integrations/gitlab/projects?search=&page=&perPage=` (`GitlabProjectsPage`: rows with access, role, `added`, and GitLab's paging as `nextPage` and `total`, admins) and `…/gitlab/projects/:projectId/protection` (`GitlabBranchProtection`, admins), `GET /api/integrations/status` (`IntegrationsOverview`, admins)
- Projects and who works on them (`src/projects.ts`, `PROJECT_ROUTES`): `POST /api/projects` (`CreateProjectBody`: name, description, repositories, docs links, an `owner` and `members` as `{ contactId }` or `{ employeeId }`, linked in one step → `CreatedProject`; 409 for a taken name or repository), `GET|POST /api/projects/:id/people` (`ProjectPeople`, owners first; POST `{ contactId | employeeId, role }`, `owner` replaces the owner), `DELETE /api/projects/:id/people/:contactId?role=`, `GET /api/employees/:id/projects` (`EmployeeProjects`: its projects, roles and each owner). Writes for members and admins. Local projects (repositories the harness hosts, docs/spec.md#local-projects): `POST /api/projects/local` (`CreateLocalProjectBody` → `CreatedProject`, admins), `GET /api/projects/:id/local` (`LocalProject`: slug, url, default branch, `LocalBranchInfo`s ahead/behind, `canMerge`, `canAttachRemote`), `GET …/local/compare?branch=` (`LocalComparison`: commits, files, diff, `fastForward`), `POST …/local/merge` (`{ branch }` → `LocalMergeResult`; 409 with `details.files` on conflicts; admins, owners, backups, reviewers), `POST …/local/branches/delete` (`{ branch }` → `LocalProject`), `GET …/local/tree?path=&ref=` (`LocalTree`), `GET …/local/file?path=&ref=` (`LocalFile`), `POST …/local/remote` (`AttachRemoteBody` → `AttachedRemote`, admins)
- Procedures (`src/procedures.ts`, `PROCEDURE_ROUTES`): `GET /api/procedures?text=&ownerId=&archived=` (`ProcedureListItem[]`: how each starts, owner, approvals, runs in 30 days, last run, context state), `GET /api/procedures/:id` (`ProcedureDetail`: triggers in plain words, approvers, runs, context), `POST /api/procedures` (`CreateProcedureBody` with `starts: ProcedureStart[]` and an `idempotencyKey` → `CreatedProcedure`; the procedure, its triggers and its context in one call; a catch-all start is 422 with `CATCH_ALL_START_MESSAGE`), `POST /api/procedures/:id/run` (`{ work?, employeeId?, idempotencyKey? }` → `ProcedureRunStarted`), `POST …/context/rebuild`, `POST …/archive` (`{ archived }`), `POST /api/procedures/:id/triggers`, `PATCH|DELETE …/triggers/:triggerId` (admins). `describeStart(start)` and `describeCron(cron)` put a start in words; `INTEGRATION_EVENTS` lists the integrations' events for pickers. Writes for members, triggers for admins
- Memory, skills and people (`src/knowledge.ts`, `KNOWLEDGE_ROUTES`): `GET /api/memories?text=&employeeId=&kind=&about=&taughtBy=&sessionId=&mine=&sort=` (`MemoryPage`: `MemoryItem`s with what each is about, the employee, source, last use, whether it's personal and changeable, plus `facets` for the filters), `GET|PATCH|DELETE /api/memories/:id` (`MemoryDetail` with its history; PATCH with `note` is a correction), `POST /api/memories` (`CreateMemoryBody` → `CreatedMemory`), `POST /api/memories/:id/verify`; `GET|POST /api/skills`, `GET|PATCH|DELETE /api/skills/:id` (`SkillListItem`/`SkillDetail`: project, what it overrides, who used it in 30 days, versions, procedures naming it), `POST /api/skills/:id/restore` (`{ version }`); `GET|POST /api/people`, `GET|PATCH /api/people/:id` (`PersonItem`/`PersonDetail`: type, access, deactivated, last sign-in, projects, manager, reports, memories count, tokens), `POST /api/people/:id/sign-in-link` (`SignInLinkResult`: the link, and whether it went out as a Slack DM), `…/deactivate`, `…/reactivate`. `parseSkillMarkdown` / `skillMarkdown` read and write a `SKILL.md`; `SKILL_TEMPLATE` is a new skill's body. Who sees what is in the file's header comment
- Identity from integrations (`src/identity.ts`, `IDENTITY_ROUTES`, admins only, reading included): `GET /api/identity/unlinked?status=&system=&limit=` (`{ items: IdentityLinkView[] }`: Slack, GitLab and Linear users the harness couldn't link by itself, with name, email, status, last seen and the suggested contact; default status `unknown,suggested`, `all` for every one), `POST /api/identity/link` (`LinkIdentityInput { system, id, contactId }` → the user, linked; 409 when the handle is on another contact), `POST /api/identity/ignore` (`IgnoreIdentityInput { system, id, ignored? }`)
- Chat attachments (`src/attachments.ts`, `ATTACHMENT_ROUTES`): `POST /api/chat/attachments?name=` (any file as the raw body → `UploadedAttachment`; `uploadAttachment(file, { name?, onProgress?, signal? })` uses `XMLHttpRequest` for upload progress in browsers), `GET /api/chat/attachments/:id` (`attachmentUrl(id, { download? })` for `<img src>`); `postMessage` takes `attachments: [id…]`, and `MessageData.attachments` lists `ChatAttachment { id, kind?, name, mime, size, width?, height?, description?, visibleText?, descriptionEditedBy? }` (`isImageAttachment`, `hasTextPreview`, `IMAGE_ATTACHMENT_MIMES`, `TEXT_PREVIEW_MAX_BYTES`); `attachmentText(id)` (`GET /api/chat/attachments/:id/text` → `AttachmentText { attachment, text, truncated }`, at most 256 KB, for plain-text previews); image descriptions: `attachmentDescription(id)` (`GET /api/chat/attachments/:id/description`), `describeAttachment(id)` (`POST …/describe`) and `updateAttachment(id, { description })` (`PATCH /api/chat/attachments/:id`), each → `AttachmentDescription`
- Chat activity (`src/chat-activity.ts`, `CHAT_ACTIVITY_ROUTES`): `GET /api/chat/channels/:id/activity` →
  `ChatActivityItem[]` (who is working on the channel's threads: thread, message, session and its label, employee,
  run, `state` queued|running|waiting|paused, `since`, `step`, `pauseReason`, `waitingOn`); live on `chat:<channelId>`
  as `chat.activity { channelId, item }` and `chat.activity.done` (`ChatActivityDone`: `outcome` replied,
  handed_off with `handedTo`, no_reply, failed with `reason`, or unrouted)
- Chat authors: `MessageData.author` has the employee's `handle` for employee authors; a router context's messages come as the employee (`type: 'employee'`), never as `@employee#router`
- Control and health: `GET /api/control`, `POST /api/control/pause-all|resume-all`, `GET /healthz`, `GET /readyz`

Additions beyond the original brief, needed by the UI: `GET /api/sessions/:id/entry-tree`,
`GET /api/usage/series`, `GET /api/inbox`, `GET /api/control`, `POST /api/records/:kind/:id/links`,
`DELETE /api/links/:id`.

Every route but `health`, `ready` and `authConfig` needs a signed-in person: the web UI's
`mp_session` cookie (unsafe methods also send `x-mp-csrf` with the `mp_csrf` cookie's value), or
`Authorization: Bearer <api token>` for scripts and agents. The same token works on `/ws` (as a header,
or the cookie in a browser) and on `/mcp`. What each access may do is listed in the server's README.

## Tests

`npx vitest run --project node packages/api`: the client against a fake `fetch`
(paths, query encoding, bodies, 204, error mapping, network failures) and the live
client against a fake WebSocket with injected timers (subscribe ref-counting,
queued subscriptions, backoff and cap, resubscribe, stale sockets, ping, close),
plus `channelsFor` routing.

## Replacing it

Change the types here and both sides stop compiling where they disagree. A new
transport (e.g. SSE instead of WebSocket) only needs another `LiveSource`.
