import { errorMessage, type Json } from '@mp/core'
import type { MpEvent } from '@mp/events'
import type { Ref } from '@mp/store'
import { runInput } from '@mp/router'
import { recordUse } from './knowledge/use.ts'
import type { Services } from './services.ts'

/**
 * Memory at session start (docs/spec.md#memory): when the router forks a
 * context for a new delivery (e.g. a request in #requests), memories relevant
 * to the event are recalled and added to the fork as one `system` entry,
 * after the fork point and before the event. The fork keeps the context's
 * cached prefix, and the model doesn't need a round trip to `memory.recall`.
 */

/** At most this many memories are loaded. */
export const SESSION_MEMORY_LIMIT = 5
const SNIPPET_CHARS = 240

export const SESSION_MEMORY_HEADER = 'Things you remember that may be relevant:'

const snippet = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat
}

/** Registers the `router.runInput` handler. Returns a function that removes it. */
export function registerSessionMemory(s: Services): () => void {
  const log = s.logger.child({ component: 'session-memory' })

  const projectsOf = async (sessionIds: string[]) => {
    const ids = new Set<string>()
    for (const id of sessionIds)
      for (const l of await s.records.linked({ kind: 'session', id }, { kind: 'project' })) ids.add(l.record.id)
    return [...ids]
  }

  /** The event's text: a chat message's full text when there is one, else the event's own text. */
  const textOf = async (event: MpEvent): Promise<string> => {
    const p = event.data.payload as { messageId?: unknown } | undefined
    if (event.data.source === 'chat' && typeof p?.messageId === 'string') {
      const msg = await s.chat.getMessage(p.messageId)
      if (msg?.data.text) return msg.data.text
    }
    return (event.data.text ?? '').replace(/^[\w.:-]+: /, '')
  }

  return s.hooks.onTransform(runInput, async (payload) => {
    try {
      const { event, context, session: fork } = payload
      const text = await textOf(event)
      const projectIds = await projectsOf([...new Set([context.id, fork.id])])
      const contactIds = event.data.actorContactId ? [event.data.actorContactId] : []
      const refs: Ref[] = [
        ...projectIds.map((id) => ({ kind: 'project', id })),
        ...contactIds.map((id) => ({ kind: 'contact', id })),
      ]
      if (!text.trim() && !refs.length) return payload
      const hits = await s.memory.recall({
        text,
        refs,
        context: { employeeId: fork.data.employeeId, projectIds, contactIds },
        limit: SESSION_MEMORY_LIMIT,
      })
      if (!hits.length) return payload
      const lines = hits.map(({ memory: m }) => {
        const body = m.data.content ? `: ${snippet(m.data.content)}` : ''
        return `- ${m.data.summary} (${m.data.kind}, ${m.id})${body}`
      })
      const entry = {
        kind: 'system' as const,
        content: { text: `${SESSION_MEMORY_HEADER}\n${lines.join('\n')}` },
        meta: { recalledMemories: hits.map((h) => h.memory.id) as Json },
      }
      // When each was last used, for the Memory page (src/knowledge/use.ts).
      void (async () => {
        for (const h of hits) await recordUse(s, { kind: 'memory', id: h.memory.id }, fork.data.employeeId, fork.id)
      })().catch((err) => log.warn('could not record memory use', { err: errorMessage(err) }))
      return { ...payload, entries: [...payload.entries, entry] }
    } catch (err) {
      // Memory is a convenience: the delivery goes ahead without it.
      log.warn('could not recall memories for a fork', { eventId: payload.event.id, err: errorMessage(err) })
      return payload
    }
  })
}
