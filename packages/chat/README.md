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

Name and slug resolution are injected functions, so chat doesn't depend on `@mp/directory` or `@mp/sessions`.

## Tests

`npx vitest run --project node packages/chat`, against `memoryStore()` with `@mp/events`.

## Replacing it

Implement the `Chat` interface in a new package at the same layer and switch the composition root.
