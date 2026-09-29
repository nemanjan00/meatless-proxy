/** OpenAI-compatible Chat Completions shapes, the standard inside the harness. */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/**
 * Where an image in a history comes from. Histories keep this reference, never the bytes: the
 * runner loads the bytes when it builds a request, and `sha256` makes sure they are the same bytes
 * every time (a changed or missing image is shown as "[image no longer available]").
 */
export interface ImageRef {
  /** A chat attachment (`id`), or a file in an employee's filesystem (`owner` + `path`). */
  source: 'attachment' | 'file'
  id?: string
  owner?: string
  path?: string
  /** Of the original bytes. */
  sha256: string
  name: string
  mime: string
  width?: number
  height?: number
}

/**
 * An image in a message: `data` (base64) once loaded, or only a `ref` before that. A provider
 * adapter sends the ones with `data`; the rest become a short text note.
 */
export interface ImagePart {
  type: 'image'
  mime: string
  data?: string
  ref?: ImageRef
  name?: string
  width?: number
  height?: number
}

export interface ChatMessage {
  role: ChatRole
  content: string | null
  name?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  /** Kimi and others return their reasoning separately. Kept so history round-trips. */
  reasoning_content?: string
  /**
   * Images that go with a `user` or `tool` message, after its text. Chat Completions only takes
   * images in user messages, so adapters move a tool result's images into a user message after it.
   */
  images?: ImagePart[]
}

export interface ToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  /** Prompt tokens served from the provider's cache. */
  cachedTokens: number
  /** Completion tokens spent on reasoning (part of completionTokens). */
  reasoningTokens: number
  totalTokens: number
}

export interface ModelDelta {
  content?: string
  reasoning?: string
}

export interface ModelRequest {
  /** Defaults to the client's default model. */
  model?: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  /** Called with streamed output as it arrives, if the implementation streams. */
  onDelta?: (delta: ModelDelta) => void
}

export interface ModelResponse {
  /** Always role `assistant`. */
  message: ChatMessage
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | string
  usage: Usage
  model: string
}

/** What a model can do, as far as the provider says. */
export interface ModelCapabilities {
  /** Whether it accepts image input. Undefined when the provider doesn't say. */
  vision?: boolean
}

export interface ModelClient {
  readonly defaultModel: string
  complete(req: ModelRequest): Promise<ModelResponse>
  /** Optional: what the provider says a model (default: the default model) can do; null when it doesn't say. */
  capabilities?(model?: string): Promise<ModelCapabilities | null>
}

export const emptyUsage = (): Usage => ({
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
})
