import type { InboxItem } from '@mp/api'
import { AtSign, CircleAlert, Gauge, Inbox, ShieldCheck, Stamp } from 'lucide-react'
import { Link } from 'react-router'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { Page } from '@/components/page.tsx'
import { EmployeeAvatar } from '@/components/people.tsx'
import { useLiveReload, useLoad } from '@/lib/api.tsx'
import { timeAgo } from '@/lib/format.ts'
import { cn } from '@/lib/utils.ts'

const TYPE: Record<InboxItem['type'], { icon: typeof Inbox; label: string; color: string }> = {
  approval: { icon: Stamp, label: 'Approval', color: 'var(--blue)' },
  mention: { icon: AtSign, label: 'Mention', color: 'var(--fg-tertiary)' },
  paused_run: { icon: CircleAlert, label: 'Paused', color: 'var(--status-paused)' },
  review: { icon: ShieldCheck, label: 'Review', color: 'var(--indigo)' },
  limit: { icon: Gauge, label: 'Limit', color: 'var(--orange)' },
}

export function inboxHref(i: InboxItem): string {
  if (i.channelId && i.threadId) return `/chat/${i.channelId}/${i.threadId}`
  if (i.sessionId) return `/sessions/${i.sessionId}`
  return '/usage'
}

/** Threads you were pulled into, approvals, paused runs and reviews. */
export function InboxPage() {
  const list = useLoad((api) => api.inbox(), [])
  useLiveReload(['now'], list.reload, ['run.state'])
  const items = list.data ?? []
  return (
    <Page title="Inbox" icon={<Inbox />}>
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
