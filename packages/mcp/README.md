# @mp/mcp

The MCP port: `McpHub` (configured servers, their tools, tool calls, server notifications), `McpServerConfig`,
`SecretResolver`, `resultText`, a fake hub and a contract suite.

## API

- `McpHub` — `servers()`, `listTools(server?)`, `callTool(server, tool, args, { signal? })`, `onNotification(handler)`
  (returns unsubscribe), `close()`.
- `fakeMcpHub({ servers: { name: { tools, call? } } })` — in-memory hub for tests. `call(tool, args, { signal })` may return
  an `McpCallResult`, a string (text result) or any JSON value (sent as JSON text); default echoes `{ tool, args }`.
  Records `hub.calls`, `hub.notify(server, method, params?)` delivers a notification, `hub.setServer()` adds or replaces
  a server. Unknown servers/tools throw `NotFoundError`; after `close()` calls throw `UnavailableError`.
- `@mp/mcp/contract` — `mcpHubContract(name, make)`: the behaviour every hub must have (a `demo` server with `echo` and
  `fail` tools, notifications, unknown servers, concurrency, close).

## Tests

`npx vitest run --project node packages/mcp` — the fake's own tests plus the contract.

## Replacing

Implement `McpHub` in a new package and run `mcpHubContract` against it (see `@mp/mcp-sdk`).
