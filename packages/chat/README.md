# @mp/chat

Harness chat (docs/spec.md#harness-chat): channels, threads, messages, members and tags.

- **channel** (`chn_…`, record key = normalised name): `name`, `topic`, `createdBy {kind, id}`, `archived`, `contextSessionId` (informational; routing uses triggers).
- **message** (`msg_…`): `channelId`, `threadId` (root message id, null for top-level), `author {kind: contact|session, id}`, `text` (`[[kind:id]]` mentions become `mentions` links), resolved `tags`, `mentions`, `createdAt`.
- Members are links `channel -> member` with role `member` (any record kind: contact, employee, session). The member record must exist.

## API

- `parseTags(text)` -> `[{ raw, name, slug? }]` for `@name` and `@name#session-slug`, ignoring emails and code spans/blocks.
- `createChat({ records, events, clock?, bus?, resolveName, resolveSessionSlug })` -> `Chat`:
  `createChannel`, `getChannel`, `channelByName`, `listChannels({ archived? })`, `updateChannel`, `archive`, `addMember`, `removeMember`, `members`,
  `post({ channelId, threadId?, author, text, authorInfo? })`, `getMessage`, `thread(rootId)`, `messages(channelId, { limit?, before? })`, `search(text, { channelId?, limit? })`.
- `post` resolves tags (`employee`, `session`, `person`; anything else, including `@person#slug` or an unknown slug, is kept as `unresolved` with its raw text), stores the message, ingests a durable event (`source: 'chat'`, type `message.posted` or `message.replied`, dedupe key `chat:<messageId>`, subject `{ system: 'mp', id: <thread root> }`), then publishes `chat.message` `{ channelId, threadId, messageId }`. `authorInfo` (`{ contactKind?, name?, onBehalfOf? }`, e.g. for a local agent) is merged into the event payload's `author`; the message keeps `{kind, id}`. Replying to a reply is normalised to the root. Archived channels refuse posts.

## Attachments

`createChatAttachments({ records, storage, clock?, logger?, limits? })` (`src/attachments.ts`) → `ChatAttachments`, passed
to `createChat` as `attachments`. The bytes live in a `FileStorage` (the files volume) under the owner `attachments`:
`/pending/<id>` for an upload, `/<channelId>/<id>` once a message has it. A `chat_attachment` record (`att_…`) keeps the
metadata: `name`, `mime` (sniffed), `size`, `width`, `height`, `sha256`, `uploadedBy`, `createdAt`, `channelId`,
`messageId`.

- `upload({ bytes, name?, by })`: PNG, JPEG, GIF or WebP by magic bytes (`sniffImage` from `@mp/files`), at most
  `limits.maxBytes` (default 10 MB); the name is cleaned (last path segment, no control characters).
- `check(ids, by)` / `claim(ids, { by, channelId, messageId })`: at most `limits.maxPerMessage` (10), each a pending upload
  of `by` within `limits.claimWindowMs` (1 hour). Someone else's upload is `DeniedError`, one already on a message
  `ConflictError`, an unknown or expired one `NotFoundError`. Claims are compare-and-swap, and a failed claim puts back
  what it took.
- `get`, `read(id)` (metadata and bytes), `removeForMessage(messageId)`, `cleanup()` (uploads never attached within the
  window, and claims whose message never appeared).
- `post({ …, attachments: [id…] })` claims them for the new message (pre-generated id), stores `attachments` on the message
  (the text may then be empty), adds them to the event payload, and names them in the event text, one line each:
  `attachmentLine(a)` → `[image: chart.png 800x600, attachment att_…]`. `delete` removes them.
- Helpers: `attachmentView(record)`, `attachmentsOf(messageData)`, `cleanAttachmentName`.

Name and slug resolution are injected functions, so chat doesn't depend on `@mp/directory` or `@mp/sessions`.

## Tests

`npx vitest run --project node packages/chat`, against `memoryStore()` with `@mp/events`.

## Replacing it

Implement the `Chat` interface in a new package at the same layer and switch the composition root.
