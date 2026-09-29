# @mp/mcp

The MCP port: `McpHub` (configured servers, their tools, tool calls, server notifications), `ManagedMcpHub` (servers
added, removed and reconnected at runtime), `McpServerConfig`, `SecretResolver`, `resultText`, a fake hub and contract
suites.

## API

- `McpHub` — `servers()`, `listTools(server?)`, `callTool(server, tool, args, { signal? })`, `onNotification(handler)`
  (returns unsubscribe), `close()`.
- `ManagedMcpHub extends McpHub` — `addServer(config)` (`ConflictError` for a taken name), `removeServer(name)`,
  `reconnect(name)` (never throws; resolves with the status), `status(name)` → `McpServerStatus`
  (`idle | connecting | connected | needs_auth | error`, `error`, `lastError`, `lastErrorAt`, `connectedAt`,
  `toolCount`), `onStatus(handler)`. `isManagedHub(hub)` tells the two apart.
- `McpServerConfig` — `name`, `transport`, `command`/`args` or `url`, `env` (plain), `secrets` (variable → secret
  name), `secretPrefix` (variable → text before the value, e.g. `Bearer `).
- `SecretResolver` — `(names, server) => values`: the server being connected is passed, so secrets can be scoped
  per server.
- `fakeMcpHub({ servers: { name: { tools, call? } }, definitions? })` — in-memory `ManagedMcpHub` for tests.
  `call(tool, args, { signal })` may return an `McpCallResult`, a string (text result) or any JSON value (sent as JSON
  text); default echoes `{ tool, args }`. Records `hub.calls`, `hub.notify(server, method, params?)` delivers a
  notification, `hub.setServer()` adds or replaces a server, `addServer(config)` uses `definitions[config.name]`,
  `setStatus(name, status)` fakes a status change. Unknown servers/tools throw `NotFoundError`; after `close()` calls
  throw `UnavailableError`.
- `@mp/mcp/contract` — `mcpHubContract(name, make)`: the behaviour every hub must have (a `demo` server with `echo` and
  `fail` tools, notifications, unknown servers, concurrency, close). `managedMcpHubContract(name, make)`: adding,
  removing, reconnecting and status, for hubs that manage servers.

## Tests

`npx vitest run --project node packages/mcp/test` — the fake's own tests plus both contracts.

## Replacing

Implement `McpHub` (and `ManagedMcpHub` for runtime servers) in a new package and run the contracts against it (see
`@mp/mcp-sdk`).
