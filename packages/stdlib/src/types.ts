/**
 * The contract between the standard library and the composition root. The
 * server builds `StdlibDeps` and calls `registerStdlib` and `registerPolicies`.
 */
import type { Clock, EventBus, Logger } from '@mp/core'
import type { Checklists } from '@mp/checklists'
import type { Chat, ChatAttachments, ImageDescriber } from '@mp/chat'
import type { ContainerRuntime } from '@mp/containers'
import type { Directory, EmployeeNetwork } from '@mp/directory'
import type { Events, ScheduledTasks } from '@mp/events'
import type { FilesService } from '@mp/files'
import type { GitCache, PushPolicy } from '@mp/git'
import type { MemoryService } from '@mp/memory'
import type { Docs, Records } from '@mp/records'
import type { Sandbox } from '@mp/sandbox'
import type { Sessions } from '@mp/sessions'
import type { SkillsService } from '@mp/skills'
import type { Actor } from '@mp/store'
import type { UsageService } from '@mp/usage'

export interface StdlibDeps {
  /**
   * The employee's full toolset (its allow and deny lists applied to every registered tool). Work a router
   * context starts gets this instead of the router's routing-only toolset. Optional: without it, new
   * sessions copy the caller's toolset.
   */
  toolsetFor?: (employeeId: string) => Promise<string[]>
  records: Records
  docs: Docs
  sessions: Sessions
  events: Events
  chat: Chat
  directory: Directory
  memory: MemoryService
  skills: SkillsService
  files: FilesService
  checklists: Checklists
  usage: UsageService
  /** Chat image attachments. Optional: without it chat.post and chat.reply take no attachments. */
  attachments?: ChatAttachments
  /**
   * Whether the model can see images (`MODEL_VISION`), with image.view's limits: images are
   * downscaled to `maxSide` pixels (PNG; default 1568) and refused over `maxBytes` (default 5 MB).
   * Off (the default): image.view says so.
   */
  vision?: { enabled: boolean; maxSide?: number; maxBytes?: number }
  /**
   * Saved image descriptions (`IMAGE_DESCRIBE`): image.view makes one on the first look (and returns
   * it, or only it with `describe_only`), chat.read on request. Optional: without it images have no
   * descriptions.
   */
  describer?: ImageDescriber
  /** Optional: without them the git and env tools aren't registered. */
  git?: GitCache
  containers?: ContainerRuntime
  /** Runs code for `code.run` (Python and Node kernels in a sandbox container). Optional: without it the code tools aren't registered. */
  sandbox?: Sandbox
  /**
   * The employee's SSH private key (its `SSH_PRIVATE_KEY` secret), used for git fetches and pushes
   * for the duration of each command. Optional: without it git runs with the harness's own credentials.
   */
  sshKeyFor?: (employeeId: string) => Promise<string | undefined>
  /**
   * Creates a project on a new repository the harness hosts itself (`local:<slug>`), with the employee as a
   * member (`projects.create_local`). Optional: without it that tool isn't registered.
   */
  localProjects?: {
    create(input: {
      name: string
      description?: string
      employeeId: string
      actor: Actor
    }): Promise<{ projectId: string; name: string; url: string; defaultBranch: string }>
    /** A local repository's branches (by slug), each with how far ahead of and behind the default branch it is. */
    branches?(slug: string): Promise<{
      defaultBranch: string
      branches: { name: string; sha: string; ahead: number; behind: number; subject: string; author: string; date: string }[]
    }>
    /** A directory of a ref of a local repository (default: its default branch); `path` relative to the root. */
    tree?(
      slug: string,
      opts?: { ref?: string; path?: string },
    ): Promise<{ path: string; ref: string; entries: { name: string; type: 'file' | 'dir'; size?: number }[] }>
    /** A file of a ref of a local repository. Binary files and files over `maxBytes` come without content. */
    readFile?(
      slug: string,
      opts: { ref?: string; path: string; maxBytes?: number },
    ): Promise<{ path: string; ref: string; size: number; binary: boolean; tooLarge: boolean; content: string | null }>
  }
  /**
   * The company timezone (an IANA name, the `timezone` setting), used by `time.now` when the call
   * names none. Optional: without it, or when it returns nothing, `UTC`.
   */
  defaultTimezone?: () => Promise<string | undefined>
  /**
   * Scheduled tasks and follow-ups (`schedule.*`, `sessions.follow_up`). Optional: without it the stdlib
   * keeps them over `records` itself (the same records, so the server's scheduler still sees them).
   */
  scheduledTasks?: ScheduledTasks
  /** Queues a run for execution (the server wires it to the runner). */
  enqueueRun: (runId: string, opts?: { priority?: number }) => Promise<void>
  /** Wakes a suspended run if its wait is satisfied. */
  wakeRun: (runId: string) => Promise<boolean>
  clock: Clock
  logger: Logger
  bus?: EventBus
  config: StdlibConfig
  /**
   * Reads and writes files inside session worktrees (`git.read_file`,
   * `git.write_file`, `git.list_files`). Default: the local filesystem
   * (`nodeWorktreeFs`). Paths are checked to stay inside the worktree before
   * this is called.
   */
  worktreeFs?: WorktreeFs
}

/** File access inside a worktree. `rel` is a normalized relative POSIX path (`''` is the root). */
export interface WorktreeFs {
  read(root: string, rel: string): Promise<string>
  write(root: string, rel: string, content: string): Promise<void>
  /** Sets or clears a file's executable bits (git records them). Optional: without it, modes stay as they are. */
  setExecutable?(root: string, rel: string, executable: boolean): Promise<void>
  list(root: string, rel: string): Promise<{ name: string; type: 'file' | 'dir' }[]>
}

/**
 * How an employee turns "real forks" into tasks in its task system, stored in
 * `employee.taskSystem`. The task is created by calling a registered tool
 * (usually an MCP tool such as `mcp.linear.create_issue`).
 */
export interface TaskSystemConfig {
  /** The registered tool name, e.g. `mcp.linear.create_issue`. Or give `server` + `createTool`. */
  tool?: string
  server?: string
  createTool?: string
  /** Fixed arguments merged into every call, e.g. `{ teamId: 'T1' }`. */
  args?: Record<string, unknown>
  /** Argument names for the title and description. Default `title` and `description`. */
  titleArg?: string
  descriptionArg?: string
  /** Argument name for the parent task id, when the loop names one (`parentTaskId`). */
  parentArg?: string
  /** Where the created task's id is in the tool output (dot path). Default: `id`, then `identifier`. */
  idPath?: string
  /** Subject system for subscribing to the task. Default: `server`, or the tool name's second segment. */
  subjectSystem?: string
}

export interface StdlibConfig {
  /** Where session worktrees are created: `<worktreesRoot>/<sessionId>/<repo key>`. */
  worktreesRoot: string
  /** Branches employees may push to, and never push to. */
  pushPolicy: PushPolicy
  /**
   * Hosts environments and sandboxes may reach when neither the employee's `network` setting nor the
   * session's project names any (`DEFAULT_EGRESS`). Default: none.
   */
  defaultEgress?: string[]
  /**
   * Whether an employee's `direct` network setting gives a real, unproxied network
   * (`DOCKER_DIRECT_NETWORK`). Default true; false turns it into no network.
   */
  directNetwork?: boolean
  /** The network setting of an employee that has none (`DEFAULT_NETWORK`). Default `project`. */
  defaultNetwork?: EmployeeNetwork
  /** Environment profiles env.up offers by name (`ENV_PROFILES`). Default: `DEFAULT_ENV_PROFILES`. */
  envProfiles?: import('./env-profiles.ts').EnvProfile[]
  /**
   * The profile env.up uses when neither the call, the project nor a Dockerfile in the checkout
   * says (`ENV_DEFAULT_PROFILE`). Default `default`.
   */
  envDefaultProfile?: string
  /**
   * Where the employee files are on disk, one directory per employee (`<filesDir>/<employeeId>`, the
   * files volume's `FILES_DIR`). env.up mounts the employee's own at /files. Optional: without it (files
   * kept elsewhere) environments have no /files.
   */
  filesDir?: string
  /**
   * Fork limits used when neither the usage service's defaults nor a limit record sets them. The
   * server passes its defaults to `@mp/usage` instead. `maxConcurrentSessions` is enforced by the runner.
   */
  defaults?: { maxFanOut?: number; maxDepth?: number; maxConcurrentSessions?: number }
  /**
   * Tools on demand (`TOOLS_ON_DEMAND`): sessions are offered their everyday tools and load the rest with
   * tools.find and tools.load, and the employee prompt lists what can be loaded. Default true; false
   * registers neither tool, and sessions are offered every tool of their toolset.
   */
  toolsOnDemand?: boolean
}

export interface PolicyConfig {
  /** A run that committed code must update docs (or say why not). Default true. */
  docsMaintenance?: boolean
  /** A run can't complete while required checklist items are open. Default true. */
  checklistGate?: boolean
  /** A router context's ephemeral runs must commit a one-line decision summary. Default true. */
  routerDecisions?: boolean
  /** Post a run's final answer in the chat thread it was asked in, if it didn't reply itself. Default true. */
  answerWhereAsked?: boolean
  /** Commit uncommitted worktree changes when a run ends. Default true. */
  commitOnStop?: boolean
  /** A run must update its session document before finishing. Default false. */
  sessionDocument?: boolean
  /** Messages between employees in a thread without a person, before deliveries pause. Default 20. */
  maxAiStreak?: number
}
