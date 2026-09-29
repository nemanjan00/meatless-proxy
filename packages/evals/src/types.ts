import type { Message } from '@mp/chat'
import type { App, Services } from '@mp/server'
import type { Run } from '@mp/sessions'
import type { UsageTotals } from '@mp/usage'

/** The outcome of one check. `reason` says why, in a few words, pass or fail. */
export interface CheckResult {
  pass: boolean
  reason: string
}

/** A check on what happened (tool calls, records, messages), never on exact wording. */
export interface Check {
  name: string
  run(ctx: EvalContext): Promise<CheckResult> | CheckResult
}

/** One eval scenario: seed the knowledge base, do something through the API, and check the outcome. */
export interface Scenario {
  name: string
  /** One line: what it shows. */
  description: string
  /** Seeds contacts, projects, procedures and docs through the services. Store ids in `ctx.state`. */
  setup(ctx: EvalContext): Promise<void>
  /** Posts the request (and any follow-up, settling in between). The runner settles after it. */
  act(ctx: EvalContext): Promise<void>
  checks: Check[]
  /** How long the runs may take to settle (default: the runner's timeout). */
  timeoutMs?: number
}

/** A tool call the model made, as recorded in the run history. */
export interface ToolCall {
  runId: string
  sessionId: string
  /** The tool's name, dotted (`chat.reply`). */
  name: string
  args: Record<string, unknown>
  /** The id of the call (what checklist evidence refers to through its result entry). */
  callId: string
  /** The result, when there is one. */
  output?: unknown
  isError?: boolean
}

/** Everything a scenario can use: the running app and helpers over its API and services. */
export interface EvalContext {
  app: App
  services: Services
  /** Free-form values the setup keeps for the action and the checks. */
  state: Record<string, any>
  /**
   * Posts a message through the HTTP API, as `as` (a contact id; default the
   * deployment's web user). `channel` is a channel name (`requests`) or id.
   */
  post(channel: string, text: string, opts?: { threadId?: string; as?: string }): Promise<Message>
  /** Waits until no run is queued or running and the queues are idle. Throws on timeout. */
  settle(timeoutMs?: number): Promise<void>
  /** The replies in a thread (without the root), oldest first. */
  replies(rootId: string): Promise<Message[]>
  /** Replies in a thread written by the AI (a session or an AI contact). */
  aiReplies(rootId: string): Promise<Message[]>
  /** Every message the AI wrote anywhere. */
  aiMessages(): Promise<Message[]>
  /** Every run, oldest first. */
  runs(): Promise<Run[]>
  /** Every tool call of every run, oldest first, without duplicates. */
  toolCalls(): Promise<ToolCall[]>
  usage(): Promise<UsageTotals>
}
