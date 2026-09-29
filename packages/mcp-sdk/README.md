# @mp/mcp-sdk

`ManagedMcpHub` adapter over the official `@modelcontextprotocol/sdk` client, with OAuth.

## API

`createMcpHub({ servers?, resolveSecrets?, authProviderFor?, logger?, clock?, clientInfo?, transportFactory?,
requestTimeoutMs? })` returns an `SdkMcpHub` (`ManagedMcpHub` plus `start()` and `connected(server)`).

- Transports: `stdio` spawns `command args` with the SDK's safe default environment plus `config.env` and resolved
  secrets (stderr is logged at debug level, secret values redacted); `http` uses streamable HTTP with `config.env` and
  resolved secrets (with `secretPrefix`, e.g. `Authorization: Bearer <token>`) as headers, and the OAuth provider from
  `authProviderFor(config)` when there is one. Secret values are never logged, and are masked (`[redacted]`) in tool
  results and errors, OAuth tokens included. `transportFactory({ config, env, authProvider? })` replaces this, e.g.
  with an `InMemoryTransport` in tests. `defaultTransport(logger)` is exported.
- Connecting: **lazy** — a server connects on first `listTools`/`callTool`. Call `start()` at startup to connect all
  servers now (needed to receive notifications); it never throws and reports `{ server, ok, error? }` per server.
  A failed connect is retried once, then fails with `UnavailableError` (missing secrets fail with `ValidationError`).
  A server that refuses our authorization (401 after any refresh) fails at once with `UnavailableError` whose
  `details.needsAuth` is true, and its status is `needs_auth`. A dropped connection is re-established on next use.
- Runtime: `addServer`, `removeServer` (closes the connection, also one still connecting), `reconnect`, `status`,
  `onStatus` (see `@mp/mcp`).
- `listTools` pages through `nextCursor`, caches per connection and refreshes on `notifications/tools/list_changed`.
  It reconnects and retries once on a connection failure.
- `callTool` maps the result to `McpCallResult` (legacy `toolResult` too). Protocol errors (unknown tool, invalid
  arguments) come back as `isError: true` results; connection failures and timeouts throw `UnavailableError` and are
  not retried, because the call may have had an effect.
- Every server notification (except the SDK-internal `cancelled`/`progress`) is forwarded to `onNotification` handlers
  as `{ server, method, params }`.
- `close()` closes all clients, including ones still connecting.

### OAuth (`src/oauth.ts`)

- `StoredOAuthProvider(options, interactive?)` — the SDK's `OAuthClientProvider` over an `OAuthStorage`
  (`get/set/delete` of `client`, `tokens`, `verifier`, `discovery`, as JSON strings: back it with a secret store).
  Options: `redirectUrl`, `scopes?`, `clientId?` and `clientSecret?` (a value or an async getter) for a pre-registered
  client, `authorizationServer?` when discovery can't find it. Without `interactive` it only sends and refreshes
  tokens (a hub uses it this way); a needed sign-in makes the connection `needs_auth`, it never redirects anyone.
- `beginAuthorization({ ...options, serverUrl, state })` → the authorization URL: discovery (protected-resource, then
  authorization-server metadata), dynamic client registration when no client is configured or stored, PKCE. The
  stored tokens stay in use until new ones arrive.
- `completeAuthorization({ ...options, serverUrl, code })` exchanges the code with the saved verifier (used once) and
  stores the tokens. Refresh is the SDK's: on a 401 the transport refreshes; a failed refresh deletes the tokens.

### Testing (`@mp/mcp-sdk/testing`)

`startFakeOAuthMcp({ expiresIn?, staticToken?, open?, noResourceMetadata? })` starts, on a free local port, an
authorization server (metadata, registration, authorize with PKCE, token with rotating refresh tokens) and an MCP
server (`McpServer` over `StreamableHTTPServerTransport`, tools `echo` and `whoami`) that checks bearer tokens. It has
`url`, `origin`, `stats`, `authHeaders`, `approve(authorizationUrl)` (consents like a browser, returns the callback
URL), `expireAccessTokens()`, `revokeRefreshTokens()` and `close()`. For tests only.

## Tests

`npx vitest run --project node packages/mcp-sdk`: the `@mp/mcp` contracts and adapter tests against in-process SDK
servers over `InMemoryTransport`, OAuth and token auth against the fake over real HTTP (discovery, registration, code
exchange, refresh on expiry, refresh failure → `needs_auth`, pre-registered clients, a configured authorization
server, masking), plus a stdio test that spawns `test/fixtures/stdio-server.ts` with `node --import tsx` (skipped if
tsx can't be resolved, or with `MP_SKIP_SPAWN=1`).

## Replacing

Implement `ManagedMcpHub` elsewhere, pass `mcpHubContract` and `managedMcpHubContract` from `@mp/mcp/contract`, and
switch the server's composition root.
