import type { Services } from './services.ts'
import { SettingNames } from './settings.ts'
import { DEFAULT_REQUESTS_CHANNEL, GENERAL_CHANNEL, provisionEmployee } from './provision.ts'

export { createEmployee, ensureRouterInstructions, provisionEmployee, routerToolset } from './provision.ts'

export const DEFAULT_EMPLOYEE = {
  name: 'Meatless',
  personality:
    'Dry, friendly and brief. Signs off important answers with "— Meatless (AI)". Likes tidy commit messages and short threads.',
}

export interface BootstrapResult {
  /** False when the store already had an employee and nothing was created. */
  created: boolean
  employeeId: string
  routerSessionId: string
  channels: Record<string, string>
  triggerId: string
}

/**
 * Seeds an empty deployment: the default employee "Meatless" with its router
 * session, the channels #general and #requests, a trigger routing new
 * top-level messages in #requests to the router, and the default router
 * setting. Idempotent: every step looks for what it would create first.
 */
export async function bootstrap(s: Services): Promise<BootstrapResult> {
  const actor = { type: 'system' as const, id: 'bootstrap' }
  const toolDeny = s.containers ? [] : ['env.*', 'env.**']
  let created = false

  let employee = await s.directory.employees.byHandle('meatless')
  if (!employee) {
    employee = await s.directory.employees.create(
      { name: DEFAULT_EMPLOYEE.name, personality: DEFAULT_EMPLOYEE.personality, toolAllow: ['**'], toolDeny },
      { actor },
    )
    created = true
    s.logger.info('bootstrap: created employee', { employeeId: employee.id })
  }

  const p = await provisionEmployee(s, employee.id, actor, { requestsChannel: DEFAULT_REQUESTS_CHANNEL })
  created ||= p.created
  const routerSessionId = p.routerSessionId
  if ((await s.settings.get<string>(SettingNames.defaultRouter)) !== routerSessionId) {
    await s.settings.set(SettingNames.defaultRouter, routerSessionId, actor)
  }
  const channels = { general: p.channels[GENERAL_CHANNEL]!, requests: p.channels[DEFAULT_REQUESTS_CHANNEL]! }

  await s.settings.set(SettingNames.bootstrap, { at: s.clock.iso(), employeeId: employee.id }, actor)
  return { created, employeeId: employee.id, routerSessionId, channels, triggerId: p.triggerId }
}

/** Whether the store has no employee yet (a fresh deployment). */
export async function isEmpty(s: Services): Promise<boolean> {
  return (await s.store.records.count('employee')) === 0
}
