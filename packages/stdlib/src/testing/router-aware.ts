/**
 * Router-aware scripted-model scripts, for tests of anything built on the stdlib. A router run must record its decision
 * (sessions.commit with a summary) before it finishes (docs/spec.md, "The
 * router context"). Tests that aren't about routing get this for free: when a
 * router run is about to finish without having committed, the wrapper commits a
 * one-line decision first, then gives the answer the test wanted. Mark a script
 * with `raw: true` to test the router flow itself.
 */
import { callTools, type ModelRequest, type ScriptResult } from '@mp/model'

const lastToolName = (req: ModelRequest): string | undefined => {
  const last = req.messages.at(-1)
  if (last?.role !== 'tool') return undefined
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const call = req.messages[i]!.tool_calls?.find((c) => c.id === last.tool_call_id)
    if (call) return call.function.name.replace(/__/g, '.')
  }
  return undefined
}

export const ROUTER_MARK = "You are this employee's router context"
const isFinal = (r: ScriptResult) =>
  !!r && typeof r === 'object' && !(r instanceof Error) && !(r as any).message?.tool_calls?.length

/**
 * A router run must record its decision (sessions.commit with a summary) before it finishes. For
 * scenarios that aren't about routing, this wrapper does what a real router would: when a router
 * run is about to finish without having committed, it commits a one-line decision first, then
 * gives the answer the scenario wanted.
 */
export function routerAwareScript(
  input: ((req: ModelRequest, i: number) => Promise<ScriptResult> | ScriptResult) | ScriptResult[],
) {
  // A list of steps is played in order, like the scripted model does, but only for the wrapped script's own steps.
  let step = 0
  const script = Array.isArray(input) ? () => (step < input.length ? input[step++]! : input.at(-1)!) : input
  const pending: ScriptResult[] = []
  return async (req: ModelRequest, i: number): Promise<ScriptResult> => {
    const router = req.messages.some((m) => m.role === 'system' && (m.content ?? '').includes(ROUTER_MARK))
    if (router && lastToolName(req) === 'sessions.commit' && pending.length) return pending.shift()!
    const r = await script(req, i)
    const committed = req.messages.some((m) =>
      m.tool_calls?.some((c) => c.function.name.replace(/__/g, '.') === 'sessions.commit'),
    )
    if (router && isFinal(r) && !committed) {
      pending.push(r)
      return callTools([{ name: 'sessions.commit', args: { summary: 'test request → handled (scenario)' } }])
    }
    return r
  }
}
