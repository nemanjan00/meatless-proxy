import { errorMessage } from '@mp/core'
import type { Services } from './services.ts'
import { SettingNames } from './settings.ts'
import { DEFAULT_REQUESTS_CHANNEL, GENERAL_CHANNEL, provisionEmployee } from './provision.ts'

export { createEmployee, ensureRouterInstructions, provisionEmployee, routerToolset } from './provision.ts'

export const DEFAULT_EMPLOYEE = {
  name: 'Meatless',
  personality: 'Dry, friendly and brief. Likes tidy commit messages and short threads.',
}

/**
 * Earlier default personalities. An employee that still has one exactly gets the current default
 * (`migrateEmployees`); an edited personality is left alone. The first one signed off answers with
 * "— Meatless (AI)", which is noise in harness chat, where messages already carry an AI badge.
 */
export const OLD_DEFAULT_PERSONALITIES: readonly string[] = [
  'Dry, friendly and brief. Signs off important answers with "— Meatless (AI)". Likes tidy commit messages and short threads.',
]

/** Committed to the router context of a migrated employee: its system prompt still has the old personality. */
export const PERSONALITY_UPDATE_NOTE = (personality: string) =>
  `Update to your personality: ${personality} Don't sign off your messages: chat already shows you're an AI. This replaces the personality above.`

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

/** Appends one committed system entry at the head of a session (a one-off, like the router instructions). */
async function commitNote(s: Services, sessionId: string, text: string, note: string) {
  const actor = { type: 'system' as const, id: 'migrate' }
  const run = await s.sessions.createRun({ sessionId, mode: 'continuing', cause: { type: 'manual', note }, actor })
  await s.sessions.transition(run.id, 'queued', 'running')
  await s.sessions.append(run.id, { kind: 'system', content: { text } })
  await s.sessions.commit(run.id)
  await s.sessions.transition(run.id, 'running', 'completed', { result: { status: 'completed', output: note } })
}

/**
 * Brings employees from older versions up to date, at every start (idempotent):
 * - an employee whose personality is exactly an old default gets the current default, and its
 *   router context a note saying so (custom personalities are left alone);
 * - projects in the older `scope.projects` become `member` links from its contact (the links are
 *   what assigns a project now), and leave `scope`.
 */
export async function migrateEmployees(s: Services): Promise<{ personalities: number; projects: number }> {
  const actor = { type: 'system' as const, id: 'migrate' }
  let personalities = 0
  let projects = 0
  for (const e of (await s.directory.employees.list({ limit: 10_000 })).items) {
    try {
      if (e.data.personality && OLD_DEFAULT_PERSONALITIES.includes(e.data.personality)) {
        await s.directory.employees.update(e.id, { personality: DEFAULT_EMPLOYEE.personality }, { actor })
        const router = e.data.routerSessionId ? await s.sessions.get(e.data.routerSessionId) : null
        if (router) await commitNote(s, router.id, PERSONALITY_UPDATE_NOTE(DEFAULT_EMPLOYEE.personality), 'personality update')
        personalities++
        s.logger.info('migrate: the default personality no longer signs off', { employeeId: e.id })
      }
      const scoped = e.data.scope?.projects ?? []
      if (scoped.length) {
        for (const p of scoped)
          if (await s.directory.projects.get(p))
            await s.directory.projects.addMember(p, e.data.contactId, 'member', {}, { actor })
        const current = await s.directory.employees.require(e.id)
        await s.directory.employees.update(e.id, { scope: { ...current.data.scope, projects: [] } }, { actor })
        projects += scoped.length
        s.logger.info('migrate: scope projects are now project links', { employeeId: e.id, projects: scoped.length })
      }
    } catch (err) {
      s.logger.warn('migrate: could not update an employee', { employeeId: e.id, err: errorMessage(err) })
    }
  }
  return { personalities, projects }
}
