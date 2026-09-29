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
- `GET /api/me`: who is signed in (`contactId`, `name`, `access`, `email?`, `via`: `session` or `token`); 401 when nobody is
- Sign-in and tokens: `GET /api/auth/config` (public), `POST /api/auth/logout`, `GET|POST /api/auth/tokens`, `DELETE /api/auth/tokens/:id`, `POST /api/auth/links` (admins)
- Usage: `GET /api/usage/totals|breakdown|series`
- Files: `GET /api/files/:employeeId`, `GET|PUT /api/files/:employeeId/content`
- Secrets: `GET|PUT|DELETE /api/secrets` (names and scopes only; values are write-only)
- Live previews: `GET /api/sessions/:id/preview` (`SessionPreview`: ports, status, running commit), `POST /api/previews/token` (`{ envId, port }` → `PreviewToken`, members); live topic `preview.commit` on `session:<id>`
- Employees and guided setup (`src/setup.ts`, `SETUP_ROUTES`): `POST /api/employees` (`CreateEmployeeBody` → `CreatedEmployee`, admins; 409 for a taken handle), `GET|POST /api/employees/:id/ssh-key` (`SshKeyInfo`: public key, `SHA256:` fingerprint, created; POST rotates, admins), `GET /api/employees/:id/integrations?refresh=` (`EmployeeIntegrations`: per integration its state and steps `{ id, title, status: done|todo|warning|error, detail?, data? }`), `POST /api/employees/:id/integrations/:name/secrets` (`{ values }`, validated then stored scoped to the employee) and `…/actions/:action` (an optional JSON body as the action's input, e.g. GitLab's `add-projects` takes `{ projects: [GitLab project ids] }`; → `SetupResult`, admins), `GET /api/employees/:id/integrations/slack/manifest` (admins), `GET /api/integrations/status` (`IntegrationsOverview`, admins)
- Projects and who works on them (`src/projects.ts`, `PROJECT_ROUTES`): `POST /api/projects` (`CreateProjectBody`: name, description, repositories, docs links, an `owner` and `members` as `{ contactId }` or `{ employeeId }`, linked in one step → `CreatedProject`; 409 for a taken name or repository), `GET|POST /api/projects/:id/people` (`ProjectPeople`, owners first; POST `{ contactId | employeeId, role }`, `owner` replaces the owner), `DELETE /api/projects/:id/people/:contactId?role=`, `GET /api/employees/:id/projects` (`EmployeeProjects`: its projects, roles and each owner). Writes for members and admins
- Procedures (`src/procedures.ts`, `PROCEDURE_ROUTES`): `GET /api/procedures?text=&ownerId=&archived=` (`ProcedureListItem[]`: how each starts, owner, approvals, runs in 30 days, last run, context state), `GET /api/procedures/:id` (`ProcedureDetail`: triggers in plain words, approvers, runs, context), `POST /api/procedures` (`CreateProcedureBody` with `starts: ProcedureStart[]` and an `idempotencyKey` → `CreatedProcedure`; the procedure, its triggers and its context in one call; a catch-all start is 422 with `CATCH_ALL_START_MESSAGE`), `POST /api/procedures/:id/run` (`{ work?, employeeId?, idempotencyKey? }` → `ProcedureRunStarted`), `POST …/context/rebuild`, `POST …/archive` (`{ archived }`), `POST /api/procedures/:id/triggers`, `PATCH|DELETE …/triggers/:triggerId` (admins). `describeStart(start)` and `describeCron(cron)` put a start in words; `INTEGRATION_EVENTS` lists the integrations' events for pickers. Writes for members, triggers for admins
- Chat attachments (`src/attachments.ts`, `ATTACHMENT_ROUTES`): `POST /api/chat/attachments?name=` (the image as the raw body → `UploadedAttachment`; `uploadAttachment(file, { name?, onProgress?, signal? })` uses `XMLHttpRequest` for upload progress in browsers), `GET /api/chat/attachments/:id` (`attachmentUrl(id, { download? })` for `<img src>`); `postMessage` takes `attachments: [id…]`, and `MessageData.attachments` lists `ChatAttachment { id, name, mime, size, width?, height?, description?, visibleText?, descriptionEditedBy? }`; image descriptions: `attachmentDescription(id)` (`GET /api/chat/attachments/:id/description`), `describeAttachment(id)` (`POST …/describe`) and `updateAttachment(id, { description })` (`PATCH /api/chat/attachments/:id`), each → `AttachmentDescription`
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
