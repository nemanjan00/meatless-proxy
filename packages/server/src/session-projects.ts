import { errorMessage } from '@mp/core'
import { runInput } from '@mp/router'
import { projectsEntry } from '@mp/stdlib'
import type { Services } from './services.ts'

/**
 * The employee's current projects in every run (docs/spec.md#projects): when the router starts
 * a run for a delivery (in the context itself or in a fork of it), a short "Your projects" system
 * entry goes into its input, after the session's history. The system prompt never lists projects,
 * so assigning one never changes a session's cached prefix. When the history already ends with
 * the same list, nothing is added. New sessions started by tools get it from `kit.startRun`.
 */

/** Registers the `router.runInput` handler. Returns a function that removes it. */
export function registerSessionProjects(s: Services): () => void {
  const log = s.logger.child({ component: 'session-projects' })
  return s.hooks.onTransform(runInput, async (payload) => {
    try {
      const session = payload.session
      if (!session.data.employeeId || !(await s.directory.employees.get(session.data.employeeId))) return payload
      const entry = await projectsEntry(s, session.data.employeeId, session.id)
      return entry ? { ...payload, entries: [entry, ...payload.entries] } : payload
    } catch (err) {
      // A convenience: the delivery goes ahead without it (directory.projects_of still answers).
      log.warn('could not list the employee’s projects for a run', { eventId: payload.event.id, err: errorMessage(err) })
      return payload
    }
  })
}
