import type { InboxItem } from '@mp/api'
import { BellRing, CircleAlert, Inbox, X } from 'lucide-react'
import { EmployeeAvatar, PersonAvatar } from '@/components/people.tsx'
import { Button } from '@/components/ui/button.tsx'
import { isWarning, placeOf } from '@/lib/notify.ts'
import { cn } from '@/lib/utils.ts'

/** The toast frame: popover surface, 1 px border, 8 px radius, the high float shadow (stylebook). Sonner's width. */
const FRAME =
  'pointer-events-auto relative w-[356px] max-w-[calc(100vw-32px)] rounded-lg border bg-popover p-3 text-popover-foreground shadow-high'

function Avatar({ item }: { item: InboxItem }) {
  if (isWarning(item) && !item.author)
    return <CircleAlert className="mt-0.5 size-5 shrink-0" style={{ color: 'var(--status-paused)' }} />
  const a = item.author
  if (a?.type === 'person') return <PersonAvatar name={a.name} className="mt-0.5 size-6" />
  const name = a?.name ?? item.employee?.name
  if (name) return <EmployeeAvatar name={name} className="mt-0.5 size-6" />
  return <BellRing className="mt-0.5 size-5 shrink-0 text-fg-tertiary" />
}

/** One new inbox item: who, where, two lines of what, and Open / Mark read. */
export function InboxToast({
  item,
  onOpen,
  onMarkRead,
  onClose,
}: {
  item: InboxItem
  onOpen(): void
  onMarkRead(): void
  onClose(): void
}) {
  const warn = isWarning(item)
  const who = item.author?.name ?? item.employee?.name
  const ai = item.author ? item.author.type !== 'person' : !!item.employee
  return (
    <div
      className={cn(FRAME, warn && 'border-l-2 border-l-[var(--status-paused)]')}
      data-testid="inbox-toast"
      data-warning={warn || undefined}
      role="status"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        className="absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded-sm text-fg-quaternary transition-quick hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
      <div className="flex gap-2.5 pr-5">
        <Avatar item={item} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-mini">
            <span className="truncate font-medium text-foreground">{who ?? item.title}</span>
            {who && ai && <span className="shrink-0 rounded-sm border px-1 text-tiny text-fg-tertiary">AI</span>}
            <span className="shrink-0 text-fg-quaternary">·</span>
            <span className={cn('truncate text-micro', warn ? 'text-[var(--status-paused)]' : 'text-fg-tertiary')}>
              {placeOf(item)}
            </span>
          </div>
          {who && item.type !== 'mention' && item.type !== 'reply' && item.type !== 'dm' && (
            <div className="truncate text-micro text-fg-secondary">{item.title}</div>
          )}
          {item.detail && <p className="mt-0.5 line-clamp-2 text-micro text-fg-secondary">{item.detail}</p>}
          <div className="mt-2 flex gap-1">
            <Button size="xs" variant="secondary" onClick={onOpen}>
              Open
            </Button>
            <Button size="xs" variant="ghost" className="text-fg-tertiary" onClick={onMarkRead}>
              Mark read
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** A burst of items as one toast: "5 new notifications" and Open inbox. */
export function InboxBurstToast({ count, onOpen, onClose }: { count: number; onOpen(): void; onClose(): void }) {
  return (
    <div className={FRAME} data-testid="inbox-burst-toast" role="status">
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        className="absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded-sm text-fg-quaternary transition-quick hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
      <div className="flex items-center gap-2.5 pr-5">
        <Inbox className="size-4 shrink-0 text-fg-tertiary" />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{count} new notifications</span>
        <Button size="xs" variant="secondary" onClick={onOpen}>
          Open inbox
        </Button>
      </div>
    </div>
  )
}
