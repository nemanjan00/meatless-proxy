import { NotFoundError } from '@mp/core'
import type { ChannelData, MessageData } from '@mp/chat'
import type { StoredRecord } from '@mp/store'
import type { Services } from '../services.ts'

/**
 * Who may see which chat: direct messages are visible only to their members,
 * admins included (an admin can't read other people's DMs). Named channels
 * are visible to everyone signed in.
 */
export class ChatVisibility {
  constructor(private s: Pick<Services, 'records' | 'chat' | 'store'>) {}

  /** The ids of DMs this contact is not a member of. */
  async hiddenChannels(contactId: string): Promise<Set<string>> {
    const dms = await this.s.records.query<ChannelData>('channel', { where: { dm: true }, limit: 100_000 })
    if (!dms.items.length) return new Set()
    const mine = await this.s.store.links.query({ to: { kind: 'contact', id: contactId }, role: 'member' })
    const member = new Set(mine.filter((l) => l.from.kind === 'channel').map((l) => l.from.id))
    return new Set(dms.items.filter((c) => !member.has(c.id)).map((c) => c.id))
  }

  /** Whether the contact may see the channel (unknown channels: true, so the caller answers 404). */
  async canSeeChannel(contactId: string, channelId: string): Promise<boolean> {
    const ch = await this.s.records.get<ChannelData>('channel', channelId)
    if (ch?.data.dm !== true) return true
    return (await this.s.chat.members(channelId)).some((m) => m.kind === 'contact' && m.id === contactId)
  }

  /** Throws 404 (not 403: a DM's existence is private too) unless the contact may see the channel. */
  async requireChannel(contactId: string, channelId: string): Promise<void> {
    if (!(await this.canSeeChannel(contactId, channelId))) throw new NotFoundError('channel', channelId)
  }

  /** Throws 404 unless the contact may see the message's channel. */
  async requireMessage(contactId: string, messageId: string): Promise<void> {
    const m = await this.s.records.get<MessageData>('message', messageId)
    if (m && !(await this.canSeeChannel(contactId, m.data.channelId))) throw new NotFoundError('message', messageId)
  }

  /** The chat channel a record is about, if any: a channel itself, a message, or a chat event. */
  async channelOfRecord(r: StoredRecord | null | undefined): Promise<string | null> {
    if (!r) return null
    if (r.kind === 'channel') return r.id
    if (r.kind === 'message' || r.kind === 'agent_delivery') return typeof r.data.channelId === 'string' ? r.data.channelId : null
    if (r.kind === 'event') {
      const p = r.data.payload as { channelId?: unknown } | null | undefined
      return r.data.source === 'chat' && typeof p?.channelId === 'string' ? p.channelId : null
    }
    return null
  }

  /** Whether the contact may see a record (DM channels, their messages, chat events and agent deliveries are private to members). */
  async canSeeRecord(contactId: string, r: StoredRecord | null | undefined): Promise<boolean> {
    const ch = await this.channelOfRecord(r)
    return ch ? this.canSeeChannel(contactId, ch) : true
  }
}
