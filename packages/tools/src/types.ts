import type { Clock, Json, Logger } from '@mp/core'
import type { ImageRef, ToolSpec } from '@mp/model'
import type { WaitCondition } from '@mp/sessions'

/** How a tool call behaves when repeated after a crash. See docs/execution.md#side-effects. */
export type EffectClass = 'read' | 'idempotent' | 'non_idempotent'

export interface ToolDefinition {
  /** Namespaced, e.g. `sessions.fork`, `mcp.linear.create_issue`. */
  name: string
  /** What the model sees. */
  description: string
  /** JSON schema of the arguments (an `object` schema). */
  parameters: Record<string, unknown>
  effect: EffectClass
  /** Secret variable names injected at call time. */
  secrets?: string[]
  source: 'stdlib' | 'mcp'
  /** For MCP tools: the server name. */
  server?: string
  tags?: string[]
}

/** Everything a handler gets besides its arguments. */
export interface ToolContext {
  employeeId: string
  sessionId: string
  runId: string
  /** The model's tool_call id. */
  callId: string
  /** `runId:step:callId`, stable across retries of the same call. */
  idempotencyKey: string
  /** The contact the work is for, if known. */
  requesterId?: string
  /** Injected secret values, by variable name. Never put these in outputs. */
  secrets: Record<string, string>
  signal: AbortSignal
  logger: Logger
  clock: Clock
  /** Publishes a bus message (the runner wires this to the event bus). */
  emit(topic: string, payload: unknown): void
}

/** What a tool asks the runner to do after it returns. Applied in order. */
export type ControlSignal =
  | { type: 'suspend'; wait: WaitCondition }
  | { type: 'commit'; summary?: string }
  | { type: 'discard' }
  /** Rewind to `toEntry` with a summary; with `keepAfter` (the last entry collapsed), what follows it is kept verbatim. */
  | { type: 'rewind'; toEntry: string; summary: string; keepAfter?: string }
  | { type: 'offload'; entryId: string; pointer: { text: string; doc?: { id: string; chapter?: string } } }
  | { type: 'restore'; pointerEntryId: string }
  | { type: 'compact'; summary: string }
  | { type: 'end'; status: 'completed' | 'failed'; output?: string }

export interface ToolResult {
  output: Json
  isError?: boolean
  control?: ControlSignal[]
  /**
   * Images for the model to look at, by reference (never the bytes): the history keeps these, and
   * the runner loads the bytes each time it builds a request (e.g. `image.view`).
   */
  images?: ImageRef[]
}

/** Handlers validate their own arguments beyond the minimal schema check. */
export type ToolHandler = (args: any, ctx: ToolContext) => Promise<ToolResult>

export interface RegisteredTool {
  def: ToolDefinition
  handler: ToolHandler
}

/** An employee's (or session's) tool lists. Patterns use `globMatch`: `*` within a segment, `**` across. */
export interface ToolLists {
  allow: string[]
  deny: string[]
}

export interface ToolRegistry {
  /** Throws `ConflictError` if the name (or its provider-safe name) is taken, unless `replace`. */
  register(def: ToolDefinition, handler: ToolHandler, opts?: { replace?: boolean }): void
  /** Returns whether a tool was removed. */
  unregister(name: string): boolean
  get(name: string): RegisteredTool | null
  /** Every definition, sorted by name. */
  list(): ToolDefinition[]
  /** Definitions allowed by the lists, sorted by name: on `allow` and not on `deny`. Nothing is allowed by default. */
  allowed(lists: ToolLists): ToolDefinition[]
  isAllowed(name: string, lists: ToolLists): boolean
  /** OpenAI tool specs for these tools, sorted by name, with provider-safe names. Unknown names throw `NotFoundError`. */
  specs(names: string[]): ToolSpec[]
  /** The provider-safe name of a tool name (`sessions.fork` -> `sessions__fork`). */
  providerName(name: string): string
  /** The registered tool name for a provider-safe name, or null. */
  resolveProviderName(providerName: string): string | null
  /**
   * Runs a tool.
   * - Unknown tool: throws `NotFoundError`.
   * - Arguments that aren't an object, miss a required field or have the wrong top-level type:
   *   returns `{ output: { error }, isError: true }` without calling the handler, so the model can fix them.
   * - Handler errors: returned as `{ output: { error }, isError: true }`, except `MpError`s with code
   *   `denied`, `limit` or `unavailable`, and any error once `ctx.signal` is aborted, which are rethrown
   *   for the runner to handle (policy, pause, retry with backoff, cancellation).
   */
  execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>
}

/** Error codes `execute` rethrows instead of turning into a tool error. */
export const RETHROWN_ERROR_CODES: readonly string[] = ['denied', 'limit', 'unavailable']
