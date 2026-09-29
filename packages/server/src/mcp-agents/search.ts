import { NotFoundError, ValidationError } from '@mp/core'
import { attachmentsOf, type Attachment, type ChatAuthor, type Message } from '@mp/chat'
import type { Contact } from '@mp/directory'
import type { Ref } from '@mp/store'
import type { Services } from '../services.ts'
import type { AgentChat } from './agents.ts'

export interface ChatSearchInput {
  query: string
  /** A channel name or id. */
  channel?: string
  /** An author: an employee's handle (its sessions and contact) or a contact's `@handle`. */
  from?: string
  /** ISO times: only messages posted after / before. */
  after?: string
  before?: string
  limit?: number
  /** `nextCursor` of the previous page. */
  cursor?: string
}

export interface ChatSearchHit {
  messageId: string
  channel: string
  channelId: string
  threadId: string
  author: string
  at: string
  snippet: string
  /** Images on the message; fetch one with chat_attachment. */
  attachments?: Attachment[]
}

const time = (label: string, v: string | undefined) => {
  if (v === undefined) return undefined
  const ms = Date.parse(v)
  if (Number.isNaN(ms)) throw new ValidationError(`${label} must be an ISO time, e.g. 2026-09-29T12:00:00Z`)
  return new Date(ms).toISOString()
}

/** Up to 200 characters around the first match, with ellipses where cut. */
export function snippet(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const i = query ? flat.toLowerCase().indexOf(query.toLowerCase()) : 0
  const start = Math.max(0, i - 60)
  const end = Math.min(flat.length, Math.max(i, 0) + 140)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/**
 * Harness chat search for an MCP caller (a person, or an agent seeing what its
 * sponsor sees): the chat package's text search, without channels the reader
 * can't see, newest first, paged with a cursor (the last message id of a page).
 */
export async function searchChat(
  s: Services,
  agents: AgentChat,
  reader: Contact,
  q: ChatSearchInput,
): Promise<{ results: ChatSearchHit[]; nextCursor: string | null }> {
  const hidden = await agents.hiddenChannels(reader)
  const after = time('after', q.after)
  const before = time('before', q.before)
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 100)

  let channelId: string | undefined
  if (q.channel) {
    const ch = q.channel.startsWith('chn_') ? await s.chat.getChannel(q.channel) : await s.chat.channelByName(q.channel)
    if (!ch || hidden.has(ch.id)) throw new NotFoundError('channel', q.channel)
    channelId = ch.id
  }

  let author: Ref | undefined
  let byAuthor: ((a: ChatAuthor) => Promise<boolean>) | undefined
  if (q.from) {
    const h = q.from.trim().replace(/^@/, '')
    const emp = await s.directory.employees.byHandle(h)
    if (emp) {
      const sessionOf = new Map<string, boolean>()
      byAuthor = async (a) => {
        if (a.kind === 'contact') return a.id === emp.data.contactId
        if (!sessionOf.has(a.id)) sessionOf.set(a.id, (await s.sessions.get(a.id))?.data.employeeId === emp.id)
        return sessionOf.get(a.id)!
      }
    } else {
      const c = await s.directory.contacts.byHandle('mp', h)
      if (!c) throw new NotFoundError('author', q.from)
      author = { kind: 'contact', id: c.id }
    }
  }

  const all = await s.chat.search(q.query, {
    ...(channelId ? { channelId } : {}),
    ...(author ? { author } : {}),
    limit: 100_000,
  })
  const page: Message[] = []
  let more = false
  for (const m of all) {
    if (q.cursor && m.id >= q.cursor) continue
    if (hidden.has(m.data.channelId)) continue
    if (after && m.data.createdAt <= after) continue
    if (before && m.data.createdAt >= before) continue
    if (byAuthor && !(await byAuthor(m.data.author))) continue
    if (page.length === limit) {
      more = true
      break
    }
    page.push(m)
  }

  const names = new Map<string, string>()
  const channelName = async (id: string) => {
    if (!names.has(id)) names.set(id, (await s.chat.getChannel(id))?.data.name ?? id)
    return names.get(id)!
  }
  const results: ChatSearchHit[] = []
  for (const m of page)
    results.push({
      messageId: m.id,
      channel: await channelName(m.data.channelId),
      channelId: m.data.channelId,
      threadId: m.data.threadId ?? m.id,
      author: await agents.authorName(m.data.author),
      at: m.data.createdAt,
      snippet: snippet(m.data.text, q.query),
      ...(attachmentsOf(m.data).length ? { attachments: attachmentsOf(m.data) } : {}),
    })
  return { results, nextCursor: more ? page.at(-1)!.id : null }
}
