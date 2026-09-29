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
| `LiveChannel`, `channels.*` | WebSocket channels: `now`, `events`, `session:<id>`, `run:<id>`, `chat:<channelId>`, `records:<kind>` |
| `LiveTopics`, `LiveEvent`, `LiveClientMessage`, `LiveServerMessage` | the `/ws` protocol: client sends `subscribe` / `unsubscribe` / `ping`; server sends `{ type: 'event', channel, topic, payload, at }` |
| `channelsFor(topic, payload)` | which channels a bus event fans out to (used by the server and the web mock) |
| `createLiveClient({ url, WebSocket?, … })` | `LiveSource` over a WebSocket: ref-counted subscriptions, reconnect with backoff, resubscribe on reconnect, ping |

## Endpoints (summary; details on `ApiClient`)

- Records: `GET /api/kinds`, `GET|POST /api/records/:kind`, `GET|PATCH|DELETE /api/records/:kind/:id`, `…/links`, `…/revisions`, `…/backlinks`, `DELETE /api/links/:id`
- Sessions and runs: `GET /api/sessions`, `GET /api/sessions/:id` (+ `/history`, `/tree`, `/entry-tree`, `/runs`), `POST /api/sessions/:id/fork`, `POST /api/sessions/:id/message`, `GET /api/entries/:id/children`, `GET /api/runs/:id` (+ `/history`), `POST /api/runs/:id/pause|resume|cancel`, `GET /api/lineage/:id`
- Activity: `GET /api/now`, `GET /api/inbox`
- Events: `GET|POST /api/events`, `GET /api/events/:id`, `GET /api/triggers`, `GET /api/subscriptions`
- Chat: `GET|POST /api/chat/channels`, `GET|POST /api/chat/channels/:id/messages`, `POST /api/chat/channels/:id/members`, `GET /api/chat/threads/:id`
- Everyday chat: `PATCH|DELETE /api/chat/messages/:id` (author only, 403 otherwise), `POST|DELETE /api/chat/messages/:id/reactions` (`{ emoji }` / `?emoji=`), `POST /api/chat/read` (`{ scope, messageId? }`), `GET /api/chat/unread`, `POST /api/chat/dms` (`{ members }`, you're added), `GET /api/chat/search?text=&channelId=&author=&tagged=&threadId=`
- `GET /api/me`: who is signed in (`contactId`, `name`, `access`, `email?`, `via`: `session` or `token`); 401 when nobody is
- Sign-in and tokens: `GET /api/auth/config` (public), `POST /api/auth/logout`, `GET|POST /api/auth/tokens`, `DELETE /api/auth/tokens/:id`, `POST /api/auth/links` (admins)
- Usage: `GET /api/usage/totals|breakdown|series`
- Files: `GET /api/files/:employeeId`, `GET|PUT /api/files/:employeeId/content`
- Secrets: `GET|PUT|DELETE /api/secrets` (names and scopes only; values are write-only)
- Live previews: `GET /api/sessions/:id/preview` (`SessionPreview`: ports, status, running commit), `POST /api/previews/token` (`{ envId, port }` → `PreviewToken`, members); live topic `preview.commit` on `session:<id>`
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
