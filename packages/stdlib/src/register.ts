import type { ToolRegistry } from '@mp/tools'
import { createKit } from './kit.ts'
import { registerChatTools } from './tools/chat.ts'
import { registerChecklistTools } from './tools/checklist.ts'
import { registerDirectoryTools } from './tools/directory.ts'
import { registerEnvTools } from './tools/env.ts'
import { registerEventTools } from './tools/events.ts'
import { registerGitTools } from './tools/git.ts'
import { registerKnowledgeTools } from './tools/knowledge.ts'
import { registerSessionTools } from './tools/sessions.ts'
import type { StdlibDeps } from './types.ts'
import { nodeWorktreeFs } from './worktree-fs.ts'

/**
 * Registers every stdlib tool on the registry and returns their names, in
 * registration order. The git tools need `deps.git`, the env tools
 * `deps.containers`; without them those tools aren't registered.
 */
export function registerStdlib(registry: ToolRegistry, deps: StdlibDeps): string[] {
  const kit = createKit(registry, deps)
  registerSessionTools(kit)
  registerChatTools(kit)
  registerEventTools(kit)
  registerDirectoryTools(kit)
  registerKnowledgeTools(kit)
  registerChecklistTools(kit)
  if (deps.git) registerGitTools(kit, deps.git, deps.worktreeFs ?? nodeWorktreeFs())
  if (deps.containers) registerEnvTools(kit, deps.containers)
  return [...kit.names]
}
