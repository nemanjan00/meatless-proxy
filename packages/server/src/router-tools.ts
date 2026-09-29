import { errorMessage } from '@mp/core'
import { routerToolset } from './provision.ts'
import type { Services } from './services.ts'

/**
 * A router context's toolset is fixed when it is created, and the sessions it starts inherit it. Standard
 * library tools added since (e.g. `time.now`, `code.run`) are appended here, at every start, so existing
 * routers and the work they start get them too. Only stdlib tools the router toolset would include now are
 * added; nothing is removed. Returns how many router contexts changed.
 */
export async function addStdlibToolsToRouters(s: Services): Promise<number> {
  if (!s.stdlib) return 0
  let changed = 0
  for (const e of (await s.directory.employees.list({ limit: 1000 })).items) {
    const routerId = e.data.routerSessionId
    if (!routerId) continue
    try {
      const session = await s.sessions.get(routerId)
      if (!session) continue
      const have = new Set(session.data.toolset)
      const add = routerToolset(s, await s.toolListsFor(e.id)).filter(
        (n) => !have.has(n) && s.tools.get(n)?.def.source === 'stdlib',
      )
      if (!add.length) continue
      await s.records.update('session', routerId, { toolset: [...session.data.toolset, ...add] })
      s.logger.info('router context got new stdlib tools', { employeeId: e.id, tools: add })
      changed++
    } catch (err) {
      s.logger.warn('could not add stdlib tools to a router context', { employeeId: e.id, err: errorMessage(err) })
    }
  }
  return changed
}
