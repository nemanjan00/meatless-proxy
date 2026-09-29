import type { ChannelSummary, ChatMember, ContactData, Message } from '@mp/api'
import { Hash, MessageSquare, MessagesSquare, Plus, Send, UserPlus, Users, Workflow, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { EmptyState, LoadingRows } from '@/components/empty.tsx'
import { Markdown } from '@/components/markdown.tsx'
import { Page } from '@/components/page.tsx'
import { AuthorAvatar, PersonAvatar } from '@/components/people.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useApi, useLive, useLoad } from '@/lib/api.tsx'
import { formatTime, timeAgo } from '@/lib/format.ts'
import { cn } from '@/lib/utils.ts'

function MessageItem({ m, onOpenThread, active }: { m: Message; onOpenThread?: () => void; active?: boolean }) {
  const d = m.data
  return (
    <div
      className={cn('group flex gap-3 px-6 py-2 hover:bg-level-1', active && 'bg-accent-tint hover:bg-accent-tint')}
      data-testid="chat-message"
    >
      <AuthorAvatar type={d.author.type} name={d.author.name} className="mt-0.5 size-7" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-foreground">{d.author.name}</span>
          {d.author.type !== 'person' && <span className="rounded-sm border px-1 text-tiny text-fg-tertiary">AI</span>}
          <span className="text-micro text-fg-quaternary">{formatTime(m.createdAt)}</span>
        </div>
        <Markdown text={d.text} className="text-small" tags />
        {onOpenThread && (d.replyCount ?? 0) > 0 && (
          <button
            type="button"
            onClick={onOpenThread}
            className="mt-1 flex items-center gap-1.5 text-micro text-[#828fff] hover:underline"
          >
            <MessageSquare className="size-3" />
            {d.replyCount} {d.replyCount === 1 ? 'reply' : 'replies'}
            {d.lastReplyAt && <span className="text-fg-quaternary">· last {timeAgo(d.lastReplyAt)} ago</span>}
          </button>
        )}
        {onOpenThread && !(d.replyCount ?? 0) && (
          <button
            type="button"
            onClick={onOpenThread}
            className="mt-0.5 text-micro text-fg-quaternary opacity-0 group-hover:opacity-100 hover:text-fg-secondary"
          >
            Reply in thread
          </button>
        )}
      </div>
    </div>
  )
}

function Composer({
  placeholder,
  onSend,
  compact = false,
}: {
  placeholder: string
  onSend(text: string): Promise<void>
  compact?: boolean
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      await onSend(text.trim())
      setText('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="m-4 rounded-lg border bg-level-1 focus-within:border-ring/70">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
        placeholder={placeholder}
        aria-label="Message"
        className="min-h-12 resize-none border-0 bg-transparent text-small shadow-none dark:bg-transparent"
      />
      <div className="flex items-center gap-2 px-2 pb-2 text-micro text-fg-quaternary">
        {!compact && (
          <span>
            Tag <code className="font-mono">@billing-bot</code>, <code className="font-mono">@billing-bot#slug</code> or{' '}
            <code className="font-mono">@ana</code> to ask them to act
          </span>
        )}
        <Button size="sm" className="ml-auto" onClick={send} disabled={busy || !text.trim()}>
          <Send /> Send
        </Button>
      </div>
    </div>
  )
}

function NewChannel({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange(o: boolean): void
  onCreated(id: string): void
}) {
  const api = useApi()
  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const create = async () => {
    const c = await api.createChannel({ name: name.trim(), topic: topic.trim() || undefined })
    toast(`#${c.data.name} created`)
    onOpenChange(false)
    setName('')
    setTopic('')
    onCreated(c.id)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-title1">New channel</DialogTitle>
          <DialogDescription>
            A place for one kind of work. Employees and sessions you add receive its messages.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. release-2-15" aria-label="Name" />
          <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic (optional)" aria-label="Topic" />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={create} disabled={!name.trim()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChannelList({ channels, current, onNew }: { channels: ChannelSummary[]; current?: string; onNew(): void }) {
  const rooms = channels.filter((c) => !c.channel.data.dm && !c.channel.data.archived)
  const dms = channels.filter((c) => c.channel.data.dm)
  const item = (c: ChannelSummary) => (
    <Link
      key={c.channel.id}
      to={`/chat/${c.channel.id}`}
      className={cn(
        'flex h-7 items-center gap-2 rounded-md px-2 text-fg-secondary hover:bg-secondary',
        current === c.channel.id && 'bg-secondary text-foreground',
      )}
    >
      {c.channel.data.dm ? (
        <PersonAvatar name={c.channel.data.name} className="size-4" />
      ) : (
        <Hash className="size-3.5 text-fg-tertiary" />
      )}
      <span className="truncate">{c.channel.data.name}</span>
      <span className="ml-auto text-tiny text-fg-quaternary">{c.lastMessageAt ? timeAgo(c.lastMessageAt) : ''}</span>
    </Link>
  )
  return (
    <nav className="flex w-60 shrink-0 flex-col gap-4 overflow-auto border-r bg-level-1 p-2" aria-label="Channels">
      <div>
        <div className="flex h-7 items-center px-2 text-micro font-medium text-fg-tertiary">
          Channels
          <button
            type="button"
            onClick={onNew}
            className="ml-auto rounded p-0.5 hover:bg-secondary hover:text-foreground"
            aria-label="New channel"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        {rooms.map(item)}
      </div>
      <div>
        <div className="flex h-7 items-center px-2 text-micro font-medium text-fg-tertiary">Direct messages</div>
        {dms.map(item)}
      </div>
    </nav>
  )
}

function ThreadPanel({ threadId, channelId, onClose }: { threadId: string; channelId: string; onClose(): void }) {
  const api = useApi()
  const thread = useLoad((a) => a.thread(threadId), [threadId])
  useLive([`chat:${channelId}`], (e) => {
    if (e.topic === 'chat.message' && e.payload.message.data.threadId === threadId) thread.reload()
  })
  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l bg-background" data-testid="thread">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <span className="font-medium">Thread</span>
        <Button variant="ghost" size="icon-xs" className="ml-auto" onClick={onClose} aria-label="Close thread">
          <X />
        </Button>
      </div>
      {!thread.data ? (
        <LoadingRows rows={3} />
      ) : (
        <>
          {thread.data.sessions.length > 0 && (
            <div className="flex flex-col gap-1 border-b px-4 py-2">
              <span className="text-micro text-fg-tertiary">Handled by</span>
              {thread.data.sessions.map((s) => (
                <Link
                  key={s.id}
                  to={`/sessions/${s.id}`}
                  className="flex items-center gap-1.5 text-fg-secondary hover:text-foreground"
                >
                  <Workflow className="size-3.5 text-fg-tertiary" />
                  <span className="truncate">{s.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-tiny text-fg-quaternary">#{s.slug}</span>
                </Link>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto py-2">
            <MessageItem m={thread.data.root} />
            <div className="mx-6 my-1 flex items-center gap-2 text-micro text-fg-quaternary">
              {thread.data.replies.length} replies <span className="h-px flex-1 bg-border" />
            </div>
            {thread.data.replies.map((m) => (
              <MessageItem key={m.id} m={m} />
            ))}
          </div>
          <Composer
            compact
            placeholder="Reply…"
            onSend={async (text) => {
              await api.postMessage(channelId, { text, threadId })
              thread.reload()
            }}
          />
        </>
      )}
    </aside>
  )
}

function AddMember({ existing, onAdd }: { existing: string[]; onAdd(m: ChatMember): void }) {
  const people = useLoad(
    (a) =>
      Promise.all([
        a.listRecords<ContactData>('contact', { orderBy: 'name', dir: 'asc' }),
        a.listRecords<{ name: string }>('employee'),
      ]),
    [],
  )
  const options: ChatMember[] = [
    ...(people.data?.[1].items ?? []).map((e) => ({ type: 'employee' as const, id: e.id, label: e.data.name })),
    ...(people.data?.[0].items ?? [])
      .filter((c) => !c.data.ai)
      .map((c) => ({ type: 'person' as const, id: c.id, label: c.data.name })),
  ].filter((o) => !existing.includes(o.id))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="Add member">
          <UserPlus />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {options.length === 0 && <DropdownMenuItem disabled>Everyone is here</DropdownMenuItem>}
        {options.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => onAdd(o)}>
            <AuthorAvatar type={o.type} name={o.label} className="size-4" />
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Harness chat: channels, threads and DMs, live. People can read along and post. */
export function ChatPage() {
  const { channelId, threadId } = useParams()
  const api = useApi()
  const navigate = useNavigate()
  const [newOpen, setNewOpen] = useState(false)
  const list = useLoad((a) => a.channels(), [])
  const currentId = channelId ?? list.data?.[0]?.channel.id
  const channel = list.data?.find((c) => c.channel.id === currentId)?.channel
  const messages = useLoad((a) => (currentId ? a.channelMessages(currentId) : Promise.resolve([])), [currentId])
  const end = useRef<HTMLDivElement>(null)
  useLive(currentId ? [`chat:${currentId}`] : [], (e) => {
    if (e.topic !== 'chat.message') return
    const m = e.payload.message
    if (m.data.threadId === null) messages.setData((prev) => (prev && !prev.some((x) => x.id === m.id) ? [...prev, m] : prev))
    else messages.reload()
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new messages
  useEffect(() => end.current?.scrollIntoView?.({ block: 'end' }), [messages.data?.length])

  return (
    <Page title="Chat" icon={<MessagesSquare />} className="flex overflow-hidden">
      {!list.data ? (
        <LoadingRows />
      ) : (
        <>
          <ChannelList channels={list.data} current={currentId} onNew={() => setNewOpen(true)} />
          <section className="flex min-w-0 flex-1 flex-col">
            {channel ? (
              <>
                <div className="flex h-11 shrink-0 items-center gap-2 border-b px-6">
                  {channel.data.dm ? (
                    <PersonAvatar name={channel.data.name} className="size-4" />
                  ) : (
                    <Hash className="size-4 text-fg-tertiary" />
                  )}
                  <span className="font-medium">{channel.data.name}</span>
                  {channel.data.topic && <span className="truncate text-fg-tertiary">· {channel.data.topic}</span>}
                  <div className="ml-auto flex items-center gap-2">
                    {channel.data.contextId && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Link
                            to={`/sessions/${channel.data.contextId}`}
                            className="flex items-center gap-1 text-micro text-fg-tertiary hover:text-foreground"
                          >
                            <Workflow className="size-3.5" /> context
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent>New top-level messages are routed to this context</TooltipContent>
                      </Tooltip>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex items-center gap-1 text-micro text-fg-tertiary">
                          <Users className="size-3.5" /> {channel.data.members.length}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-72">{channel.data.members.map((m) => m.label).join(', ')}</TooltipContent>
                    </Tooltip>
                    <AddMember
                      existing={channel.data.members.map((m) => m.id)}
                      onAdd={async (m) => {
                        await api.addMember(channel.id, m)
                        toast(`${m.label} added to #${channel.data.name}`)
                        list.reload()
                      }}
                    />
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto py-3">
                  {!messages.data ? (
                    <LoadingRows />
                  ) : messages.data.length === 0 ? (
                    <EmptyState text="No messages yet." />
                  ) : (
                    messages.data.map((m) => (
                      <MessageItem
                        key={m.id}
                        m={m}
                        active={m.id === threadId}
                        onOpenThread={() => navigate(`/chat/${channel.id}/${m.id}`)}
                      />
                    ))
                  )}
                  <div ref={end} />
                </div>
                <Composer
                  placeholder={`Message ${channel.data.dm ? channel.data.name : `#${channel.data.name}`}`}
                  onSend={async (text) => {
                    await api.postMessage(channel.id, { text })
                  }}
                />
              </>
            ) : (
              <EmptyState text="Pick a channel." />
            )}
          </section>
          {threadId && currentId && (
            <ThreadPanel threadId={threadId} channelId={currentId} onClose={() => navigate(`/chat/${currentId}`)} />
          )}
        </>
      )}
      <NewChannel
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={(id) => {
          list.reload()
          navigate(`/chat/${id}`)
        }}
      />
    </Page>
  )
}
