import { fail, pass, replyText } from '../checks.ts'
import { seedCompany } from '../seed.ts'
import type { Scenario } from '../types.ts'

/** A follow-up in the thread reaches the session that answered the first question, and is answered in the thread. */
export const followUp: Scenario = {
  name: 'follow-up',
  description: 'A follow-up reply reaches the same session and is answered in the thread.',
  async setup(ctx) {
    await seedCompany(ctx)
  },
  async act(ctx) {
    const as = ctx.state.ben.id
    ctx.state.root = await ctx.post('requests', 'Who owns the Payments project?', { as })
    await ctx.settle()
    ctx.state.firstReplies = (await ctx.aiReplies(ctx.state.root.id)).map((m) => m.id)
    ctx.state.followUp = await ctx.post('requests', 'And what is her role?', { as, threadId: ctx.state.root.id })
  },
  checks: [
    {
      name: 'first-answered',
      run: (ctx) =>
        ctx.state.firstReplies.length ? pass('the first question was answered') : fail('no answer to the first question'),
    },
    {
      name: 'follow-up-answered-in-thread',
      async run(ctx) {
        const after = (await ctx.aiReplies(ctx.state.root.id)).filter((m) => m.id > ctx.state.followUp.id)
        return after.length
          ? pass(`${after.length} repl${after.length === 1 ? 'y' : 'ies'} after the follow-up`)
          : fail('no reply after the follow-up')
      },
    },
    {
      name: 'same-session',
      async run(ctx) {
        const replies = await ctx.aiReplies(ctx.state.root.id)
        const first = replies.find((m) => m.id < ctx.state.followUp.id)
        const later = replies.find((m) => m.id > ctx.state.followUp.id)
        if (!first || !later) return fail('needs a reply before and after the follow-up')
        const a = first.data.author
        const b = later.data.author
        return a.kind === b.kind && a.id === b.id
          ? pass(`both answered by ${a.kind} ${a.id}`)
          : fail(`answered by ${a.kind} ${a.id}, then by ${b.kind} ${b.id}`)
      },
    },
    {
      name: 'follow-up-on-topic',
      async run(ctx) {
        const { replies } = await replyText(ctx)
        const text = replies
          .filter((m) => m.id > ctx.state.followUp.id)
          .map((m) => m.data.text)
          .join('\n')
        return /staff engineer/i.test(text) ? pass('names her role') : fail(`doesn't name the role: "${text.slice(0, 120)}"`)
      },
    },
  ],
}
