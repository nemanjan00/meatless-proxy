import type { ApiRef, Message } from '@mp/api'
import { MessageSquare, MoreHorizontal, Pencil, SmilePlus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AttachmentGrid } from '@/components/chat-attachments.tsx'
import { Markdown } from '@/components/markdown.tsx'
import { AuthorAvatar } from '@/components/people.tsx'
import { Button } from '@/components/ui/button.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { REACTIONS, reactionChips } from '@/lib/chat.ts'
import { formatDateTime, formatTime, timeAgo } from '@/lib/format.ts'
import { cn } from '@/lib/utils.ts'

/**
 * An author's name; a session's `@employee#slug` shows the employee, with the slug quieter and shortened.
 * An employee (its router context included) shows its `@handle` quieter after its name.
 */
function AuthorName({ author }: { author: Message['data']['author'] }) {
  const i = author.type === 'session' ? author.name.indexOf('#') : -1
  if (author.type === 'employee' && author.handle)
    return (
      <span className="flex min-w-0 items-baseline gap-1.5" title={`@${author.handle}`}>
        <span className="shrink-0 font-medium text-foreground">{author.name}</span>
        <span className="min-w-0 truncate font-mono text-micro text-fg-tertiary">@{author.handle}</span>
      </span>
    )
  if (i < 0) return <span className="shrink-0 font-medium text-foreground">{author.name}</span>
  return (
    <span className="flex min-w-0 items-baseline" title={author.name}>
      <span className="shrink-0 font-medium text-foreground">{author.name.slice(0, i)}</span>
      <span className="min-w-0 truncate font-mono text-micro text-fg-tertiary">{author.name.slice(i)}</span>
    </span>
  )
}

export interface MessageActions {
  react(m: Message, emoji: string, on: boolean): void
  edit(m: Message, text: string): Promise<void>
  remove(m: Message): void
}

function ReactionPicker({ onPick }: { onPick(emoji: string): void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="Add a reaction">
          <SmilePlus />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-auto gap-0.5 p-1" data-testid="reaction-picker">
        {REACTIONS.map((e) => (
          <button
            key={e}
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-base transition-quick hover:bg-accent"
            aria-label={`React ${e}`}
            onClick={() => {
              onPick(e)
              setOpen(false)
            }}
          >
            {e}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/**
 * One chat message: author, time, markdown with tags, "(edited)", a
 * placeholder once deleted, reaction chips, and on hover a toolbar with
 * reactions, reply in thread, and edit or delete for your own messages.
 */
export function MessageItem({
  m,
  me,
  actions,
  onOpenThread,
  active,
  highlight,
}: {
  m: Message
  /** You, to know your own messages and reactions. */
  me?: ApiRef
  actions?: MessageActions
  onOpenThread?: () => void
  active?: boolean
  /** Scrolled to and ringed, e.g. from a search result. */
  highlight?: boolean
}) {
  const d = m.data
  const own = !!me && d.author.type === 'person' && d.author.id === me.id
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(d.text)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (highlight) box.current?.scrollIntoView?.({ block: 'center' })
  }, [highlight])
  const chips = reactionChips(m, me)
  const save = async () => {
    if (!actions || !draft.trim()) return
    await actions.edit(m, draft.trim())
    setEditing(false)
  }
  return (
    <div
      ref={box}
      className={cn(
        'group relative flex gap-3 px-4 py-2 hover:bg-level-1 md:px-6',
        active && 'bg-accent-tint hover:bg-accent-tint',
        highlight && 'bg-accent-tint ring-1 ring-ring ring-inset',
      )}
      data-testid="chat-message"
      data-message-id={m.id}
    >
      <AuthorAvatar type={d.author.type} name={d.author.name} className="mt-0.5 size-7" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <AuthorName author={d.author} />
          {d.author.type !== 'person' && <span className="shrink-0 rounded-sm border px-1 text-tiny text-fg-tertiary">AI</span>}
          <span className="shrink-0 text-micro text-fg-quaternary" title={formatDateTime(m.createdAt)}>
            {formatTime(m.createdAt)}
          </span>
          {d.editedAt && !d.deleted && (
            <span className="shrink-0 text-micro text-fg-quaternary" title={`Edited ${formatDateTime(d.editedAt)}`}>
              (edited)
            </span>
          )}
        </div>
        {d.deleted ? (
          <p className="text-small text-fg-quaternary italic" data-testid="deleted-message">
            message deleted
          </p>
        ) : editing ? (
          <div className="mt-1">
            <Textarea
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  save()
                }
                if (e.key === 'Escape') {
                  setEditing(false)
                  setDraft(d.text)
                }
              }}
              className="min-h-12 text-small"
              aria-label="Edit message"
            />
            <div className="mt-1 flex items-center gap-2 text-micro text-fg-quaternary">
              <span>Enter to save · Esc to cancel</span>
              <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button size="xs" onClick={save} disabled={!draft.trim()}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <>
            {d.text && <Markdown text={d.text} className="text-small" tags />}
            {d.attachments?.length ? <AttachmentGrid attachments={d.attachments} /> : null}
          </>
        )}
        {chips.length > 0 && !d.deleted && (
          <div className="mt-1 flex flex-wrap gap-1" data-testid="reactions">
            {chips.map((c) => (
              <button
                key={c.emoji}
                type="button"
                onClick={() => actions?.react(m, c.emoji, !c.mine)}
                className={cn(
                  'flex h-6 items-center gap-1 rounded-full border px-1.5 text-micro tabular-nums text-fg-secondary transition-quick hover:border-[var(--fg-quaternary)]',
                  c.mine && 'border-ring/60 bg-accent-tint text-foreground',
                )}
                aria-pressed={c.mine}
                aria-label={`${c.emoji} ${c.count}${c.mine ? ', you reacted' : ''}`}
              >
                <span className="text-small leading-none">{c.emoji}</span>
                {c.count}
              </button>
            ))}
          </div>
        )}
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
      </div>
      {actions && !d.deleted && !editing && (
        <div
          className="absolute -top-3 right-4 flex items-center gap-0.5 rounded-md border bg-popover p-0.5 opacity-0 shadow-low transition-quick group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 md:right-6"
          data-testid="message-toolbar"
        >
          <ReactionPicker onPick={(e) => actions.react(m, e, !chips.find((c) => c.emoji === e)?.mine)} />
          {onOpenThread && (
            <Button variant="ghost" size="icon-xs" aria-label="Reply in thread" onClick={onOpenThread}>
              <MessageSquare />
            </Button>
          )}
          {own && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem
                  onSelect={() => {
                    setDraft(d.text)
                    setEditing(true)
                  }}
                >
                  <Pencil /> Edit message
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => actions.remove(m)}>
                  <Trash2 /> Delete message
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </div>
  )
}
