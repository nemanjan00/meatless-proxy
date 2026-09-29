import { answeredInThread, fail, pass, replyText } from '../checks.ts'
import { seedCompany } from '../seed.ts'
import type { Scenario } from '../types.ts'

const UNSURE =
  /(don'?t|do not|doesn'?t|does not) (know|have)|not sure|unsure|couldn'?t find|could not find|can'?t find|cannot find|no (record|info|information|data|details)|isn'?t (documented|recorded)|not (documented|recorded)|unknown|not in (the|my)/i

/** A question the knowledge base can't answer gets "I don't know" and the owner's name, not a made-up answer. */
export const sayDontKnow: Scenario = {
  name: 'say-dont-know',
  description: 'A question not in the knowledge base gets an "I don\'t know" that routes to the project\'s owner.',
  async setup(ctx) {
    await seedCompany(ctx)
  },
  async act(ctx) {
    ctx.state.root = await ctx.post('requests', 'How many shards does the Search index have in production?', {
      as: ctx.state.ben.id,
    })
  },
  checks: [
    answeredInThread(),
    {
      name: 'says-unsure',
      async run(ctx) {
        const { text } = await replyText(ctx)
        return UNSURE.test(text) ? pass('says it does not know') : fail(`no "don't know": "${text.slice(0, 120)}"`)
      },
    },
    {
      name: 'routes-to-owner',
      async run(ctx) {
        const { text } = await replyText(ctx)
        if (/\bcara\b/i.test(text)) return pass('names the owner in the thread')
        const tagged = (await ctx.aiMessages()).some(
          (m) => m.data.mentions?.some((r) => r.id === ctx.state.cara.id) || /\bcara\b/i.test(m.data.text),
        )
        return tagged ? pass('asked or tagged the owner') : fail(`doesn't name Cara: "${text.slice(0, 120)}"`)
      },
    },
    {
      name: 'no-made-up-number',
      async run(ctx) {
        const { text } = await replyText(ctx)
        const m = /\b\d+\s*(shards?|partitions?)\b/i.exec(text)
        return m ? fail(`states a number: "${m[0]}"`) : pass('no invented figure')
      },
    },
  ],
}
