/** OpenAI-compatible Chat Completions shapes, the standard inside the harness. */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: ChatRole
  content: string | null
  name?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
  /** Kimi and others return their reasoning separately. Kept so history round-trips. */
  reasoning_content?: string
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

export interface ModelClient {
  readonly defaultModel: string
  complete(req: ModelRequest): Promise<ModelResponse>
}

export const emptyUsage = (): Usage => ({
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
})
