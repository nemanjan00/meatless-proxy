# @mp/integration-slack

The first-party Slack integration ([spec](../../docs/spec.md#integrations)). It has three parts:

- An MCP server with Slack tools. They act as the app's bot, over the Slack Web API.
- Events API webhooks, which it turns into events, and interactivity (answers to [questions with
  inputs](#questions-with-inputs)).
- User lookup, for matching Slack users to contacts, and file downloads for the harness.

It implements `Integration` from `@mp/mcp`. The server (`packages/server/src/integrations`) builds one instance per
employee from that employee's secrets, connects its MCP server in-process, and mounts the webhooks at
`/webhooks/slack/<employee>` and `/webhooks/slack`.

## API

`createSlackIntegration({ secrets: { botToken, signingSecret }, fetch?, baseUrl?, clock?, logger?, retry?, sleep?, channelNameTtlMs?, interactions? })`
returns a `SlackIntegration` (an `Integration` named `slack`):

- `createMcpServer()`: a fresh SDK `McpServer` with the [tools](#tools). The tools are `mcp.slack.<tool>`.
- `handleWebhook(req)`: verifies the signature and returns `{ status, body?, headers?, events, after? }`. See
  [events](#events-in) and [interactivity](#interactivity-in).
- `downloadFile(fileId, { maxBytes?, signal? })`: `files.info`, then the file's `url_private_download` with the bot
  token. Returns `{ id, name, mime?, size, bytes, … }`. See [files](#files).
- `resolveUser(userId)`: calls `users.info` and returns `{ handle: { system: 'slack', id }, email?, name?, displayName?,
  bot? }`. The name is the user's `real_name`, `displayName` the profile's display name when it differs, and `bot` is
  set for bot users and Slackbot. An unknown user returns `null`. Any other failure throws. The server uses it to link
  Slack users to contacts, or create them (packages/server, "Identity from integrations").

The package also exports these building blocks:

- `createSlackClient({ token, baseUrl?, fetch?, clock?, logger?, retry?, sleep? })`. Its one method is
  `call(method, params, { write?, json? })`.
- `verifySlackSignature(...)` and `signSlackRequest(secret, ts, body)`.
- `mapSlackEvent(envelope, ctx)`.
- `createSlackMcpServer(client, logger)`.
- `parseRetryAfter`, `slackErrorCode`, `compactMessage` and `compactUser`.
- Questions (`src/blocks.ts`): `validateAsk`, `buildAskBlocks`, `readAnswer`, `answeredMessage`, `parseBlocks`, and the
  limits (`MAX_FIELDS`, …).
- Interactions (`src/interactions.ts`): the `SlackInteractionStore` port, `memoryInteractionStore()`, and
  `handleBlockActions(payload, deps)`.
- Files (`src/files.ts`): `fileInfo`, `downloadSlackFile`, `isSlackHost`, `SLACK_FILE_MAX_BYTES`.

### Web API client

- Every method is sent as a `POST` to `{baseUrl}/{method}`. The default `baseUrl` is `https://slack.com/api`.
- Write methods send a JSON body. Everything else sends a form body.
- The token goes only in the `Authorization: Bearer` header. It is redacted from error messages and never logged.
- `ok: false` throws `MpError('integration_request')` with `details.error` (Slack's code, e.g. `channel_not_found`),
  `details.status` and `details.method`. Other 4xx responses and non-JSON replies throw the same error.
- **Rate limits**: a `429` or the `ratelimited` error waits out `Retry-After` (seconds or an HTTP date), then retries. This
  applies to writes too, because Slack didn't execute a rate-limited call. If the wait is longer than `retry.maxDelayMs`
  (default 30 s), or no attempts are left (`retry.attempts`, default 3), the call throws `UnavailableError`.
- **5xx and network errors** are retried with exponential backoff (`retry.baseDelayMs`, default 500 ms), but only on
  reads. A write fails at once with `UnavailableError`, because it may already have been executed. The harness journal
  decides what happens next, so a message is never posted twice.

## Tools

Results are compact JSON. Failures are `isError` results of the form `{ error, message, hint?, slack_messages?, retryable? }`,
where `error` is Slack's code, `hint` says what to do about it (e.g. `not_in_channel` → invite the app), and
`slack_messages` is Slack's own explanation when it gives one (`response_metadata.messages` and `errors`, at most 10
lines): for `invalid_blocks`, which block failed and why (`[ERROR] … [json-pointer:/blocks/1/text]`).

| Tool | Slack method | Arguments | Result |
|------|--------------|-----------|--------|
| `post_message` | `chat.postMessage` (mrkdwn) | `channel`, `text`, `thread_ts?` | `{ channel, ts, thread_ts? }` |
| `reply` | `chat.postMessage` | `channel`, `thread_ts`, `text` | `{ channel, ts, thread_ts }` |
| `read_channel` | `conversations.history` | `channel`, `limit?` (20, max 200), `cursor?`, `oldest?`, `latest?` | `{ messages, next_cursor }`, newest first |
| `read_thread` | `conversations.replies` | `channel`, `thread_ts`, `limit?` (50, max 200), `cursor?` | `{ messages, next_cursor }`, root first |
| `react` | `reactions.add` | `channel`, `ts`, `name` (colons optional) | `{ ok }`; `already_reacted` → `{ ok, already }` |
| `unreact` | `reactions.remove` | `channel`, `ts`, `name` | `{ ok }`; `no_reaction` → `{ ok, already }` |
| `lookup_user` | `users.info` / `users.lookupByEmail` | exactly one of `user` or `email` | `{ id, name, real_name, display_name, email, title, tz, is_bot?, deleted? }` |
| `open_dm` | `conversations.open` | `user` or `users` (up to 8, for a group DM) | `{ channel }` |
| `list_channels` | `conversations.list` (public and private, not archived) | `member_only?` (default true), `limit?` (200), `cursor?` | `{ channels: [{ id, name, is_private?, is_member, topic?, purpose?, members? }], next_cursor }` |
| `update_message` | `chat.update` | `channel`, `ts`, `text` | `{ channel, ts }`. The app can only edit its own messages (`cant_update_message`). |
| `ask` | `chat.postMessage` with blocks | `channel`, `thread_ts?`, `text`, `fields`, `buttons?`, `allow_multiple?` | `{ channel, ts, thread_ts?, ask }`; in the harness `{ channel, ts, thread_ts?, interactionId, subject }`. See [questions with inputs](#questions-with-inputs). |
| `post_blocks` | `chat.postMessage` with blocks | `channel`, `thread_ts?`, `text` (the fallback), `blocks` (a JSON array of 1-50 blocks, or its JSON text) | `{ channel, ts, thread_ts? }`. Slack's `invalid_blocks` comes with a hint. |
| `get_file` | `files.info` | `file_id` | Outside the harness, the file's metadata `{ id, name, mime, filetype, size, title, mode }`. In the harness, the server downloads it into the employee's files: `{ path, name, mime, size, text? }`. See [files](#files). |
| `upload_file` | `files.getUploadURLExternal`, the upload, `files.completeUploadExternal` | `path`, `channel`, `thread_ts?`, `title?`, `comment?` | In the harness, the server reads `path` from the employee's files and uploads it: `{ fileId, channel, thread_ts?, permalink? }`. Outside the harness it refuses (`not_supported`): the plain MCP server has no files to read. See [files](#files). |

A message looks like `{ ts, user?, bot_id?, subtype?, text, thread_ts?, reply_count?, reactions?: [{ name, count }], files?: [{ id, name }], edited? }`.

### Questions with inputs

`ask` posts a question as Block Kit
([input block](https://docs.slack.dev/reference/block-kit/blocks/input-block/),
[actions block](https://docs.slack.dev/reference/block-kit/blocks/actions-block/)): a section with `text`, one input
block per field (`dispatch_action: false`, so typing sends nothing), and an actions block with the buttons.

| Field `type` | Element | Answer value |
|--------------|---------|--------------|
| `text` | `plain_text_input` | string, or null |
| `multiline` | `plain_text_input` with `multiline` | string, or null |
| `select` | `static_select` (up to 100 options) | the option's value, or null |
| `multiselect` | `multi_static_select` (up to 100 options) | option values (`[]` when none) |
| `checkboxes` | `checkboxes` (up to 10 options) | option values (`[]` when none) |
| `radio` | `radio_buttons` (up to 10 options) | the option's value, or null |
| `date` | `datepicker` | `YYYY-MM-DD`, or null |
| `number` | `number_input` (decimals allowed) | a number, or null |

A field is `{ id, label, type, options?: [{ value, label }], optional?, placeholder?, initial? }`. Buttons are
`[{ id, label, style?: 'primary' | 'danger' }]`, by default one "Submit". The limits are Slack's, checked before
posting: text up to 3000 characters, at most 48 fields (a message has 50 blocks), labels up to 2000, placeholders up to
150, option labels up to 75 and values up to 150, unique ids (`[A-Za-z0-9_-]`, up to 64), at most 25 buttons with labels up
to 75. `initial` must fit the type (an option value, a list of them, `YYYY-MM-DD`, a number). Every problem is listed in
one `validation` error.

Block ids are `mp_field:<field id>` and `mp_actions`; action ids are the field id and `mp_button:<button id>`.

With `member_only`, `list_channels` filters the page client-side, so a page may come back short or even empty while
`next_cursor` is still set.

## Events in

`POST /webhooks/slack/<employee>` (one Slack app per employee) or `POST /webhooks/slack` (a deployment-wide app)
receives the Events API.

1. **Signature**: the request must have an `X-Slack-Signature` header of the form `v0=` + hex HMAC-SHA256 of
   `v0:<X-Slack-Request-Timestamp>:<raw body>`, keyed with the signing secret. The signature is compared in constant time.
   The timestamp must be within 5 minutes of now, in either direction. Otherwise the response is `401` with no events.
   A request that isn't a POST gets `405`. A body that isn't a JSON envelope gets `400`.
2. `url_verification` is answered with its `challenge`, as `text/plain`. It is signed too, and verified first.
3. `event_callback` is mapped to at most one event. Everything else (`app_rate_limited`, unknown types) returns `200` with
   no events. Unmapped callbacks also return `200`, so Slack doesn't retry them.

Every event has:

- `source: 'integration:slack'`.
- `dedupeKey: 'slack:<event_id>'`. Slack's retries (`X-Slack-Retry-Num`) carry the same `event_id`, so they dedupe.
- `subject: { system: 'slack', id: '<channel>/<thread ts, or the message ts>' }`.
- `actor: { system: 'slack', id: <user id> }`, when a user caused the event.
- `text` like `Slack #general U123: hello`, clipped to 1000 characters. The full text is in the payload.

The channel name comes from a cached `conversations.info` (1 hour; failures are remembered for 1 minute, and the id is
shown instead). Lookups on the webhook path don't retry, because Slack wants an answer within 3 seconds.

| Slack event | Event type | Subject ts | Payload |
|-------------|------------|------------|---------|
| `message` in a channel, top level (or `thread_ts == ts`), not mentioning the app | `message.posted` | `ts` | `team_id, channel, channel_type, channel_name?, user, bot_id?, subtype?, text, ts, thread_ts?, is_reply, mentions_app, files?` |
| `message` with `thread_ts != ts` | `message.replied` | `thread_ts` | same |
| `message` with `channel_type: im` (a DM to the app, threaded or not) | `message.direct` | `thread_ts` or `ts` | same, without `channel_name` |
| `message` / `message_changed` | `message.edited` | the edited message's thread | `channel, user, ts, thread_ts?, text, previous_text` |
| `message` / `message_deleted` | `message.deleted` | the deleted message's thread | `channel, user?, ts, thread_ts?, previous_text?` |
| `app_mention`, or a `message` mentioning the app | `message.mentioned` | `thread_ts` or `ts` | `channel, user, text, ts, thread_ts?, is_reply, mentions_app` |
| `reaction_added` on a message | `reaction.added` | the reacted message's `ts` | `channel, user, reaction, ts, item_user, item_is_own` |

Some events are ignored:

- **The app's own activity**: messages whose `user` is the bot user (taken from the envelope's `authorizations`, or from
  `auth.test`, looked up once), whose `bot_id` is the app's bot, or whose `app_id` / `bot_profile.app_id` is the
  envelope's `api_app_id`. The same goes for edits and deletions of such messages, and for the bot's own reactions.
- **Subtypes other than** `thread_broadcast`, `file_share`, `me_message` and `bot_message`: for example `channel_join` and
  `channel_topic`.
- **`message_changed` with unchanged text**, which is what link unfurls send.
- **Reactions to files.**

Other bots' messages come through as `message.posted` with `bot_id` and no actor.

Notes:

- Slack delivers a mention in a channel twice (a `message` and an `app_mention` event, with different `event_id`s).
  Both become one `message.mentioned` event with `mentions_app: true` (dedupe key `slack:msg:<channel>:<ts>`, whichever
  arrives first), so a mention is handled once. A `message` that mentions the app is `message.mentioned` too, not
  `message.posted` or `message.replied`.
- `reaction.added` uses the reacted message's own `ts`. For a reply in a thread, that isn't the thread root, because the
  event doesn't say which thread the message is in.

## Interactivity in

Slack sends button presses to the app's **Interactivity Request URL**, `POST /webhooks/slack/<employee>/interactive`
(the Events URL takes them too: the body tells them apart). They are form-encoded, `payload=<json>`, and signed with the
same signing secret ([handling user interaction](https://docs.slack.dev/interactivity/handling-user-interaction/)).

1. The signature and timestamp are checked as for events: `401` otherwise. A body without a JSON `payload` is `400`.
2. The answer is an empty `200` at once (Slack wants one within 3 seconds). A `block_actions` payload is handled after,
   through `after()`, when an `interactions` store is set. Other payload types are acknowledged and ignored.
3. A press of one of our buttons on a message in the store
   ([block_actions](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/)):
   - `state.values` are read into `{ fieldId: value }` (the table above). Slack doesn't enforce required inputs in
     messages, so when one is empty the person gets an ephemeral note (`chat.postEphemeral`) and nothing is recorded.
   - The store records the answer. The first one wins (atomically, also when two arrive at once), unless the question
     has `allowMultiple`. A later press gets an ephemeral "answered already".
   - `chat.update` replaces the message with the question, the answers read-only (option labels, mrkdwn-escaped) and
     "Answered by <@U…>" ([chat.update](https://docs.slack.dev/reference/methods/chat.update/)). With `allowMultiple`, the
     form stays and each person gets an ephemeral thanks.
   - One event is returned (below).
4. Presses on messages the store doesn't know, on other buttons, and on ephemeral messages return no events.

| Event type | Subject | Payload |
|------------|---------|---------|
| `interaction.answered` | `slack:<channel>/<thread ts, or the question's ts>` | `interactionId, channel, channel_name?, ts, thread_ts?, values, button, button_label, answeredBy, answeredAt, tags?` |

Its `actor` is the Slack user, its dedupe key `slack:interaction:<id>` (with `allowMultiple`, one per person and press),
and its text lists the answers:

```
Slack #general U123 answered your question (interaction itr_…):
Question: Which environment?
- Environment: Production [prod]
- Note: ship it
```

`tags` names the asking session (`{ type: 'session', sessionId }`), so the router delivers the answer to it, expected to
act. The harness implements `SlackInteractionStore` over `interaction` records (packages/server,
`src/integrations/interactions.ts`), creates them after `ask`, and notes who answered as a contact.

## Files

Slack events list a message's files in the payload (`files: [{ id, name }]`) and in the text, as
`[file: name, slack file F…]`, so the model knows to call `get_file`.

`downloadFile` (and so `get_file` in the harness) reads `files.info` and downloads `url_private_download` with the bot
token (bot scope `files:read`):

- Only Slack's own hosts are contacted: `slack.com`, `slack-edge.com` and `slack-files.com` and their subdomains, over
  https, also for every redirect (at most 5). The token goes nowhere else. A configured `baseUrl` other than Slack's is
  allowed too (tests).
- At most 25 MB: a larger `size` in `files.info` fails before the download, and a body that grows past it is cut off
  (`LimitError`).
- External files (Google Drive and the like) and deleted ones can't be downloaded. Without `files:read`, Slack answers the
  download with its sign-in page; that's reported as the missing scope.

In the harness, the file is written to the employee's files at `/slack/<file id>-<safe name>` with its sniffed type, and
the model gets `{ path, name, mime, size }`, plus the text for text files up to 64 KB. Images then work with
`image.view { path }`, everything with `fs.read`, and `code.run` sees `/work/files/slack/…`.

### Sharing a file into Slack

`uploadFile` (and so `upload_file` in the harness) uses Slack's external upload flow, since `files.upload` is being
retired (bot scope `files:write`):

1. [`files.getUploadURLExternal`](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/)
   `{ filename, length }` returns an `upload_url` and a `file_id`.
2. The bytes are POSTed to `upload_url`, only over https to Slack's own hosts (the same check as downloads; a configured
   `baseUrl` other than Slack's is allowed too, for tests). Redirects aren't followed.
3. [`files.completeUploadExternal`](https://docs.slack.dev/reference/methods/files.completeUploadExternal/)
   `{ files: [{ id, title }], channel_id, thread_ts?, initial_comment? }` shares it in the channel or thread.

At most 25 MB, and not empty, checked before anything is sent (`LimitError`, `ValidationError`). Without `files:write`
Slack answers `missing_scope`, reported as "add files:write and reinstall the app" (`DeniedError`).

In the harness, `path` is a path in the employee's files, spelled as everywhere else: `/report.png`,
`/work/files/report.png` (as `code.run` sees it), or `/shared/<owner>/…` for a file shared with the employee, which
needs a read grant (the same rules as chat attachments). The bytes never pass through the model. An `upload_file`
counts as an answer in Slack, so the run's final text isn't also posted.

The `upload_file` tool on the plain MCP server (outside the harness) refuses with `not_supported`: it has no files to
read, and the bytes aren't taken as a tool argument so that they never go through a model.

## Setup

**Use the guided setup on the employee's page** (`/employees/<id>` → Integrations → Slack). It generates this
employee's manifest with a one-click "Create Slack app" link, stores the tokens after checking them with `auth.test`,
shows when signed events arrive and which channels the bot is in, and adds the recommended trigger. Every step is
checked by the server (`packages/server/src/setup/slack.ts`). The steps below are the manual fallback.

Each employee is its **own Slack bot**: one Slack app per employee, with its own name, bot token and signing secret, so
people see who they're talking to and every message is posted as the employee that wrote it. Repeat these steps for
every employee that should be on Slack.

### 1. Create the employee's Slack app from a manifest

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**, and pick your workspace.
2. Paste the manifest below (YAML). Replace `harness.example.com` with the harness's public host, `meatless` in the
   request URL with the employee's handle (or its id, `emp_…`), and the names with the employee's name.
3. **Install to Workspace**, and approve the scopes.

```yaml
display_information:
  name: Meatless
  description: AI employees, through meatless-proxy
  background_color: "#1f2937"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: meatless
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - files:read
      - files:write
      - groups:history
      - groups:read
      - im:history
      - im:write
      - mpim:history
      - mpim:write
      - reactions:read
      - reactions:write
      - users:read
      - users:read.email
settings:
  event_subscriptions:
    request_url: https://harness.example.com/webhooks/slack/meatless
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
      - reaction_added
  interactivity:
    is_enabled: true
    request_url: https://harness.example.com/webhooks/slack/meatless/interactive
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

What the scopes are for:

| Scope | Needed for |
|-------|------------|
| `chat:write` | `post_message`, `reply`, `update_message`, `ask`, `post_blocks`, and updating an answered question (`chat.update`, `chat.postEphemeral`) |
| `files:read` | `get_file` (`files.info` and the download) |
| `files:write` | `upload_file` (`files.getUploadURLExternal`, `files.completeUploadExternal`) |
| `channels:history`, `groups:history`, `im:history`, `mpim:history` | `read_channel` and `read_thread`, and the `message.*` events |
| `channels:read`, `groups:read` | `list_channels`, and channel names in events |
| `im:write`, `mpim:write` | `open_dm`. `mpim:write` is only needed for group DMs. |
| `reactions:read`, `reactions:write` | `reaction_added` events, `react`, `unreact` |
| `users:read`, `users:read.email` | `lookup_user`, `resolveUser`, and contact matching by email |
| `app_mentions:read` | `app_mention` events |

Interactivity needs no scope of its own, only the Request URL (**Interactivity & Shortcuts**). For an app created
before, turn it on there and set the Request URL to `https://harness.example.com/webhooks/slack/meatless/interactive`,
and add the `files:read` and `files:write` scopes under **OAuth & Permissions** (then reinstall the app).

Slack verifies the request URL when you save the manifest, so the harness must already be running with the signing
secret set. If it isn't, save the manifest anyway, then retry the URL under **Event Subscriptions** once the harness is up.

### 2. Set the employee's secrets

| Secret | Where to find it |
|--------|------------------|
| `SLACK_BOT_TOKEN` | **OAuth & Permissions** → *Bot User OAuth Token* (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | **Basic Information** → *App Credentials* → *Signing Secret* |

Both are harness [secrets](../../docs/spec.md#secrets), **scoped to the employee**: in the web UI under *Settings →
Secrets* (scope: the employee), or through the API:

```sh
curl -X PUT https://harness.example.com/api/secrets \
  -H 'content-type: application/json' \
  -d '{ "name": "SLACK_BOT_TOKEN", "value": "xoxb-…", "scope": { "type": "employee", "id": "emp_…" } }'
```

The same secrets with the global scope are the deployment-wide fallback, for an employee without its own app, and they
verify `POST /webhooks/slack`. Slack is enabled for an employee when its `SLACK_BOT_TOKEN` resolves; until then its
`mcp.slack.*` tools answer "Slack isn't set up for this employee: set the SLACK_BOT_TOKEN secret". A webhook URL whose
signing secret isn't set answers `404`. Changed secrets take effect at once (the server drops its cached instances when
a secret changes, and re-reads secrets at least every minute).

| Webhook URL | Verified with | Events belong to |
|-------------|---------------|------------------|
| `/webhooks/slack/<employee id or handle>` | that employee's `SLACK_SIGNING_SECRET` (else the global one) | that employee: only its triggers match |
| `/webhooks/slack` | the global `SLACK_SIGNING_SECRET` | nobody in particular: any employee's triggers can match |

The server maps each event's actor to a contact through the contact's `slack` handle. When no contact has the handle, it
looks the user up (`users.info`) and matches the contact by email, then records the handle on it. It never creates
contacts from webhooks.

### 3. Invite the app

The bot only sees channels it is a member of. Run `/invite @meatless` in each channel it should read or post in. DMs to
the app work without an invite.

### Recommended triggers

Triggers are not created automatically: add them per employee with "Add recommended trigger" in the guided setup, or e.g. by asking the employee in harness chat to create
this one with its `triggers.create` tool (`CreateTriggerInput` in `@mp/events`). This one routes the
employee's mentions and DMs to its router context ([the router context](../../docs/spec.md#the-router-context)), which
answers directly or starts a session that then owns the thread, and keeps a one-line decision:

```json
{
  "name": "Slack: mentions and DMs",
  "employeeId": "emp_…",
  "match": { "source": "integration:slack", "filter": { "type": { "$in": ["message.mentioned", "message.direct"] } } },
  "target": { "type": "router" },
  "fork": false,
  "mode": "ephemeral"
}
```

**Answers go back to Slack.** When a run caused by a Slack event it was expected to act on ends with a final answer (not
`NO_REPLY`), without posting in Slack itself (`post_message`, `reply`, `update_message`, `ask`, `post_blocks`, `upload_file`) and without handing the work to
another session, the server posts that answer in the event's thread with the employee's bot. A working session is then
subscribed to the thread, so follow-ups come back to it; the router context never subscribes (follow-ups come back
through its trigger, and it decides again).

To act on every new top-level message in one channel (e.g. `#access-requests`), without double-handling mentions:

```json
{
  "name": "Slack: #access-requests",
  "employeeId": "emp_…",
  "match": {
    "source": "integration:slack",
    "type": "message.posted",
    "where": { "payload.channel": "C0123ABCD", "payload.mentions_app": false }
  },
  "target": { "type": "procedure", "procedureId": "prc_…" },
  "fork": true
}
```

A session working on a thread subscribes to its subject, e.g. `{ system: 'slack', id: 'C0123ABCD/1712345678.123456' }`
with types `["message.replied", "message.mentioned", "message.edited"]`, and answers with `mcp.slack.reply`. A session
that asked with `ask` is subscribed to the thread, and the answer is delivered to it through the event's session tag.

## Tests

`npx vitest run --project node packages/integration-slack` runs against `test/fake-slack.ts`, a local `node:http` fake of
the Web API. The fake has Slack's payload shapes, the `ok: false` convention, cursor pagination and bearer-token auth. The
tests cover:

- The client: 429 with Retry-After, `ratelimited`, 5xx backoff, no retry for writes after a 5xx, 4xx and network errors,
  and token redaction.
- Every tool, through a real MCP client over `InMemoryTransport`.
- Signature verification, including Slack's documented example, bad and stale signatures, and replays.
- Every event mapping, and files in the event text.
- Channel-name caching.
- `resolveUser`.
- Questions (`test/interactive.test.ts`): the blocks for every field type and every limit, reading each element's
  answer, the read-only message, the `ask` and `post_blocks` tools, and the interactive webhook: form-encoded and signed,
  401 for a bad or stale signature, the answer recorded, first answer wins under concurrency, `allowMultiple`, empty
  required inputs, `chat.update` failing, unknown messages and buttons ignored.
- Files (`test/files.test.ts`): the download with the token, redirects to other hosts refused, the size limit (declared
  and actual), the missing scope, external and unknown files; uploads of an image and a text file into a thread through
  the three steps, too large and empty files refused before any call, the missing `files:write` scope, upload URLs off
  Slack (or over http) refused, channel errors, and the tool refusing outside the harness.
- Slack's explanation of an error (`slack_messages`) on `post_blocks` and `ask` (`test/interactive.test.ts`).

The live smoke test is opt-in. It makes one read call (`list_channels`):

```sh
MP_LIVE_SLACK=1 SLACK_BOT_TOKEN=xoxb-… npx vitest run packages/integration-slack/test/live.test.ts
```

## Replacing

Implement `Integration` from `@mp/mcp` in another package, or point the harness at any other Slack MCP server, then
switch the server's integration wiring.
