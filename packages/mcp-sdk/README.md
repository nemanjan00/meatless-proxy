# @mp/mcp-sdk

`McpHub` adapter over the official `@modelcontextprotocol/sdk` client.

## API

`createMcpHub({ servers, resolveSecrets?, logger?, clientInfo?, transportFactory?, requestTimeoutMs? })` returns an
`SdkMcpHub` (`McpHub` plus `start()` and `connected(server)`).

- Transports: `stdio` spawns `command args` with the SDK's safe default environment plus `config.env` and resolved
  secrets (stderr is logged at debug level, secret values redacted); `http` uses streamable HTTP with `config.env` and
  resolved secrets as headers. Secret values are never logged. `transportFactory({ config, env })` replaces this, e.g.
  with an `InMemoryTransport` in tests. `defaultTransport(logger)` is exported.
- Connecting: **lazy** — a server connects on first `listTools`/`callTool`. Call `start()` at startup to connect all
  servers now (needed to receive notifications); it never throws and reports `{ server, ok, error? }` per server.
  A failed connect is retried once, then fails with `UnavailableError` (missing secrets fail with `ValidationError`).
  A dropped connection is re-established on next use.
- `listTools` pages through `nextCursor`, caches per connection and refreshes on `notifications/tools/list_changed`.
  It reconnects and retries once on a connection failure.
- `callTool` maps the result to `McpCallResult` (legacy `toolResult` too). Protocol errors (unknown tool, invalid
  arguments) come back as `isError: true` results; connection failures and timeouts throw `UnavailableError` and are
  not retried, because the call may have had an effect.
- Every server notification (except the SDK-internal `cancelled`/`progress`) is forwarded to `onNotification` handlers
  as `{ server, method, params }`.
- `close()` closes all clients, including ones still connecting.

## Tests

`npx vitest run --project node packages/mcp-sdk`: the `@mp/mcp` contract and adapter tests against in-process SDK
servers over `InMemoryTransport`, plus a stdio test that spawns `test/fixtures/stdio-server.ts` with `node --import tsx`
(skipped if tsx can't be resolved, or with `MP_SKIP_SPAWN=1`).

## Replacing

Implement `McpHub` elsewhere, pass `mcpHubContract` from `@mp/mcp/contract`, and switch the server's composition root.
