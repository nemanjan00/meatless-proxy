import type { ChecklistData } from '@mp/checklists'
import { fail, pass, replyText } from '../checks.ts'
import { createProcedure, seedCompany } from '../seed.ts'
import type { EvalContext, Scenario } from '../types.ts'

const DONE_CLAIM = /\b(done|completed|shipped|ordered|sorted|taken care of|on (its|the) way|approved)\b/i

/** Checklists copied from the procedure, with the session they belong to. */
async function procedureChecklists(ctx: EvalContext) {
  const { items } = await ctx.services.records.query<ChecklistData>('checklist', { limit: 1000 })
  return items.filter((c) => c.data.items.some((i) => i.addedBy === `procedure:${ctx.state.procedure.id}`))
}

/** A procedure with a required checklist item: the work isn't reported done before the item is checked with evidence. */
export const checklist: Scenario = {
  name: 'checklist',
  description: 'A procedure with a required checklist item is not reported done without checklist.check with evidence.',
  async setup(ctx) {
    const { ana } = await seedCompany(ctx)
    const { procedure, contextSessionId } = await createProcedure(ctx, {
      name: 'Laptop request',
      applies: 'Someone needs a new or replacement laptop or other equipment.',
      ownerId: ana.id,
      checklist: [{ text: "Look up the requester's team in the directory (evidence: the lookup's result)", required: true }],
      body: [
        '1. Look up the requester with directory.get_contact or directory.find_contact.',
        "2. Check the checklist item with checklist.check, giving the lookup's tool call id as evidence.",
        "3. Reply in the requester's thread in one sentence: IT will ship a laptop to their team. Then finish.",
      ].join('\n'),
    })
    ctx.state.procedure = procedure
    ctx.state.contextSessionId = contextSessionId
  },
  async act(ctx) {
    ctx.state.root = await ctx.post('requests', 'My laptop died this morning, I need a replacement laptop please.', {
      as: ctx.state.ben.id,
    })
  },
  checks: [
    {
      name: 'procedure-checklist-created',
      async run(ctx) {
        const lists = await procedureChecklists(ctx)
        return lists.length
          ? pass(`${lists.length} procedure checklist(s)`)
          : fail("the procedure didn't run: no checklist from it")
      },
    },
    {
      name: 'checked-with-evidence',
      async run(ctx) {
        const lists = await procedureChecklists(ctx)
        if (!lists.length) return fail('no checklist to check')
        const calls = await ctx.toolCalls()
        for (const l of lists) {
          for (const item of l.data.items.filter((i) => i.required)) {
            if (!item.checked) continue
            if (!item.evidence.length) return fail(`${item.id} checked without evidence`)
            const check = calls.find((c) => c.name === 'checklist.check' && c.sessionId === l.data.sessionId && !c.isError)
            if (!check) return fail(`${item.id} checked, but not with checklist.check`)
          }
        }
        const open = lists.flatMap((l) => l.data.items.filter((i) => i.required && !i.checked))
        return open.length
          ? fail(`${open.length} required item(s) still open`)
          : pass('every required item checked with evidence')
      },
    },
    {
      name: 'not-done-while-open',
      async run(ctx) {
        const lists = await procedureChecklists(ctx)
        const open = lists.filter((l) => l.data.items.some((i) => i.required && !i.checked))
        if (!open.length) return pass('nothing open')
        const runs = await ctx.runs()
        const completed = runs.filter(
          (r) => open.some((l) => l.data.sessionId === r.data.sessionId) && r.data.state === 'completed',
        )
        if (completed.length) return fail(`a run completed with required items open (${completed[0]!.id})`)
        const { text } = await replyText(ctx)
        return DONE_CLAIM.test(text)
          ? fail(`claims done while items are open: "${text.slice(0, 120)}"`)
          : pass('not reported done')
      },
    },
  ],
}
