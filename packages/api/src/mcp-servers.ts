// ─── MCP servers ────────────────────────────────────────────────────────────
//
// MCP servers the harness connects to, added at runtime (records) or from the
// `MCP_SERVERS` config (read-only). Admins only. Secret values (tokens, OAuth
// credentials) are write-only: the API never returns them.

/** Effect class of an MCP tool (see docs/execution.md#side-effects). */
export type McpEffect = 'read' | 'idempotent' | 'non_idempotent'

/** Maps a server notification to an event (same as the `MCP_SERVERS` config). */
export interface McpEventMapping {
  /** The notification method; `*` matches every method. */
  method: string
  type?: string
  subjectFrom?: string
  subjectSystem?: string
  idFrom?: string
  actorFrom?: string
  textFrom?: string
}

/**
 * - `connected`: tools are registered.
 * - `connecting`: connecting, or not connected yet.
 * - `needs_auth`: an admin must (re)connect OAuth, or the token was refused.
 * - `error`: the last connect failed (see `error`).
 * - `disabled`: switched off; its tools are unregistered.
 */
export type McpServerState = 'connected' | 'connecting' | 'needs_auth' | 'error' | 'disabled'

export interface McpServerStatusInfo {
  state: McpServerState
  error?: string
  lastError?: string
  lastErrorAt?: string
  connectedAt?: string
  /** Registered tools (`mcp.<name>.<tool>`). */
  toolCount: number
}

/** How the harness authenticates to a server, without any secret value. */
export type McpServerAuthInfo =
  | { type: 'none' }
  | {
      type: 'token'
      /** Header the token goes in. Default `Authorization`. */
      header: string
      /** Put before the token. Default `Bearer `. */
      prefix: string
      /** The secret holding the token (scoped to the employee, or global). */
      secret: string
      /** Whether that secret is set. */
      hasToken: boolean
    }
  | {
      type: 'oauth'
      scopes?: string[]
      clientId?: string
      /** Secret holding the client secret, when there is one. */
      clientSecretSecret?: string
      authorizationServer?: string
      /** Whether tokens are stored (someone connected). */
      hasTokens: boolean
    }

export interface McpServerInfo {
  /** `mcs_…` for servers added at runtime, `config:<name>` for `MCP_SERVERS` ones. */
  id: string
  /** Slug; tools are `mcp.<name>.<tool>`. */
  name: string
  /** `config` servers come from `MCP_SERVERS` and are read-only. */
  source: 'record' | 'config'
  transport: 'http' | 'stdio'
  url?: string
  /** Non-secret headers. */
  headers?: Record<string, string>
  /** The employee whose sessions see the tools; null for every employee. */
  employeeId: string | null
  enabled: boolean
  effect?: McpEffect
  effects?: Record<string, McpEffect>
  events?: McpEventMapping[]
  auth: McpServerAuthInfo
  status: McpServerStatusInfo
  version?: number
  createdAt?: string
  updatedAt?: string
}

/** How to authenticate, as sent to the API. Secret values are written to the secret store, never stored in the server. */
export type McpServerAuthInput =
  | { type: 'none' }
  | {
      type: 'token'
      header?: string
      prefix?: string
      /** Use this existing secret instead of a generated `MCP_<NAME>_TOKEN`. */
      secret?: string
      /** The token. Required on create unless `secret` names an existing secret; on update, leave it out to keep the current one. */
      token?: string
    }
  | {
      type: 'oauth'
      scopes?: string[]
      clientId?: string
      /** A client secret value, stored as `MCP_<NAME>_OAUTH_CLIENT_SECRET`. */
      clientSecret?: string
      /** Or the name of an existing secret holding it. */
      clientSecretSecret?: string
      authorizationServer?: string
    }

/** `POST /api/mcp-servers`. */
export interface McpServerCreate {
  name: string
  url: string
  headers?: Record<string, string>
  /** Omit or null for a global server. */
  employeeId?: string | null
  /** Default true. */
  enabled?: boolean
  effect?: McpEffect
  effects?: Record<string, McpEffect>
  events?: McpEventMapping[]
  /** Default `{ type: 'none' }`. */
  auth?: McpServerAuthInput
}

/** `PATCH /api/mcp-servers/:id`. The name and the employee can't change. */
export interface McpServerPatch {
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
  effect?: McpEffect | null
  effects?: Record<string, McpEffect> | null
  events?: McpEventMapping[] | null
  auth?: McpServerAuthInput
  /** Compare-and-swap on the server's version. */
  version?: number
}

/** A tool of a server, as registered. */
export interface McpServerTool {
  /** The server's own tool name. */
  name: string
  /** The registered name, `mcp.<server>.<tool>`. */
  toolName: string
  description: string
  inputSchema: Record<string, unknown>
  effect: McpEffect
}

/** `POST /api/mcp-servers/:id/oauth/start`: where to send the person. */
export interface McpOAuthStart {
  authorizationUrl: string
  /** When the sign-in must be finished by. */
  expiresAt: string
}

/**
 * Query parameters the OAuth callback redirects back to the UI with:
 * `mcp_oauth=connected|error`, `mcp_server=<name>` and, on error, `mcp_error=<message>`.
 */
export const MCP_OAUTH_QUERY = { status: 'mcp_oauth', server: 'mcp_server', error: 'mcp_error' } as const
