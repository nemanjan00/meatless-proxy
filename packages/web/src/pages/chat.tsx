import type {
  ApiRef,
  Channel,
  ChannelSummary,
  ChannelUnread,
  ChatMember,
  ChatSearchResult,
  ContactData,
  EmployeeData,
  Message,
} from '@mp/api'
import { Hash, MessagesSquare, PenSquare, Plus, Search, UserPlus, Users, Workflow, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Composer } from '@/components/chat-composer.tsx'
import { type MessageActions, MessageItem } from '@/components/chat-message.tsx'
import { EmptyState, LoadingRows } from '@/components/empty.tsx'
import { Page } from '@/components/page.tsx'
import { AuthorAvatar } from '@/components/people.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Kbd } from '@/components/ui/kbd.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useApi, useLive, useLiveReload, useLoad } from '@/lib/api.tsx'
import { Can, ReadOnlyNote, useAuth } from '@/lib/auth.tsx'
import {
  channelLabel,
  dmWithEmployee,
  groupByChannel,
  mpHandle,
  type TagSuggestion,
  tagCandidates,
  tagExamples,
  upsertMessage,
} from '@/lib/chat.ts'
import { plainDoc } from '@/lib/doclinks.ts'
import { clockOrDate, pluralize } from '@/lib/format.ts'
import { isTypingTarget } from '@/lib/shortcuts.ts'
import { cn } from '@/lib/utils.ts'

export { channelLabel, tagExamples } from '@/lib/chat.ts'

/** Reactions, edits and deletions, applied to the local copy with the server's answer. */
function useMessageActions(onChange: (m: Message) => void): MessageActions {
  const api = useApi()
  return useMemo(
    () => ({
      react: (m, emoji, on) => {
        ;(on ? api.addReaction(m.id, emoji) : api.removeReaction(m.id, emoji)).then(onChange, (e: Error) =>
          toast.error('Could not react', { description: e.message }),
        )
      },
      edit: async (m, text) => {
        try {
          onChange(await api.editMessage(m.id, text))
        } catch (e) {
          toast.error('Could not edit', { description: e instanceof Error ? e.message : String(e) })
          throw e
        }
      },
      remove: (m) => {
        api.deleteMessage(m.id).then(
          (next) => {
            onChange(next)
            toast('Message deleted')
          },
          (e: Error) => toast.error('Could not delete', { description: e.message }),
        )
      },
    }),
    [api, onChange],
  )
}

/** Marks a channel or thread read while it's on screen and the tab is visible, and when new messages arrive. */
function useMarkRead(scope: string | undefined, seen: number, onRead: () => void) {
  const api = useApi()
  const onReadRef = useRef(onRead)
  onReadRef.current = onRead
  // biome-ignore lint/correctness/useExhaustiveDependencies: `seen` re-marks when messages arrive
  useEffect(() => {
    if (!scope) return
    const mark = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      api.markRead(scope).then(
        () => onReadRef.current(),
        () => {},
      )
    }
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [api, scope, seen])
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
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. deploys" aria-label="Name" />
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

/** "New message": pick employees and people, and open the DM with them (the same set always gets the same DM). */
function NewMessage({
  open,
  onOpenChange,
  candidates,
  onOpened,
}: {
  open: boolean
  onOpenChange(o: boolean): void
  candidates: { ref: ApiRef; type: 'employee' | 'person'; label: string; detail?: string }[]
  onOpened(id: string): void
}) {
  const api = useApi()
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const shown = candidates.filter((c) => !filter || c.label.toLowerCase().includes(filter.toLowerCase()))
  const start = async () => {
    const members = candidates.filter((c) => picked.includes(c.ref.id)).map((c) => c.ref)
    const ch = await api.openDm(members)
    onOpenChange(false)
    setPicked([])
    setFilter('')
    onOpened(ch.id)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="new-message">
        <DialogHeader>
          <DialogTitle className="text-title1">New message</DialogTitle>
          <DialogDescription>A direct message with any employee or person. Pick one or more.</DialogDescription>
        </DialogHeader>
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name" aria-label="Filter" />
        <div className="-mx-1 max-h-72 overflow-auto">
          {shown.length === 0 && <p className="px-2 py-3 text-fg-tertiary">Nobody matches.</p>}
          {shown.map((c) => {
            const on = picked.includes(c.ref.id)
            return (
              <label
                key={c.ref.id}
                className="flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-secondary"
                htmlFor={`dm-${c.ref.id}`}
              >
                <Checkbox
                  id={`dm-${c.ref.id}`}
                  checked={on}
                  onCheckedChange={(v) => setPicked((p) => (v ? [...p, c.ref.id] : p.filter((x) => x !== c.ref.id)))}
                />
                <AuthorAvatar type={c.type} name={c.label} className="size-5" />
                <span className="min-w-0 truncate text-fg-secondary">{c.label}</span>
                <span className="ml-auto shrink-0 truncate text-micro text-fg-quaternary">{c.detail}</span>
              </label>
            )
          })}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={start} disabled={!picked.length}>
            Open conversation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChannelList({
  channels,
  current,
  unread,
  meId,
  onNew,
  onNewMessage,
}: {
  channels: ChannelSummary[]
  current?: string
  unread: Map<string, ChannelUnread>
  meId?: string
  onNew(): void
  onNewMessage(): void
}) {
  const rooms = channels.filter((c) => !c.channel.data.dm && !c.channel.data.archived)
  const dms = channels.filter((c) => c.channel.data.dm)
  const item = (c: ChannelSummary) => {
    const u = c.channel.id === current ? undefined : unread.get(c.channel.id)
    const hasUnread = (u?.unread ?? 0) > 0
    return (
      <Link
        key={c.channel.id}
        to={`/chat/${c.channel.id}`}
        className={cn(
          'flex h-7 items-center gap-2 rounded-md px-2 text-fg-secondary hover:bg-secondary',
          current === c.channel.id && 'bg-secondary text-foreground',
          hasUnread && 'font-semibold text-foreground',
        )}
        data-testid="channel-link"
      >
        {c.channel.data.dm ? (
          <AuthorAvatar
            type={dmWithEmployee(c.channel, meId) ? 'employee' : 'person'}
            name={channelLabel(c.channel, meId)}
            className="size-4"
          />
        ) : (
          <Hash className="size-3.5 shrink-0 text-fg-tertiary" />
        )}
        <span className="min-w-0 truncate">{channelLabel(c.channel, meId)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {(u?.mentions ?? 0) > 0 && (
            <span
              className="rounded-full bg-primary px-1.5 text-tiny font-semibold text-primary-foreground tabular-nums"
              title={pluralize(u!.mentions, 'mention')}
              data-testid="mention-badge"
            >
              @{u!.mentions}
            </span>
          )}
          {hasUnread ? (
            <span
              className="rounded-full bg-level-3 px-1.5 text-tiny tabular-nums text-fg-secondary"
              title={`${u!.unread} unread`}
              data-testid="unread-badge"
            >
              {u!.unread}
            </span>
          ) : (
            <span className="text-tiny font-normal text-fg-quaternary">
              {c.lastMessageAt ? clockOrDate(c.lastMessageAt) : ''}
            </span>
          )}
        </span>
      </Link>
    )
  }
  return (
    <nav className="hidden w-60 shrink-0 flex-col gap-4 overflow-auto border-r bg-level-1 p-2 md:flex" aria-label="Channels">
      <div>
        <div className="flex h-7 items-center px-2 text-micro font-medium text-fg-tertiary">
          Channels
          <Can>
            <button
              type="button"
              onClick={onNew}
              className="ml-auto rounded p-0.5 hover:bg-secondary hover:text-foreground"
              aria-label="New channel"
            >
              <Plus className="size-3.5" />
            </button>
          </Can>
        </div>
        {rooms.map(item)}
      </div>
      <div>
        <div className="flex h-7 items-center px-2 text-micro font-medium text-fg-tertiary">
          Direct messages
          <Can>
            <button
              type="button"
              onClick={onNewMessage}
              className="ml-auto rounded p-0.5 hover:bg-secondary hover:text-foreground"
              aria-label="New message"
            >
              <PenSquare className="size-3.5" />
            </button>
          </Can>
        </div>
        {dms.map(item)}
        {dms.length === 0 && (
          <Can fallback={<span className="px-2 text-micro text-fg-quaternary">No direct messages</span>}>
            <button type="button" onClick={onNewMessage} className="px-2 text-micro text-fg-quaternary hover:text-fg-secondary">
              Start a conversation
            </button>
          </Can>
        )}
      </div>
    </nav>
  )
}

function ThreadPanel({
  threadId,
  channelId,
  me,
  suggestions,
  highlight,
  onClose,
  onRead,
}: {
  threadId: string
  channelId: string
  me?: ApiRef
  suggestions: TagSuggestion[]
  highlight?: string | null
  onClose(): void
  onRead(): void
}) {
  const api = useApi()
  const thread = useLoad((a) => a.thread(threadId), [threadId])
  useLive([`chat:${channelId}`], (e) => {
    if (e.topic !== 'chat.message') return
    const m = e.payload.message
    if (m.id === threadId || m.data.threadId === threadId) {
      thread.setData((prev) =>
        prev
          ? m.id === threadId
            ? { ...prev, root: { ...m, data: { ...prev.root.data, ...m.data } } }
            : { ...prev, replies: upsertMessage(prev.replies, m) }
          : prev,
      )
    }
  })
  const onChange = useCallback(
    (m: Message) =>
      thread.setData((prev) =>
        prev ? (m.id === prev.root.id ? { ...prev, root: m } : { ...prev, replies: upsertMessage(prev.replies, m) }) : prev,
      ),
    [thread],
  )
  const actions = useMessageActions(onChange)
  useMarkRead(threadId, thread.data?.replies.length ?? 0, onRead)
  return (
    <aside
      className="flex shrink-0 flex-col border-l bg-background max-md:absolute max-md:inset-0 max-md:z-20 md:w-[380px]"
      data-testid="thread"
    >
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
                  className="flex min-w-0 items-center gap-1.5 text-fg-secondary hover:text-foreground"
                  title={`#${s.slug}`}
                >
                  <Workflow className="size-3.5 shrink-0 text-fg-tertiary" />
                  <span className="min-w-0 truncate">{s.title}</span>
                  <span className="ml-auto max-w-[40%] shrink-0 truncate font-mono text-tiny text-fg-quaternary">#{s.slug}</span>
                </Link>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto py-2">
            <MessageItem m={thread.data.root} me={me} actions={actions} highlight={highlight === thread.data.root.id} />
            <div className="mx-6 my-1 flex items-center gap-2 text-micro text-fg-quaternary">
              {pluralize(thread.data.replies.length, 'reply', 'replies')} <span className="h-px flex-1 bg-border" />
            </div>
            {thread.data.replies.map((m) => (
              <MessageItem key={m.id} m={m} me={me} actions={actions} highlight={highlight === m.id} />
            ))}
          </div>
          <Can fallback={<ReadOnlyNote />}>
            <Composer
              compact
              placeholder="Reply…"
              suggestions={suggestions}
              onSend={async (text) => {
                const m = await api.postMessage(channelId, { text, threadId })
                onChange(m)
              }}
            />
          </Can>
        </>
      )}
    </aside>
  )
}

function AddMember({ existing, onAdd }: { existing: string[]; onAdd(m: ChatMember): void }) {
  const { can } = useAuth()
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
      .filter((c) => !c.data.ai && c.data.kind !== 'ai')
      .map((c) => ({ type: 'person' as const, id: c.id, label: c.data.name })),
  ].filter((o) => !existing.includes(o.id))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="Add member" disabled={!can('member')}>
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

/** Search results, grouped by channel. A click opens the message in context. */
function SearchResults({
  query,
  results,
  meId,
  channels,
  onOpen,
}: {
  query: string
  results: ChatSearchResult[] | undefined
  meId?: string
  channels: Map<string, Channel>
  onOpen(r: ChatSearchResult): void
}) {
  if (!results) return <LoadingRows />
  if (!results.length) return <EmptyState text={`No messages match “${query}”.`} />
  return (
    <div className="py-2" data-testid="search-results">
      {groupByChannel(results).map((g) => {
        const ch = channels.get(g.channel.id)
        const label = ch ? channelLabel(ch, meId) : g.channel.name
        return (
          <section key={g.channel.id} className="mb-3">
            <div className="flex h-7 items-center gap-1.5 px-4 text-micro font-medium text-fg-tertiary md:px-6">
              {g.channel.dm ? <Users className="size-3.5" /> : <Hash className="size-3.5" />}
              {label}
              <span className="text-fg-quaternary">{g.hits.length}</span>
            </div>
            {g.hits.map((r) => (
              <button
                key={r.message.id}
                type="button"
                onClick={() => onOpen(r)}
                className="flex w-full min-w-0 items-start gap-3 px-4 py-1.5 text-left hover:bg-level-1 md:px-6"
                data-testid="search-hit"
              >
                <AuthorAvatar type={r.message.data.author.type} name={r.message.data.author.name} className="mt-0.5 size-5" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2 text-micro">
                    <span className="truncate font-medium text-fg-secondary">{r.message.data.author.name}</span>
                    {r.threadId !== r.message.id && <span className="shrink-0 text-fg-quaternary">in a thread</span>}
                    <span className="ml-auto shrink-0 text-fg-quaternary">{clockOrDate(r.message.createdAt)}</span>
                  </span>
                  <span className="line-clamp-2 text-mini text-fg-secondary">
                    <Highlight text={plainDoc(r.message.data.text)} query={query} />
                  </span>
                </span>
              </button>
            ))}
          </section>
        )
      })}
    </div>
  )
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase()
  const i = q ? text.toLowerCase().indexOf(q) : -1
  if (i < 0) return <>{text}</>
  // Show a little context before the match.
  const from = Math.max(0, i - 40)
  return (
    <>
      {from > 0 && '…'}
      {text.slice(from, i)}
      <mark className="rounded-sm bg-[var(--yellow)]/25 px-0.5 text-foreground">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  )
}

/**
 * Harness chat, Slack-like: channels, DMs and threads, live; unread counts and
 * mentions; search (`/`); `@` autocomplete; edit, delete and reactions.
 */
export function ChatPage() {
  const { channelId, threadId } = useParams()
  const [params, setParams] = useSearchParams()
  const highlight = params.get('m')
  const api = useApi()
  const navigate = useNavigate()
  const [newOpen, setNewOpen] = useState(false)
  const [dmOpen, setDmOpen] = useState(false)
  const [query, setQuery] = useState(params.get('q') ?? '')
  const searchBox = useRef<HTMLInputElement>(null)

  const me = useLoad((a) => a.me().catch(() => null), [])
  const meRef: ApiRef | undefined = me.data ? { kind: 'contact', id: me.data.contactId } : undefined
  const list = useLoad((a) => a.channels(), [])
  const unread = useLoad((a) => a.unread().catch(() => [] as ChannelUnread[]), [])
  const allChannels = (list.data ?? []).map((c) => `chat:${c.channel.id}` as const)
  useLiveReload(allChannels, unread.reload, ['chat.message'], 600)
  useLiveReload(allChannels, list.reload, ['chat.message'], 1500)

  const currentId = channelId ?? list.data?.[0]?.channel.id
  const channel = list.data?.find((c) => c.channel.id === currentId)?.channel
  const channelMap = useMemo(() => new Map((list.data ?? []).map((c) => [c.channel.id, c.channel])), [list.data])
  const unreadMap = useMemo(() => new Map((unread.data ?? []).map((u) => [u.channelId, u])), [unread.data])

  const directory = useLoad(
    (a) =>
      Promise.all([
        a.listRecords<EmployeeData>('employee', { orderBy: 'name', dir: 'asc' }),
        a.listRecords<ContactData>('contact', { orderBy: 'name', dir: 'asc', limit: 500 }),
        a.listSessions({ status: 'active,waiting', limit: 200 }),
      ]),
    [],
  )
  const suggestions = useMemo(
    () =>
      tagCandidates(
        directory.data?.[0].items ?? [],
        directory.data?.[2].items ?? [],
        directory.data?.[1].items ?? [],
        me.data?.contactId,
      ),
    [directory.data, me.data],
  )
  const dmCandidates = useMemo(
    () => [
      ...(directory.data?.[0].items ?? []).map((e) => ({
        ref: { kind: 'employee', id: e.id },
        type: 'employee' as const,
        label: e.data.name,
        detail: e.key ? `@${e.key}` : undefined,
      })),
      ...(directory.data?.[1].items ?? [])
        .filter((c) => c.data.kind !== 'ai' && !c.data.ai && c.id !== me.data?.contactId)
        .map((c) => ({
          ref: { kind: 'contact', id: c.id },
          type: 'person' as const,
          label: c.data.name,
          detail: c.data.role ?? (mpHandle(c) ? `@${mpHandle(c)}` : undefined),
        })),
    ],
    [directory.data, me.data],
  )

  const messages = useLoad((a) => (currentId ? a.channelMessages(currentId) : Promise.resolve([])), [currentId])
  const end = useRef<HTMLDivElement>(null)
  useLive(currentId ? [`chat:${currentId}`] : [], (e) => {
    if (e.topic !== 'chat.message') return
    const m = e.payload.message
    if (m.data.threadId === null) messages.setData((prev) => (prev ? upsertMessage(prev, m) : prev))
    else messages.reload()
  })
  const onChange = useCallback((m: Message) => messages.setData((prev) => (prev ? upsertMessage(prev, m) : prev)), [messages])
  const actions = useMessageActions(onChange)
  useMarkRead(currentId, messages.data?.length ?? 0, unread.reload)
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new messages, not to a highlighted one
  useEffect(() => {
    if (!highlight) end.current?.scrollIntoView?.({ block: 'end' })
  }, [messages.data?.length])

  // `/` focuses search, like Slack and Linear.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      e.preventDefault()
      searchBox.current?.focus()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])
  const [debounced, setDebounced] = useState(query)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200)
    return () => clearTimeout(t)
  }, [query])
  const search = useLoad(
    (a) => (debounced ? a.searchChat({ text: debounced, limit: 60 }) : Promise.resolve([] as ChatSearchResult[])),
    [debounced],
  )
  const openHit = (r: ChatSearchResult) => {
    setQuery('')
    const inThread = r.threadId !== r.message.id
    navigate(`/chat/${r.channel.id}${inThread ? `/${r.threadId}` : ''}?m=${r.message.id}`)
  }
  // The highlight from a search hit fades after a while.
  useEffect(() => {
    if (!highlight) return
    const t = setTimeout(() => {
      setParams(
        (prev) => {
          const n = new URLSearchParams(prev)
          n.delete('m')
          return n
        },
        { replace: true },
      )
    }, 6000)
    return () => clearTimeout(t)
  }, [highlight, setParams])

  const searchInput = (
    <div className="relative w-40 sm:w-64">
      <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-quaternary" />
      <Input
        ref={searchBox}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setQuery('')
            e.currentTarget.blur()
          }
        }}
        placeholder="Search messages"
        aria-label="Search messages"
        className="h-7 pr-7 pl-7 text-mini"
      />
      {query ? (
        <button
          type="button"
          onClick={() => setQuery('')}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 text-fg-quaternary hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="size-3.5" />
        </button>
      ) : (
        <Kbd className="absolute top-1/2 right-1.5 -translate-y-1/2 max-sm:hidden">/</Kbd>
      )}
    </div>
  )

  const searching = debounced.length > 0 && query.trim().length > 0
  return (
    <Page
      title="Chat"
      icon={<MessagesSquare />}
      className="relative flex overflow-hidden"
      actions={
        <>
          {searchInput}
          <Can>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={() => setDmOpen(true)} aria-label="New message">
                  <PenSquare />
                </Button>
              </TooltipTrigger>
              <TooltipContent>New message</TooltipContent>
            </Tooltip>
          </Can>
        </>
      }
    >
      {!list.data ? (
        <LoadingRows />
      ) : (
        <>
          <ChannelList
            channels={list.data}
            current={currentId}
            unread={unreadMap}
            meId={me.data?.contactId}
            onNew={() => setNewOpen(true)}
            onNewMessage={() => setDmOpen(true)}
          />
          <section className="flex min-w-0 flex-1 flex-col">
            {searching ? (
              <div className="min-h-0 flex-1 overflow-auto">
                <SearchResults
                  query={debounced}
                  results={search.loading && !search.data?.length ? undefined : search.data}
                  meId={me.data?.contactId}
                  channels={channelMap}
                  onOpen={openHit}
                />
              </div>
            ) : channel ? (
              <>
                <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4 md:px-6">
                  {channel.data.dm ? (
                    <AuthorAvatar
                      type={dmWithEmployee(channel, me.data?.contactId) ? 'employee' : 'person'}
                      name={channelLabel(channel, me.data?.contactId)}
                      className="size-4"
                    />
                  ) : (
                    <Hash className="size-4 shrink-0 text-fg-tertiary" />
                  )}
                  <span className="shrink-0 font-medium max-md:hidden">{channelLabel(channel, me.data?.contactId)}</span>
                  <select
                    value={channel.id}
                    onChange={(e) => navigate(`/chat/${e.target.value}`)}
                    className="h-7 min-w-0 rounded-md border bg-transparent px-1.5 font-medium md:hidden"
                    aria-label="Channel"
                  >
                    {list.data
                      .filter((c) => !c.channel.data.archived)
                      .map((c) => (
                        <option key={c.channel.id} value={c.channel.id}>
                          {c.channel.data.dm ? channelLabel(c.channel, me.data?.contactId) : `#${c.channel.data.name}`}
                          {(unreadMap.get(c.channel.id)?.unread ?? 0) > 0 && c.channel.id !== currentId
                            ? ` (${unreadMap.get(c.channel.id)!.unread})`
                            : ''}
                        </option>
                      ))}
                  </select>
                  {channel.data.topic && (
                    <span className="hidden truncate text-fg-tertiary sm:inline">· {channel.data.topic}</span>
                  )}
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
                    {!channel.data.dm && (
                      <AddMember
                        existing={channel.data.members.map((m) => m.id)}
                        onAdd={async (m) => {
                          await api.addMember(channel.id, m)
                          toast(`${m.label} added to #${channel.data.name}`)
                          list.reload()
                        }}
                      />
                    )}
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
                        me={meRef}
                        actions={actions}
                        active={m.id === threadId}
                        highlight={m.id === highlight && !threadId}
                        onOpenThread={() => navigate(`/chat/${channel.id}/${m.id}`)}
                      />
                    ))
                  )}
                  <div ref={end} />
                </div>
                <Can fallback={<ReadOnlyNote />}>
                  <Composer
                    placeholder={`Message ${channel.data.dm ? channelLabel(channel, me.data?.contactId) : `#${channel.data.name}`}`}
                    examples={tagExamples(channel, suggestions)}
                    suggestions={suggestions}
                    onSend={async (text) => {
                      const m = await api.postMessage(channel.id, { text })
                      onChange(m)
                    }}
                  />
                </Can>
              </>
            ) : (
              <EmptyState text="Pick a channel." />
            )}
          </section>
          {threadId && currentId && !searching && (
            <ThreadPanel
              threadId={threadId}
              channelId={currentId}
              me={meRef}
              suggestions={suggestions}
              highlight={highlight}
              onRead={unread.reload}
              onClose={() => navigate(`/chat/${currentId}`)}
            />
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
      <NewMessage
        open={dmOpen}
        onOpenChange={setDmOpen}
        candidates={dmCandidates}
        onOpened={(id) => {
          list.reload()
          navigate(`/chat/${id}`)
        }}
      />
    </Page>
  )
}
