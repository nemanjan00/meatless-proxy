import type { Json } from '@mp/core'

/**
 * A first-party integration: an MCP server for a system's tools, plus the
 * inbound side (webhooks turned into events) and identity lookup. The harness
 * connects to `createMcpServer()` in-process and mounts `handleWebhook` at
 * `/webhooks/<name>`. Any integration can be replaced by another MCP server.
 */
export interface Integration {
  /** `slack`, `linear`, `gitlab`, …: also the MCP server name, so tools are `mcp.<name>.<tool>`. */
  readonly name: string
  /** An MCP server (the official SDK's `McpServer` or `Server`) exposing the tools. */
  createMcpServer(): IntegrationMcpServer
  /**
   * Handles one inbound webhook request: verifies its signature (constant time, rejecting stale
   * timestamps where the platform signs them) and returns the events to ingest, or a challenge response.
   */
  handleWebhook(req: WebhookRequest): Promise<WebhookResult>
  /** Identity data for an external user, for matching to a contact through its handles. */
  resolveUser?(externalId: string): Promise<ExternalUser | null>
}

/** Structurally the SDK server: anything that can `connect` to a transport and `close`. */
export interface IntegrationMcpServer {
  connect(transport: unknown): Promise<void>
  close(): Promise<void>
}

export interface WebhookRequest {
  method: string
  /** Lowercased header names. */
  headers: Record<string, string>
  /** The raw body, exactly as received: signatures are computed over it. */
  body: string
  query: Record<string, string>
}

export interface WebhookResult {
  status: number
  body?: string
  headers?: Record<string, string>
  events: IntegrationEvent[]
  /**
   * Work to do after the response is sent, for platforms that want a quick acknowledgement
   * (Slack's interactivity: 200 within 3 s). The harness answers at once, runs it in the
   * background, and ingests the events it returns like `events`.
   */
  after?: () => Promise<IntegrationEvent[]>
}

export interface IntegrationEvent {
  /** `integration:<name>`. */
  source: string
  /** e.g. `message.posted`, `issue.assigned`, `merge_request.updated`, `pipeline.failed`. */
  type: string
  /** Stable, from the system's own delivery or event id. */
  dedupeKey: string
  /** What it's about, e.g. `{ system: 'linear', id: 'PAY-123' }`. */
  subject?: { system: string; id: string }
  /** The external user who caused it; the harness maps it to a contact through handles. */
  actor?: { system: string; id: string }
  /** A short rendering for the model. */
  text: string
  /** The relevant fields: not the whole raw body, and never secrets. */
  payload: Json
}

export interface ExternalUser {
  handle: { system: string; id: string }
  email?: string
  /** The user's full name. */
  name?: string
  /** The short name people see in the system (Slack's display name, GitLab's username), when it differs. */
  displayName?: string
  /** A bot or app account, not a person: never turned into a person contact. */
  bot?: boolean
}
