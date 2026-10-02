import type { ApiClient, EventSubject } from '@mp/api'
import type { MouseEvent, ReactNode } from 'react'
import { useState } from 'react'
import { Link } from 'react-router'
import { useDeploymentNetwork } from '@/lib/auth.tsx'
import { useOptionalApi } from '@/lib/api.tsx'
import { handleView, isExternal, type LinkContext, type LinkView, repoView, subjectView } from '@/lib/links.ts'
import { cn } from '@/lib/utils.ts'

/**
 * A link that looks and behaves like a link in chat (components/markdown.tsx): in-app routes go
 * through the router, anything else opens in a new tab without the opener.
 */
export function ChatLink({
  href,
  children,
  className,
  title,
  onPrefetch,
  testId,
  inRow = false,
}: {
  href: string
  children: ReactNode
  className?: string
  title?: string
  /** Called when the link is about to be used (hover, focus, press), e.g. to fetch a better URL. */
  onPrefetch?(): void
  testId?: string
  /** It sits in a clickable row: following it doesn't also click the row. */
  inRow?: boolean
}) {
  const cls = cn('doc-link', className)
  const stop = inRow ? (e: MouseEvent) => e.stopPropagation() : undefined
  const prefetch = onPrefetch ? { onMouseEnter: onPrefetch, onFocus: onPrefetch, onPointerDown: onPrefetch } : {}
  if (href.startsWith('/'))
    return (
      <Link to={href} className={cls} title={title} onClick={stop} data-testid={testId} {...prefetch}>
        {children}
      </Link>
    )
  return (
    <a
      href={href}
      className={cls}
      title={title}
      onClick={stop}
      data-testid={testId}
      {...(isExternal(href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      {...prefetch}
    >
      {children}
    </a>
  )
}

/** The deployment's link context (its GitLab), from `GET /api/me`. */
export function useLinkContext(): LinkContext {
  const d = useDeploymentNetwork()
  return d?.gitlabBaseUrl ? { gitlabBaseUrl: d.gitlabBaseUrl } : {}
}

/** Slack permalinks already fetched, by subject: they don't change. */
const permalinks = new Map<string, Promise<string | null>>()

/** Forgets fetched permalinks (tests). */
export function clearPermalinkCache() {
  permalinks.clear()
}

function fetchPermalink(api: ApiClient, raw: string, scope: { sessionId?: string; eventId?: string }) {
  let p = permalinks.get(raw)
  if (!p) {
    p = api
      .subjectPermalink({ subject: raw, ...scope })
      .then((r) => (r.permalink ? r.url : null))
      .catch(() => {
        permalinks.delete(raw)
        return null
      })
    permalinks.set(raw, p)
  }
  return p
}

/** A label, linked when there is somewhere to go; the raw form in the tooltip. */
function ViewLink({
  view,
  className,
  onPrefetch,
  href,
}: {
  view: LinkView
  className?: string
  onPrefetch?(): void
  href?: string
}) {
  const to = href ?? view.href
  if (!to)
    return (
      <span className={cn('min-w-0 truncate', className)} title={view.raw} data-testid="subject-text">
        {view.label}
      </span>
    )
  return (
    <ChatLink
      href={to}
      title={view.raw}
      className={cn('min-w-0 truncate', className)}
      testId="subject-link"
      inRow
      {...(onPrefetch ? { onPrefetch } : {})}
    >
      {view.label}
    </ChatLink>
  )
}

/**
 * What a subject is (`gitlab:acme/app!4`, `slack:C…/…`, `mp:msg_…`), as a short label linked to it.
 * A Slack thread opens its channel until its permalink is fetched, when the link is about to be
 * used; that needs the session (`sessionId`) or event (`eventId`) the subject belongs to.
 */
export function SubjectLink({
  subject,
  sessionId,
  eventId,
  className,
}: {
  subject: EventSubject
  sessionId?: string
  eventId?: string
  className?: string
}) {
  const view = subjectView(subject, useLinkContext())
  const api = useOptionalApi()
  const [permalink, setPermalink] = useState<string | null>(null)
  const scope = sessionId ? { sessionId } : eventId ? { eventId } : null
  const prefetch =
    view.slack && api && scope && !permalink
      ? () => {
          void fetchPermalink(api, view.raw, scope).then((url) => url && setPermalink(url))
        }
      : undefined
  return (
    <ViewLink
      view={view}
      className={className}
      {...(prefetch ? { onPrefetch: prefetch } : {})}
      {...(permalink ? { href: permalink } : {})}
    />
  )
}

/** A person's handle in another system, linked to them there (a Slack DM, a GitLab profile). */
export function HandleLink({ handle, className }: { handle: { system: string; id: string }; className?: string }) {
  return <ViewLink view={handleView(handle, useLinkContext())} className={cn('font-mono', className)} />
}

/**
 * A project's repository: its web page, plus merge requests and pipelines on the deployment's
 * GitLab; a local one points at the project's Repository section. The raw URL is in the tooltip.
 */
export function RepoLinks({
  repo,
  projectId,
  compact = false,
  className,
}: {
  repo: { url: string; httpUrl?: string }
  /** The project, when this isn't its own page: a local repository links to its page's Repository section. */
  projectId?: string
  /** Only the repository's own link. */
  compact?: boolean
  className?: string
}) {
  const view = repoView(repo, useLinkContext())
  const v = compact ? { ...view, mergeRequests: undefined, pipelines: undefined } : view
  if (v.local && projectId) v.href = `/projects/${projectId}#local-repo-title`
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)} data-testid="repo-links">
      {v.href ? (
        <ChatLink href={v.href} title={v.raw} className="min-w-0 truncate font-mono text-micro" testId="repo-link">
          {v.label}
        </ChatLink>
      ) : (
        <span className="min-w-0 truncate font-mono text-micro text-fg-secondary" title={v.raw}>
          {v.label}
        </span>
      )}
      {v.local && !compact && <span className="shrink-0 text-micro text-fg-quaternary">hosted here</span>}
      {v.mergeRequests && (
        <ChatLink href={v.mergeRequests} className="shrink-0 text-micro">
          Merge requests
        </ChatLink>
      )}
      {v.pipelines && (
        <ChatLink href={v.pipelines} className="shrink-0 text-micro">
          Pipelines
        </ChatLink>
      )}
    </span>
  )
}
