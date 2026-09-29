import { newId } from '@mp/core'
import type { ChatMessage, ModelResponse, ToolCall, ToolSpec, Usage } from './types.ts'

/** Builds a tool definition in the OpenAI `tools` format. */
export function toolSpec(
  name: string,
  description: string,
  parameters: Record<string, unknown> = { type: 'object', properties: {} },
): ToolSpec {
  return { type: 'function', function: { name, description, parameters } }
}

export type ParsedToolArguments = { ok: true; args: Record<string, unknown> } | { ok: false; error: string; raw: string }

/**
 * Parses a tool call's JSON arguments without throwing. An empty string means
 * no arguments (`{}`). Anything that isn't a JSON object is an error.
 */
export function parseToolArguments(call: Pick<ToolCall, 'function'>): ParsedToolArguments {
  const raw = call.function.arguments ?? ''
  if (raw.trim() === '') return { ok: true, args: {} }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: `invalid JSON in tool arguments: ${e instanceof Error ? e.message : String(e)}`, raw }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'tool arguments must be a JSON object', raw }
  }
  return { ok: true, args: value as Record<string, unknown> }
}

/** A fresh tool call id, `call_…`. */
export function newToolCallId(): string {
  return newId('call')
}

/**
 * A model response where everything but the message is optional. The scripted
 * model fills in the rest (usage estimated from lengths, its default model).
 */
export interface PartialModelResponse {
  message: Partial<ChatMessage>
  finishReason?: ModelResponse['finishReason']
  usage?: Partial<Usage>
  model?: string
}

/** An assistant response with plain text. */
export function reply(text: string, usage?: Partial<Usage>): PartialModelResponse {
  return { message: { role: 'assistant', content: text }, finishReason: 'stop', ...(usage ? { usage } : {}) }
}

export interface ToolCallInput {
  name: string
  args?: Record<string, unknown> | string
  /** Defaults to a generated `call_…` id. */
  id?: string
}

/** An assistant response calling tools, optionally with some text before the calls. */
export function callTools(calls: ToolCallInput[], text?: string, usage?: Partial<Usage>): PartialModelResponse {
  const tool_calls: ToolCall[] = calls.map((c) => ({
    id: c.id ?? newToolCallId(),
    type: 'function',
    function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}) },
  }))
  const message: ChatMessage = { role: 'assistant', content: text ?? null, tool_calls }
  return { message, finishReason: 'tool_calls', ...(usage ? { usage } : {}) }
}

/** Rough token estimate: about four characters per token. */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4)
}
