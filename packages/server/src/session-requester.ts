import { errorMessage } from '@mp/core'
import { runInput } from '@mp/router'
import { requesterEntry } from '@mp/stdlib'
import type { Services } from './services.ts'

/**
 * Who is asking, in every run a person's event starts (docs/spec.md#contacts): when the router
 * starts a run for a delivery whose actor is a contact, an "About the requester" system entry
 * (their role, team, permissions and bio) goes into its input, after the session's history and
 * before the event. It's added once per person per session, again only when their contact changes.
 * Sessions started by tools get it from `kit.startRun`.
 */

/** Registers the `router.runInput` handler. Returns a function that removes it. */
export function registerSessionRequester(s: Services): () => void {
  const log = s.logger.child({ component: 'session-requester' })
  return s.hooks.onTransform(runInput, async (payload) => {
    const contactId = payload.event.data.actorContactId
    if (!contactId) return payload
    try {
      const entry = await requesterEntry(s, contactId, payload.session.id)
      return entry ? { ...payload, entries: [...payload.entries, entry] } : payload
    } catch (err) {
      // A convenience: the delivery goes ahead without it (directory.get_contact still answers).
      log.warn('could not describe the requester for a run', { eventId: payload.event.id, err: errorMessage(err) })
      return payload
    }
  })
}
