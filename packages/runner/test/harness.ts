import { createEventBus, createHooks, type Json } from '@mp/core'
import { scriptedModel, type Script } from '@mp/model'
import { memoryQueue } from '@mp/queue'
import { createRecords } from '@mp/records'
import { memorySecretStore } from '@mp/secrets'
import { createSessions } from '@mp/sessions'
import { memoryStore } from '@mp/store'
import { createToolRegistry, type ToolDefinition, type ToolHandler } from '@mp/tools'
import { createRunner, RUNS_QUEUE, type RunnerOptions } from '../src/index.ts'

export function harness(script: Script, extra: Partial<RunnerOptions> = {}) {
  const bus = createEventBus()
  const store = memoryStore({ bus })
  const records = createRecords({ store, bus })
  const sessions = createSessions({ records, bus })
  const tools = createToolRegistry()
  const model = scriptedModel(script)
  const queue = memoryQueue({ bus })
  const hooks = createHooks()
  const secrets = memorySecretStore()
  const runner = createRunner({
    sessions,
    tools,
    model,
    queue,
    hooks,
    secrets,
    bus,
    toolListsFor: async () => ({ allow: ['**'], deny: [] }),
    ...extra,
  })
  const tool = (def: Partial<ToolDefinition> & { name: string }, handler: ToolHandler) =>
    tools.register(
      {
        description: def.name,
        parameters: { type: 'object', properties: {} },
        effect: 'read',
        source: 'stdlib',
        ...def,
      },
      handler,
    )
  const session = (toolset: string[] = [], title = 'Work') =>
    sessions.create({
      employeeId: 'emp_test',
      title,
      toolset,
      entries: [{ kind: 'system', content: { text: 'You are a test employee.' } }],
    })
  const start = async (sessionId: string, text = 'do it', mode?: 'continuing' | 'ephemeral') =>
    sessions.createRun({
      sessionId,
      cause: { type: 'manual' },
      ...(mode ? { mode } : {}),
      input: [{ kind: 'user', content: { text } as Json }],
    })
  /** Processes the runs queue with the runner until idle. */
  const work = () =>
    queue.process<{ runId: string }>(RUNS_QUEUE, async (job) => void (await runner.execute(job.data.runId)), { concurrency: 4 })
  return { bus, store, records, sessions, tools, model, queue, hooks, secrets, runner, tool, session, start, work }
}
