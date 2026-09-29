import { type ScheduledTasks, scheduledTaskId } from '@mp/events'
import type { RecipientResolver } from '@mp/router'

/**
 * A scheduled task's firing (`scheduled_task.fired`) goes to the session the task runs in, as a direct
 * delivery: trusted (a person or the employee itself set it up) and expected to act, in a continuing
 * run. A task in `fresh` mode gets a new fork of its session per firing. A task that was deleted gets
 * no delivery, and the scheduler's hook keeps the firing from falling back to the router.
 */
export function scheduledTaskRecipients(tasks: ScheduledTasks): RecipientResolver {
  return async (event) => {
    const id = scheduledTaskId(event.data)
    if (!id) return []
    const task = await tasks.get(id)
    if (!task?.data.sessionId || task.data.employeeId !== event.data.employeeId) return []
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
