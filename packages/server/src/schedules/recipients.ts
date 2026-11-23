import { errorMessage, type Logger, silentLogger } from '@mp/core'
import { type ScheduledTasks, scheduledTaskId } from '@mp/events'
import type { RecipientResolver } from '@mp/router'
import type { Sessions } from '@mp/sessions'

export interface ScheduledRecipientsOptions {
  sessions: Sessions
  /** The employee's full toolset now: what a task's session was given when it was made. */
  toolsetFor: (employeeId: string) => Promise<string[]>
  logger?: Logger
}

/**
 * A scheduled task's firing (`scheduled_task.fired`) goes to the session the task runs in, as a direct
 * delivery: trusted (a person or the employee itself set it up) and expected to act, in a continuing
 * run. A task in `fresh` mode gets a new fork of its session per firing. A task that was deleted gets
 * no delivery, and the scheduler's hook keeps the firing from falling back to the router.
 *
 * A session made for the task got the employee's full toolset then; at each firing it gets the tools added
 * since (a new integration tool, a newly connected server), so a daily task isn't stuck with the tools of the
 * day it was set up. Nothing is taken away. A note's session (one the task didn't make) is left as it is.
 */
export function scheduledTaskRecipients(tasks: ScheduledTasks, opts?: ScheduledRecipientsOptions): RecipientResolver {
  const log = opts?.logger ?? silentLogger
  const topUp = async (sessionId: string, taskId: string, employeeId: string) => {
    if (!opts) return
    try {
      const session = await opts.sessions.get(sessionId)
      if (!session || session.data.meta?.scheduledTaskId !== taskId) return
      const have = new Set(session.data.toolset)
      const add = (await opts.toolsetFor(employeeId)).filter((n) => !have.has(n))
      if (add.length) {
        await opts.sessions.update(sessionId, { toolset: [...session.data.toolset, ...add] })
        log.info('scheduled task session got new tools', { taskId, sessionId, added: add })
      }
    } catch (err) {
      log.warn('scheduled task: could not add new tools to its session', { taskId, sessionId, err: errorMessage(err) })
    }
  }
  return async (event) => {
    const id = scheduledTaskId(event.data)
    if (!id) return []
    const task = await tasks.get(id)
    if (!task?.data.sessionId || task.data.employeeId !== event.data.employeeId) return []
    await topUp(task.data.sessionId, task.id, task.data.employeeId)
    return [
      {
        sessionId: task.data.sessionId,
        reason: 'session_tag',
        expectedToAct: true,
        trusted: true,
        fork: task.data.kind === 'task' && task.data.sessionMode === 'fresh',
        mode: 'continuing',
      },
    ]
  }
}
