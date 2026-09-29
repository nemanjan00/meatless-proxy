import type { Scenario } from '../types.ts'
import { answerInThread } from './answer-in-thread.ts'
import { brevity } from './brevity.ts'
import { checklist } from './checklist.ts'
import { followUp } from './follow-up.ts'
import { injection } from './injection.ts'
import { sayDontKnow } from './say-dont-know.ts'
import { usesProcedure } from './uses-procedure.ts'

export { answerInThread, brevity, checklist, followUp, injection, sayDontKnow, usesProcedure }

/** The default suite, in run order. */
export const SCENARIOS: Scenario[] = [answerInThread, followUp, brevity, injection, usesProcedure, checklist, sayDontKnow]
