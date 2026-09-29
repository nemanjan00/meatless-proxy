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

/** Resolves secret names to values when a server is connected. */
export type SecretResolver = (names: string[]) => Promise<Record<string, string>>

/** The text of an MCP result, joining its text blocks. */
export function resultText(result: McpCallResult): string {
  return result.content
    .map((c) => (c && typeof c === 'object' && (c as any).type === 'text' ? String((c as any).text) : ''))
    .filter(Boolean)
    .join('\n')
}
