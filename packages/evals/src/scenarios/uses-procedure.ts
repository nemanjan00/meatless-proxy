import { answeredInThread, fail, pass } from '../checks.ts'
import { createProcedure, seedCompany } from '../seed.ts'
import type { Scenario } from '../types.ts'

/** With a procedure for access requests, an access request is routed to the procedure (a fork of its context). */
export const usesProcedure: Scenario = {
  name: 'uses-procedure',
  description: 'An access request leads to procedures.run or a fork of the procedure context.',
  async setup(ctx) {
    const { ana, payments } = await seedCompany(ctx)
    const { procedure, contextSessionId } = await createProcedure(ctx, {
      name: 'Access request',
      applies: 'Someone asks for access to a system, repository, tool or environment.',
      ownerId: ana.id,
      projectIds: [payments.id],
      body: [
        '1. Note who needs access to what, and why.',
        "2. The project's owner approves: this instance only records the request, it does not grant access.",
        "3. Reply in the requester's thread in one or two sentences: the request is logged and waits for the owner's approval. Then finish.",
      ].join('\n'),
    })
    ctx.state.procedure = procedure
    ctx.state.contextSessionId = contextSessionId
  },
  async act(ctx) {
    ctx.state.root = await ctx.post(
      'requests',
      'Can I get write access to the Payments git repository? I am starting on the refunds work.',
      {
        as: ctx.state.ben.id,
      },
    )
  },
  checks: [
    {
      name: 'procedure-used',
      async run(ctx) {
        const run = (await ctx.toolCalls()).find((c) => c.name === 'procedures.run')
        const forks = await ctx.services.sessions.children(ctx.state.contextSessionId)
        if (run && forks.length) return pass(`procedures.run forked the context (${forks.length} fork)`)
        if (forks.length) return pass(`the procedure context was forked (${forks.length})`)
        const used = [...new Set((await ctx.toolCalls()).map((c) => c.name))]
        return fail(`no fork of the procedure context; tools used: ${used.join(', ') || 'none'}`)
      },
    },
    answeredInThread(),
  ],
}
