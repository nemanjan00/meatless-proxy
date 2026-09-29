import { answeredInThread, replyMatches, underWords } from '../checks.ts'
import { seedCompany } from '../seed.ts'
import type { Scenario } from '../types.ts'

/** A yes/no-sized question gets a yes/no-sized answer. */
export const brevity: Scenario = {
  name: 'brevity',
  description: 'The answer to a simple question is under 80 words.',
  async setup(ctx) {
    await seedCompany(ctx)
  },
  async act(ctx) {
    ctx.state.root = await ctx.post('requests', 'Does Payments run on Postgres or MySQL?', { as: ctx.state.ben.id })
  },
  checks: [answeredInThread(), underWords(80), replyMatches('correct', /postgres/i)],
}
