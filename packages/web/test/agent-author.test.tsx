import type { ApiRecord, ContactData, Message } from '@mp/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MessageItem } from '../src/components/chat-message.tsx'
import { TooltipProvider } from '../src/components/ui/tooltip.tsx'
import { tagCandidates } from '../src/lib/chat.ts'

const message = (author: Message['data']['author']): Message =>
  ({
    kind: 'message',
    id: 'msg_1',
    key: null,
    version: 1,
    createdAt: '2026-01-01T10:00:00Z',
    updatedAt: '2026-01-01T10:00:00Z',
    data: {
      channelId: 'chn_1',
      threadId: null,
      author,
      text: 'lunch anyone?',
      tags: [],
      reactions: [],
      createdAt: '2026-01-01T10:00:00Z',
    },
  }) as unknown as Message

describe('a local agent as an author', () => {
  it('shows whose agent it is next to its name', () => {
    render(
      <TooltipProvider>
        <MessageItem m={message({ type: 'person', id: 'con_a', name: 'ordinary-plum', agentFor: 'Ana Example' })} />
      </TooltipProvider>,
    )
    expect(screen.getByText('ordinary-plum')).toBeInTheDocument()
    expect(screen.getByText('agent of Ana Example')).toBeInTheDocument()
  })

  it('a person has no such note', () => {
    render(
      <TooltipProvider>
        <MessageItem m={message({ type: 'person', id: 'con_b', name: 'Bo Example' })} />
      </TooltipProvider>,
    )
    expect(screen.queryByText(/agent of/)).toBeNull()
  })

  it('tag suggestions say whose agent an online one is', () => {
    const rec = (id: string, data: ContactData) =>
      ({ kind: 'contact', id, key: null, version: 1, data, createdAt: '', updatedAt: '' }) as ApiRecord<ContactData>
    const contacts = [
      rec('con_ana', { name: 'Ana Example', kind: 'person', handles: [{ system: 'mp', id: 'ana' }] }),
      rec('con_a', {
        name: 'ordinary-plum',
        kind: 'agent',
        sponsor: 'con_ana',
        online: true,
        handles: [{ system: 'mp', id: 'ordinary-plum' }],
      } as ContactData),
    ]
    const agent = tagCandidates([], [], contacts, 'con_me').find((s) => s.insert === '@ordinary-plum')
    expect(agent?.detail).toBe('agent of Ana Example')
  })
})
