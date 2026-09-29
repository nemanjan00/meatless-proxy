import type { InboxItem } from '@mp/api'
import {
  AtSign,
  CheckCheck,
  CircleAlert,
  CirclePause,
  Gauge,
  Inbox,
  MessageCircle,
  MessageSquareReply,
  ShieldCheck,
  Siren,
  Stamp,
  X,
} from 'lucide-react'
import { Link } from 'react-router'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { Page } from '@/components/page.tsx'
import { EmployeeAvatar } from '@/components/people.tsx'
import { Button } from '@/components/ui/button.tsx'
import { timeAgo } from '@/lib/format.ts'
import { useNotifications } from '@/lib/notifications.tsx'
import { inboxHref } from '@/lib/notify.ts'
import { cn } from '@/lib/utils.ts'

const TYPE: Record<InboxItem['type'], { icon: typeof Inbox; label: string; color: string }> = {
  approval: { icon: Stamp, label: 'Approval', color: 'var(--blue)' },
  mention: { icon: AtSign, label: 'Mention', color: 'var(--fg-tertiary)' },
  reply: { icon: MessageSquareReply, label: 'Reply', color: 'var(--fg-tertiary)' },
  dm: { icon: MessageCircle, label: 'DM', color: 'var(--fg-tertiary)' },
  alert: { icon: Siren, label: 'Alert', color: 'var(--status-paused)' },
  paused_run: { icon: CircleAlert, label: 'Paused', color: 'var(--status-paused)' },
  waiting: { icon: CirclePause, label: 'Waiting', color: 'var(--status-waiting)' },
  review: { icon: ShieldCheck, label: 'Review', color: 'var(--indigo)' },
  limit: { icon: Gauge, label: 'Limit', color: 'var(--orange)' },
}

export { inboxHref }

/**
 * Mentions of you, DMs, replies in your threads, alerts, paused runs and reviews. New ones arrive
 * live (lib/notifications.tsx). Read on click; clearable.
 */
export function InboxPage() {
  const { items: data, error, reload, markRead: mark } = useNotifications()
  const list = { data, error, reload }
  const items = data ?? []
  const unread = items.filter((i) => !i.read)
  return (
    <Page
      title="Inbox"
      icon={<Inbox />}
      actions={
        items.length > 0 ? (
          <>
            <Button
              size="xs"
              variant="ghost"
              className="text-fg-tertiary"
              disabled={!unread.length}
              onClick={() => mark({ ids: unread.map((i) => i.id) })}
            >
              <CheckCheck />
              Mark all read
            </Button>
            <Button size="xs" variant="ghost" className="text-fg-tertiary" onClick={() => mark({ clear: true })}>
              <X />
              Clear
            </Button>
          </>
        ) : null
      }
    >
      {list.error && !list.data ? (
        <ErrorState error={list.error} retry={list.reload} />
      ) : !list.data ? (
        <LoadingRows />
      ) : items.length === 0 ? (
        <EmptyState
          text="You're all caught up."
          action={
            <Link to="/now" className="text-[#828fff] hover:underline">
              See what's running
            </Link>
          }
        />
      ) : (
        <div className="py-1">
          {items.map((i) => {
            const t = TYPE[i.type]
            const Icon = t.icon
            return (
              <Link
                key={i.id}
                to={inboxHref(i)}
                onClick={() => !i.read && mark({ ids: [i.id] })}
                className="group flex h-12 items-center gap-3 px-6 hover:bg-secondary"
                data-testid="inbox-item"
              >
                <span className={cn('size-1.5 shrink-0 rounded-full', i.read ? 'bg-transparent' : 'bg-[var(--brand)]')} />
                <Icon className="size-4 shrink-0" style={{ color: t.color }} />
                <div className="min-w-0 flex-1">
                  <div className={cn('truncate', i.read ? 'text-fg-secondary' : 'font-medium text-foreground')}>{i.title}</div>
                  {i.detail && <div className="truncate text-micro text-fg-tertiary">{i.detail}</div>}
                </div>
                <span className="shrink-0 rounded-sm border px-1 text-tiny text-fg-tertiary">{t.label}</span>
                {i.employee && <EmployeeAvatar name={i.employee.name} className="size-4" />}
                <span className="w-8 shrink-0 text-right text-micro text-fg-quaternary">{timeAgo(i.at)}</span>
              </Link>
            )
          })}
        </div>
      )}
    </Page>
  )
}
