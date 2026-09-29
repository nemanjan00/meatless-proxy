import { Hono } from 'hono'
import type { ChatVisibility } from '../auth/visibility.ts'
import type { Services } from '../services.ts'
import { memoryRoutes } from './memories.ts'
import { peopleRoutes } from './people.ts'
import { skillRoutes } from './skills.ts'

export { KNOWLEDGE_GUARD_RULES } from './guard-rules.ts'
export { canChangeMemory, canSeeMemory, canSeeMemoryRecord, type MemoryViewer } from './memory-access.ts'
export { MemoryViews, defineCorrectionField } from './memories.ts'
export { PeopleViews, sendSignInDm } from './people.ts'
export { SKILL_RECENT_MS, SkillViews } from './skills.ts'
export { USE_KIND, recordUse, registerKnowledgeUse, usesOf } from './use.ts'

/**
 * Memory, skills and people (docs/spec.md "Web UI › Memory", "Skills" and "People"): typed views
 * over the memory, skill and contact records for their pages. See `@mp/api` knowledge.ts.
 */
export function knowledgeRoutes(s: Services, vis: ChatVisibility): Hono {
  const app = new Hono()
  app.route('/', memoryRoutes(s, vis))
  app.route('/', skillRoutes(s))
  app.route('/', peopleRoutes(s, vis))
  return app
}
