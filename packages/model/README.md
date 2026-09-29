# @mp/model

The model port: OpenAI-compatible Chat Completions shapes (`ChatMessage`, `ToolSpec`, `ToolCall`, `Usage`,
`ModelRequest`, `ModelResponse`) and the `ModelClient` interface, plus a scripted fake for tests.

## API

- Images: `ChatMessage.images?: ImagePart[]` on `user` and `tool` messages, `ImagePart { type: 'image', mime, data?, ref?,
  name?, width?, height? }`. `ref` is an `ImageRef` (`source: 'attachment' | 'file'`, `id` or `owner` + `path`, `sha256`,
  `name`, `mime`, size): what histories keep; the runner fills in `data` (base64) before a call.
- `ModelClient.capabilities?(model?)` → `{ vision? }` or null: what the provider says a model can do.
  `knownVisionModel(name)` guesses from the name when it doesn't say.
- `ModelClient` — `complete(req)`; streams through `req.onDelta` when the implementation streams; honours `req.signal`.
- `scriptedModel(script, { model?, chunkSize?, chunkDelayMs? })` — a fake `ModelClient`. `script` is an array of steps
  (a `ModelResponse`, a `PartialModelResponse`, a string reply, an `Error` to throw, or a `(req, callIndex) => …`
  responder) or a single responder function. It records every request in `model.calls`, streams reasoning then content to
  `onDelta` in chunks, honours `signal`, estimates missing usage (~4 chars per token) and throws an `MpError`
  `script_exhausted` naming the call when the script runs out. `remaining()` and `push()` help in long scenarios.
- `reply(text, usage?)`, `callTools([{ name, args?, id? }], text?, usage?)` — build assistant responses; tool calls get
  generated `call_…` ids.
- `parseToolArguments(call)` — safe JSON parse of a tool call's arguments: `{ ok: true, args } | { ok: false, error, raw }`.
- `toolSpec(name, description, parameters?)` — a tool definition in the `tools` format.
- `emptyUsage()`, `estimateTokens(text)`, `newToolCallId()`.

## Tests

`npx vitest run --project node packages/model` (unit tests of the fake and helpers).

## Replacing

A provider adapter implements `ModelClient` (see `@mp/model-openai`). Code above only depends on the interface.
