import type { ToolRegistry } from '@mp/tools'
import { createKit } from './kit.ts'
import { registerChatTools } from './tools/chat.ts'
import { registerChecklistTools } from './tools/checklist.ts'
import { registerCodeTools } from './tools/code.ts'
import { registerDirectoryTools } from './tools/directory.ts'
import { registerEnvTools } from './tools/env.ts'
import { registerEventTools } from './tools/events.ts'
import { registerGitTools } from './tools/git.ts'
import { registerImageTools } from './tools/images.ts'
import { registerKnowledgeTools } from './tools/knowledge.ts'
import { registerProjectTools } from './tools/projects.ts'
import { registerSessionTools } from './tools/sessions.ts'
import { registerTimeTools } from './tools/time.ts'
import type { StdlibDeps } from './types.ts'
import { nodeWorktreeFs } from './worktree-fs.ts'

/**
 * Registers every stdlib tool on the registry and returns their names, in
 * registration order. The git tools need `deps.git`, the env tools
 * `deps.containers`, the code tools `deps.sandbox`, projects.create_local `deps.localProjects`; without them those tools aren't registered.
 */
export function registerStdlib(registry: ToolRegistry, deps: StdlibDeps): string[] {
  const kit = createKit(registry, deps)
  registerSessionTools(kit)
  registerChatTools(kit)
  registerEventTools(kit)
  registerDirectoryTools(kit)
  registerKnowledgeTools(kit)
  registerChecklistTools(kit)
  registerTimeTools(kit)
  registerImageTools(kit)
  if (deps.localProjects) registerProjectTools(kit, deps.localProjects)
  if (deps.git) registerGitTools(kit, deps.git, deps.worktreeFs ?? nodeWorktreeFs())
  if (deps.containers) registerEnvTools(kit, deps.containers)
  if (deps.sandbox) registerCodeTools(kit, deps.sandbox)
  return [...kit.names]
}
