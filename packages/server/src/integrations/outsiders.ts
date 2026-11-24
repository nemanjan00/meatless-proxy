import { beforeDeliver } from '@mp/router'
import type { Services } from '../services.ts'
import { isIntegrationDm } from '../auth/visibility.ts'

/**
 * Employees don't take DMs from outsiders unless they're set to (`outsiderDms: true`): a direct message (a Slack DM or
 * group DM) from a contact who is a guest or from another organisation (`outside`, src/integrations/identity.ts)
 * isn't delivered to them. Messages in channels still are, like anyone's. Someone not known to be an
 * outsider (not looked up yet) gets through.
 */
export function wireOutsiderDms(s: Pick<Services, 'hooks' | 'directory' | 'sessions' | 'logger'>): () => void {
  return s.hooks.on(beforeDeliver, async ({ event, delivery }) => {
    if (!event.data.actorContactId || !isIntegrationDm(event.data)) return undefined
    const actor = await s.directory.contacts.get(event.data.actorContactId)
    const outside = actor?.data.outside
    if (outside !== 'guest' && outside !== 'external') return undefined
    const session = await s.sessions.get(delivery.sessionId)
    const employee = session ? await s.directory.employees.get(session.data.employeeId) : null
    if (!employee || employee.data.outsiderDms === true) return undefined
    s.logger.info('direct message from an outsider not delivered', { employeeId: employee.id, eventId: event.id, outside })
    return { skip: `${employee.data.name} doesn't take direct messages from people outside the company (${outside})` }
  })
}
