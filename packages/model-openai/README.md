# @mp/model-openai

`ModelClient` adapter for any OpenAI-compatible Chat Completions endpoint (Kimi first), using `fetch`.

## API

`openAiModel({ baseUrl, apiKey, model, fetch?, timeoutMs?, maxRetries?, retryBaseMs?, retryMaxMs?, logger?, stream?, headers?, clock?, random? })`

- `POST {baseUrl}/chat/completions` with `model`, `messages` (including `reasoning_content` and tool calls, so history
  round-trips), `tools`, `max_tokens`, `temperature`.
- `stream`: `'auto'` (default) streams when the request has `onDelta`; `true`/`false` force it. Streaming sends
  `stream: true, stream_options: { include_usage: true }`, reassembles tool calls by `index`, and passes `content` and
  `reasoning_content` deltas to `onDelta` (`{ content }` / `{ reasoning }`).
- Usage: `prompt_tokens`, `completion_tokens`, `total_tokens`; cached tokens from `prompt_tokens_details.cached_tokens` or
  top-level `cached_tokens`; reasoning from `completion_tokens_details.reasoning_tokens`. Usage inside the final streamed
  choice (Kimi) is read too.
- Retries on 408/429/5xx, network errors and timeouts, with exponential backoff and jitter, honouring `Retry-After`
  (capped by `retryMaxMs`); after `maxRetries` it throws `UnavailableError`. Other 4xx throw `MpError('model_request')`
  with `details.status`. A stream that breaks after output was delivered is not retried (it would repeat deltas).
- `timeoutMs` (default 300 s) covers a whole attempt, stream included. `signal` aborts immediately, also during backoff.
- The API key is sent only as the `Authorization` header and is redacted from errors and logs.
- Also exports `mapUsage(usage)` and `parseRetryAfter(value, nowMs)`.

## Tests

`npx vitest run --project node packages/model-openai` runs against a local `node:http` fake server (no network).
`MP_LIVE_MODEL_TEST=1` with `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `MODEL` set enables one tiny live call
(`test/live.test.ts`).

## Replacing

Write another package implementing `ModelClient` from `@mp/model` and switch the server's composition root to it.
