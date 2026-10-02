# @mp/tools

The tool registry and the execution contract between the runner (which calls tools) and the stdlib and MCP (which provide them). See docs/spec.md#tool-registry and docs/execution.md#side-effects.

## API

- Types: `EffectClass`, `ToolDefinition`, `ToolContext`, `ControlSignal`, `ToolResult`, `ToolHandler`, `ToolLists`, `ToolRegistry`, `RETHROWN_ERROR_CODES`.
- `createToolRegistry()` -> `ToolRegistry`:
  - `register(def, handler, { replace? })` (`ConflictError` on duplicates or provider-name clashes), `unregister`, `get`, `list()` (sorted).
  - `allowed({ allow, deny })`, `isAllowed(name, lists)`: `globMatch` patterns, deny wins, nothing allowed by default. `*` stays within a dot segment (`mcp.linear.*`), `**` crosses segments (`mcp.**`).
  - `specs(names)`: OpenAI tool specs sorted by tool name with provider-safe names (`.` -> `__`, other invalid chars -> `_`, >64 chars shortened with a hash). `providerName(name)`, `resolveProviderName(providerName)`.
  - `execute(name, args, ctx)`: unknown tool throws `NotFoundError`; bad arguments (not an object, missing `required`, wrong top-level `type`) return `{ output: { error }, isError: true }` without calling the handler; handler errors are returned the same way, **except** `MpError`s with code `denied`, `limit` or `unavailable` and any error after `ctx.signal` aborted, which are rethrown for the runner (policy, pause, retry, cancellation).
- `checkArgs(schema, args)`, `toProviderName(name)`.
- `LOADED_TOOLS_META` (`loadedTools`), `loadedToolsOf(meta)`: the on-demand tools a session loaded, shared by the runner (which offers them) and the stdlib (`tools.load`).
- `registerMcpTools(registry, hub, { effectOf?, secretsOf?, server? })`: registers every hub tool as `mcp.<server>.<tool>` (default effect `non_idempotent`); the handler calls `hub.callTool` with the call's signal and returns the result text (or structured content when there's no text) with `isError`. Calling it again refreshes and unregisters tools that disappeared. `mcpToolName(server, tool)`.

Hook points (before/after tool call) are declared by the runner, not here.

## Tests

`npx vitest run --project node packages/tools`, with a small local fake `McpHub`.

## Replacing it

Implement `ToolRegistry` in a new package at the same layer and switch the composition root.
