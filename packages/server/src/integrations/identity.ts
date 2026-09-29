import { type Clock, errorMessage, type Logger } from '@mp/core'
import type { Directory } from '@mp/directory'
import type { Integration } from '@mp/mcp'

/** How long an actor that matched no contact is remembered, so every event doesn't look the user up again. */
const MISS_TTL_MS = 10 * 60_000
const MISS_MAX = 5000

export interface ActorResolver {
  /**
   * The contact of an external actor: by handle first; otherwise, when the
   * integration can look users up, by the user's email, and the handle is then
   * recorded on that contact. Never creates contacts. Undefined when nobody matches.
   */
  contactFor(integration: Integration, actor: { system: string; id: string } | undefined): Promise<string | undefined>
}

export function createActorResolver(deps: { directory: Directory; clock: Clock; logger: Logger }): ActorResolver {
  const misses = new Map<string, number>()
  return {
    async contactFor(integration, actor) {
      if (!actor?.id) return undefined
      const byHandle = await deps.directory.contacts.byHandle(actor.system, actor.id)
      if (byHandle) return byHandle.id
      if (!integration.resolveUser) return undefined
      const key = `${actor.system}:${actor.id}`
      const missed = misses.get(key)
      if (missed !== undefined && deps.clock.now() - missed < MISS_TTL_MS) return undefined
      const miss = () => {
        misses.set(key, deps.clock.now())
        if (misses.size > MISS_MAX) misses.delete(misses.keys().next().value!)
        return undefined
      }
      let user: Awaited<ReturnType<NonNullable<Integration['resolveUser']>>>
      try {
        user = await integration.resolveUser(actor.id)
      } catch (err) {
        deps.logger.warn('integration user lookup failed', { system: actor.system, err: errorMessage(err) })
        return undefined // not remembered: the lookup may work next time
      }
      if (!user?.email) return miss()
      const contact = await deps.directory.contacts.byEmail(user.email)
      if (!contact) return miss()
      const handles = contact.data.handles ?? []
      const handle = { system: user.handle.system || actor.system, id: user.handle.id || actor.id }
      const add = [handle, { system: actor.system, id: actor.id }].filter(
        (h, i, all) =>
          !handles.some((x) => x.system === h.system && x.id === h.id) &&
          all.findIndex((y) => y.system === h.system && y.id === h.id) === i,
      )
      if (add.length) {
        try {
          await deps.directory.contacts.update(
            contact.id,
            { handles: [...handles, ...add] },
            { actor: { type: 'system', id: `integration:${actor.system}` } },
          )
          deps.logger.info('contact matched by email: handle recorded', { contactId: contact.id, system: actor.system })
        } catch (err) {
          // Someone else changed the contact at the same time: the match still holds.
          deps.logger.warn('could not record the handle on the contact', { contactId: contact.id, err: errorMessage(err) })
        }
      }
      return contact.id
    },
  }
}
