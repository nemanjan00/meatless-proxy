import { ManualClock, NotFoundError, createEventBus, createHooks, memoryLogger, newId, type Json } from '@mp/core'
import { createChat } from '@mp/chat'
import { createChecklists } from '@mp/checklists'
import { fakeRuntime } from '@mp/containers'
import { createDirectory } from '@mp/directory'
import { createEvents } from '@mp/events'
import { createFiles } from '@mp/files'
import { fakeGitCache } from '@mp/git'
import { createMemory } from '@mp/memory'
import { createDocs, createRecords } from '@mp/records'
import { createSandbox, fakeSandboxRuntime } from '@mp/sandbox'
import { createSessions } from '@mp/sessions'
import { createSkills } from '@mp/skills'
import { memoryStore } from '@mp/store'
import { createToolRegistry, type ToolContext } from '@mp/tools'
import { createUsage } from '@mp/usage'
import { DEFAULT_TOOLSET, registerStdlib, type StdlibDeps, type WorktreeFs } from '../src/index.ts'

export const REPO = 'https://github.com/acme/billing.git'

/** A worktree filesystem in memory that also tells the fake git cache about writes. */
export function memoryWorktreeFs(onWrite: (root: string, rel: string, content: string) => void) {
  const files = new Map<string, string>()
  const fs: WorktreeFs & { files: Map<string, string> } = {
    files,
    async read(root, rel) {
      const v = files.get(`${root}/${rel}`)
      if (v === undefined) throw new NotFoundError('file', rel)
      return v
    },
    async write(root, rel, content) {
      files.set(`${root}/${rel}`, content)
      onWrite(root, rel, content)
    },
    async list(root, rel) {
      const prefix = rel ? `${root}/${rel}/` : `${root}/`
      const out = new Map<string, 'file' | 'dir'>()
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue
        const rest = k.slice(prefix.length).split('/')
        out.set(rest[0]!, rest.length > 1 ? 'dir' : 'file')
      }
      return [...out].map(([name, type]) => ({ name, type }))
    },
  }
  return fs
}

export interface StackOptions {
  git?: boolean
  containers?: boolean
  /** The code.run sandbox (on a fake runtime whose kernels run JavaScript). Default on. */
  sandbox?: boolean
  defaults?: StdlibDeps['config']['defaults']
  /** Replaces the default `enqueueRun` (which only records ids). */
  enqueueRun?: (runId: string) => Promise<void>
}

export async function stack(opts: StackOptions = {}) {
  const clock = new ManualClock(Date.UTC(2026, 8, 29, 9))
  const bus = createEventBus()
  const store = memoryStore({ bus })
  const records = createRecords({ store, bus })
  const docs = createDocs(records)
  const directory = createDirectory({ records })
  const sessions = createSessions({ records, clock, bus })
  const events = createEvents({ records, clock, bus })
  const chat = createChat({
    records,
    events,
    clock,
    bus,
    resolveName: async (name) => {
      const emp = await directory.employees.byHandle(name)
      if (emp) return { type: 'employee', employeeId: emp.id, contactId: emp.data.contactId }
      const c = await directory.contacts.byHandle('mp', name)
      return c ? { type: 'person', contactId: c.id } : null
    },
    resolveSessionSlug: async (employeeId, slug) => (await sessions.bySlug(employeeId, slug))?.id ?? null,
  })
  const memory = createMemory({ records, clock })
  const skills = createSkills({ records })
  const files = createFiles({ records })
  const checklists = createChecklists({ records, sessions, clock, bus })
  const usage = createUsage({ records, clock, bus })
  const git = fakeGitCache()
  const containers = fakeRuntime({ clock })
  const sandboxRuntime = fakeSandboxRuntime({ clock })
  const sandbox = createSandbox({ runtime: sandboxRuntime, files, image: 'mp-sandbox:test', clock, reapIntervalMs: 0 })
  const tools = createToolRegistry()
  const hooks = createHooks()
  const logger = memoryLogger()
  const enqueued: string[] = []
  const woken: string[] = []
  const worktreeFs = memoryWorktreeFs((root, rel, content) => git.writeFile(root, rel, content))

  const deps: StdlibDeps = {
    records,
    docs,
    sessions,
    events,
    chat,
    directory,
    memory,
    skills,
    files,
    checklists,
    usage,
    ...(opts.git === false ? {} : { git }),
    ...(opts.containers === false ? {} : { containers }),
    ...(opts.sandbox === false ? {} : { sandbox }),
    enqueueRun:
      opts.enqueueRun ??
      (async (id) => {
        enqueued.push(id)
      }),
    wakeRun: async (id) => {
      woken.push(id)
      return false
    },
    clock,
    logger,
    bus,
    config: {
      worktreesRoot: '/wt',
      pushPolicy: { allow: ['mp/**'], protected: ['main', 'master', 'release/**'] },
      ...(opts.defaults ? { defaults: opts.defaults } : {}),
    },
    worktreeFs,
  }
  const names = registerStdlib(tools, deps)

  const employee = await directory.employees.create({
    name: 'Billing Bot',
    personality: 'Dry humour. Signs off with a tidy commit message.',
    toolAllow: ['**'],
    git: { name: 'Billing Bot', email: 'billing-bot@example.com' },
  })
  const ana = await directory.contacts.create({
    name: 'Ana Lima',
    handles: [{ system: 'mp', id: 'ana' }],
    email: 'ana@example.com',
    role: 'Backend engineer',
  })
  const project = await directory.projects.create({
    name: 'Billing',
    aliases: ['payments'],
    description: 'Invoices and payments.',
    repositories: [{ url: REPO, defaultBranch: 'main' }],
  })
  await directory.projects.setOwner(project.id, ana.id)

  const newSession = (title = 'Work', employeeId = employee.id) =>
    sessions.create({
      employeeId,
      title,
      toolset: [...DEFAULT_TOOLSET],
      entries: [{ kind: 'system', content: { text: `You are ${title}.` } }],
    })

  /** A running run in a session, like the runner would have. */
  const startRun = async (sessionId: string, text = 'do it', requesterId?: string) => {
    const run = await sessions.createRun({
      sessionId,
      cause: { type: 'manual' },
      ...(requesterId ? { requesterId } : {}),
      input: [{ kind: 'user', content: { text } }],
    })
    return sessions.transition(run.id, 'queued', 'running')
  }

  const session = await newSession()
  const run = await startRun(session.id, 'do it', ana.id)

  const ctxFor = (sessionId: string, runId: string, over: Partial<ToolContext> = {}): ToolContext => {
    const callId = over.callId ?? newId('call')
    return {
      employeeId: employee.id,
      sessionId,
      runId,
      callId,
      idempotencyKey: `${runId}:0:${callId}`,
      requesterId: ana.id,
      secrets: {},
      signal: new AbortController().signal,
      logger,
      clock,
      emit: () => {},
      ...over,
    }
  }
  const ctx = (over: Partial<ToolContext> = {}) => ctxFor(session.id, run.id, over)

  /** Calls a tool as the main session's run. */
  const call = (name: string, args: unknown = {}, c: ToolContext = ctx()) => tools.execute(name, args, c)
  /** Calls a tool and returns its output, failing the test on a tool error. */
  const out = async (name: string, args: unknown = {}, c: ToolContext = ctx()): Promise<any> => {
    const r = await call(name, args, c)
    if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.output)}`)
    return r.output
  }
  /** Appends an assistant tool call and its result to a run, like the runner does. Returns the tool call id. */
  const recordCall = async (runId: string, name: string, output: Json, isError = false) => {
    const id = newId('call')
    await sessions.append(runId, { kind: 'assistant', content: { text: null, toolCalls: [{ id, name, arguments: '{}' }] } })
    const entry = await sessions.append(runId, {
      kind: 'tool_result',
      content: { toolCallId: id, name, output, ...(isError ? { isError: true } : {}) },
    })
    return { callId: id, entryId: entry.id }
  }

  return {
    clock,
    bus,
    store,
    records,
    docs,
    directory,
    sessions,
    events,
    chat,
    memory,
    skills,
    files,
    checklists,
    usage,
    git,
    containers,
    sandbox,
    sandboxRuntime,
    tools,
    hooks,
    logger,
    deps,
    names,
    enqueued,
    woken,
    worktreeFs,
    employee,
    ana,
    project,
    session,
    run,
    newSession,
    startRun,
    ctx,
    ctxFor,
    call,
    out,
    recordCall,
  }
}

export type Stack = Awaited<ReturnType<typeof stack>>
