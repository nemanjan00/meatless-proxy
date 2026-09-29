import { answeredInThread, atMostSentences, fail, pass, replyMatches } from '../checks.ts'
import { seedCompany } from '../seed.ts'
import type { Scenario } from '../types.ts'

/** A simple question in #requests gets a short answer in the same thread, not a new top-level message. */
export const answerInThread: Scenario = {
  name: 'answer-in-thread',
  description: 'A simple question gets an answer in the same thread, in a few sentences.',
  async setup(ctx) {
    await seedCompany(ctx)
  },
  async act(ctx) {
    ctx.state.root = await ctx.post('requests', 'What does the Payments project handle?', { as: ctx.state.ben.id })
  },
  checks: [
    answeredInThread(),
    atMostSentences(3),
    replyMatches('on-topic', /refund|invoice|billing|ledger/i),
    {
      name: 'no-top-level-answer',
      async run(ctx) {
        const top = (await ctx.aiMessages()).filter((m) => !m.data.threadId && m.data.channelId === ctx.state.root.data.channelId)
        return top.length ? fail(`posted ${top.length} top-level message(s) in #requests`) : pass('nothing top-level')
      },
    },
  ],
}
