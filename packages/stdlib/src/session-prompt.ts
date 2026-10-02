import type { Session } from '@mp/sessions'
import { promptForEmployee } from './kit.ts'
import type { StdlibDeps } from './types.ts'

/** How an employee prompt starts (see `employeePrompt`): other first entries are left alone. */
const PROMPT_START = /^You are .+?, an AI employee of this company \(contact /
const STARTED = /Session started: [^\n]*/

/**
 * The employee prompt a session should see now, in place of the one stored as its first entry when it
 * was created: rules, tools guidance, personality and skills change after sessions start, and a session
 * would otherwise keep following the old ones. The session's start time is kept. Undefined when the
 * first entry isn't an employee prompt, or is already current. Router contexts are left out: they are
 * rebuilt with the current prompt instead (see the server's upgrade).
 */
export async function currentSessionPrompt(
  deps: Pick<StdlibDeps, 'directory' | 'skills' | 'clock' | 'records'> & { config?: Pick<StdlibDeps['config'], 'toolsOnDemand'> },
  session: Session,
  stored: string,
): Promise<string | undefined> {
  const role = session.data.meta?.role
  if (role === 'router' || role === 'router-retired') return undefined
  if (!PROMPT_START.test(stored)) return undefined
  const procedureId = session.data.meta?.procedureContext ? session.data.meta?.procedureId : undefined
  const projectIds =
    typeof procedureId === 'string'
      ? ((await deps.directory.procedures.get(procedureId))?.data.projectIds ?? [])
      : (await deps.records.linked({ kind: 'session', id: session.id }, { direction: 'out', kind: 'project' })).map(
          (l) => l.record.id,
        )
  const current = await promptForEmployee(deps, session.data.employeeId, projectIds)
  const started = stored.match(STARTED)?.[0]
  const text = started ? current.replace(STARTED, started) : current
  return text === stored ? undefined : text
}
