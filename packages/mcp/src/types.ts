export interface McpServerConfig {
  /** Unique name, used in tool names: `mcp.<name>.<tool>`. */
  name: string
  transport: 'stdio' | 'http'
  /** stdio */
  command?: string
  args?: string[]
  /** http (streamable HTTP) */
  url?: string
  /** Plain environment variables (stdio) or headers (http). No secret values here. */
  env?: Record<string, string>
  /**
   * Secret variables to inject: env var (stdio) or header (http) name -> secret
   * name. Values are resolved through `resolveSecrets` when connecting.
   */
  secrets?: Record<string, string>
  /**
   * Text put before a secret's value in its variable, by variable name, e.g.
   * `{ Authorization: 'Bearer ' }` for a bearer token header.
   */
  secretPrefix?: Record<string, string>
}

export interface McpToolInfo {
  server: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  /** MCP content blocks, e.g. `{ type: 'text', text }`. */
  content: unknown[]
  structuredContent?: unknown
  isError: boolean
}

export interface McpNotification {
  server: string
  method: string
  params: Record<string, unknown>
}

export interface McpHub {
  servers(): string[]
  listTools(server?: string): Promise<McpToolInfo[]>
  callTool(server: string, tool: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<McpCallResult>
  /** Server-sent notifications from any server. Returns an unsubscribe function. */
  onNotification(handler: (n: McpNotification) => void): () => void
  close(): Promise<void>
}

/**
 * A server's connection state in a `ManagedMcpHub`:
 * - `idle`: added, not connected yet (servers connect lazily) or disconnected since;
 * - `connecting`;
 * - `connected`;
 * - `needs_auth`: the server wants (new) authorization, e.g. an OAuth sign-in, before it can be used;
 * - `error`: the last connect failed (`error` says why).
 */
export type McpServerState = 'idle' | 'connecting' | 'connected' | 'needs_auth' | 'error'

export interface McpServerStatus {
  state: McpServerState
  /** Why the server is in `error` or `needs_auth`. Never contains secret values. */
  error?: string
  /** The last error, kept after a later success. */
  lastError?: string
  lastErrorAt?: string
  connectedAt?: string
  /** Tools listed on the current connection, when they have been listed. */
  toolCount?: number
}

/** An McpHub whose servers can be added, removed and reconnected while it runs. */
export interface ManagedMcpHub extends McpHub {
  /** Adds a server. It connects lazily, like the others. `ConflictError` when the name is taken, `ValidationError` for a bad config. */
  addServer(config: McpServerConfig): void
  /** Removes a server and closes its connection (calls in flight fail). Returns whether it existed. */
  removeServer(name: string): Promise<boolean>
  /** Closes the server's connection and connects again now. Never throws: the outcome is in the status. */
  reconnect(name: string): Promise<McpServerStatus>
  /** The server's connection status. `NotFoundError` for an unknown server. */
  status(name: string): McpServerStatus
  /** Called whenever a server's state changes. Returns an unsubscribe function. */
  onStatus(handler: (server: string, status: McpServerStatus) => void): () => void
}

/** Whether a hub can manage servers at runtime. */
export function isManagedHub(hub: McpHub | null | undefined): hub is ManagedMcpHub {
  return !!hub && typeof (hub as Partial<ManagedMcpHub>).addServer === 'function'
}

/**
 * Resolves secret names to values when a server is connected. `server` is the
 * server being connected, so a resolver can scope its secrets per server.
 */
export type SecretResolver = (names: string[], server: McpServerConfig) => Promise<Record<string, string>>

/** The text of an MCP result, joining its text blocks. */
export function resultText(result: McpCallResult): string {
  return result.content
    .map((c) => (c && typeof c === 'object' && (c as any).type === 'text' ? String((c as any).text) : ''))
    .filter(Boolean)
    .join('\n')
}
