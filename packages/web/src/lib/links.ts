import type { EventSubject } from '@mp/api'
import { shortId } from '@/lib/format.ts'

/**
 * Where the things the harness talks about live: a subject (`<system>:<id>`, what an event or
 * subscription is about), a person's handle in another system, a project's repository. Each becomes
 * a short label and, when there is one, a link: in-app routes for the harness's own records,
 * web pages on Slack and GitLab for theirs. Anything unknown stays plain text.
 */

export const DEFAULT_GITLAB_URL = 'https://gitlab.com'

/** What a link or label needs to know about the deployment. */
export interface LinkContext {
  /** The deployment's GitLab (`GITLAB_BASE_URL`); a subject's own `baseUrl` wins. */
  gitlabBaseUrl?: string
}

/** A subject, a handle or a repository as shown: a label, its raw form, and where it opens. */
export interface LinkView {
  label: string
  /** The raw form, for the tooltip: `gitlab:acme/app!4`. */
  raw: string
  /** An in-app route (`/sessions/…`) or an external `https://` URL; none for plain text. */
  href?: string
  /** A Slack thread: its permalink is fetched when the link is about to be used (`href` opens the channel). */
  slack?: { channel: string; ts: string }
}

/** Whether a link leaves the app (opens in a new tab). */
export const isExternal = (href: string) => /^https?:\/\//.test(href)

const trimBase = (url: string) => url.replace(/\/+$/, '')

/** `slack:C0TEST0001/1700000000.000100` → `{ system: 'slack', ref: 'C0TEST0001/1700000000.000100' }`. */
export function parseSubjectKey(key: string): EventSubject {
  const i = key.indexOf(':')
  return i < 0 ? { system: '', ref: key } : { system: key.slice(0, i), ref: key.slice(i + 1) }
}

/** `https://slack.com/app_redirect?channel=<id>`: opens a channel, or a DM with a user id. */
export const slackRedirect = (id: string) => `https://slack.com/app_redirect?channel=${encodeURIComponent(id)}`

/** A GitLab project path in a URL: each segment encoded, the slashes kept. */
const gitlabPath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

/** The label and link of a subject. */
export function subjectView(subject: EventSubject, ctx: LinkContext = {}): LinkView {
  const { system, ref, title } = subject
  const raw = `${system}:${ref}`
  const plain = (label: string): LinkView => ({ label, raw })
  switch (system) {
    case 'mp': {
      const [id = '', rest] = ref.split('/', 2)
      const prefix = id.slice(0, id.indexOf('_'))
      if (prefix === 'msg') {
        const label = title ? `Thread: ${title}` : 'Chat thread'
        return subject.channelId ? { label, raw, href: `/chat/${subject.channelId}/${id}` } : plain(label)
      }
      if (prefix === 'ses')
        return { label: title ?? `Session ${shortId(id)}${rest ? ` · ${rest}` : ''}`, raw, href: `/sessions/${id}` }
      if (prefix === 'run' || prefix === 'evt')
        return { label: title ?? `${prefix === 'run' ? 'Run' : 'Event'} ${shortId(id)}`, raw, href: `/lineage/${id}` }
      return plain(title ?? raw)
    }
    case 'slack': {
      const [channel = '', ts] = ref.split('/', 2)
      if (!/^[A-Z0-9]+$/.test(channel)) return plain(title ?? raw)
      const where = subject.channelName ? `#${subject.channelName}` : channel.startsWith('D') ? 'a DM' : channel
      if (!ts) return { label: title ?? `Slack channel ${where}`, raw, href: slackRedirect(channel) }
      return { label: title ?? `Slack thread in ${where}`, raw, href: slackRedirect(channel), slack: { channel, ts } }
    }
    case 'gitlab': {
      const base = trimBase(subject.baseUrl ?? ctx.gitlabBaseUrl ?? DEFAULT_GITLAB_URL)
      const at = ref.indexOf('@')
      const bang = ref.lastIndexOf('!')
      const hash = ref.lastIndexOf('#')
      const link = (label: string, path: string, tail: string): LinkView => ({
        label: title ? `${label} · ${title}` : `${label} · ${path}`,
        raw,
        href: `${base}/${gitlabPath(path)}/-/${tail}`,
      })
      if (at > 0) {
        const path = ref.slice(0, at)
        const what = ref.slice(at + 1)
        const pipeline = /^pipeline\/(\d+)$/.exec(what)
        if (pipeline) return link(`Pipeline #${pipeline[1]}`, path, `pipelines/${pipeline[1]}`)
        if (what) return link(`branch ${what}`, path, `tree/${what.split('/').map(encodeURIComponent).join('/')}`)
      }
      if (bang > 0 && /^\d+$/.test(ref.slice(bang + 1)))
        return link(`MR !${ref.slice(bang + 1)}`, ref.slice(0, bang), `merge_requests/${ref.slice(bang + 1)}`)
      if (hash > 0 && /^\d+$/.test(ref.slice(hash + 1)))
        return link(`Issue #${ref.slice(hash + 1)}`, ref.slice(0, hash), `issues/${ref.slice(hash + 1)}`)
      return plain(title ?? raw)
    }
    case 'local-git': {
      const slash = ref.indexOf('/')
      if (slash <= 0) return plain(title ?? raw)
      const slug = ref.slice(0, slash)
      const branch = ref.slice(slash + 1)
      const label = `branch ${branch} · ${slug}`
      return subject.projectId
        ? { label, raw, href: `/projects/${subject.projectId}?branch=${encodeURIComponent(branch)}#local-repo-title` }
        : plain(label)
    }
    case 'linear':
      // Linear's issue URLs need the workspace's URL key, which the harness doesn't keep.
      return plain(title ? `${ref} · ${title}` : ref)
    default:
      return plain(title ?? raw)
  }
}

/** A person's handle: a Slack user opens a DM with them, a GitLab user their profile. */
export function handleView(handle: { system: string; id: string }, ctx: LinkContext = {}): LinkView {
  const raw = `${handle.system}:${handle.id}`
  if (handle.system === 'slack' && /^[UW][A-Z0-9]+$/.test(handle.id))
    return { label: handle.id, raw, href: slackRedirect(handle.id) }
  if (handle.system === 'gitlab' && /^[\w.-]+$/.test(handle.id))
    return {
      label: `@${handle.id}`,
      raw,
      href: `${trimBase(ctx.gitlabBaseUrl ?? DEFAULT_GITLAB_URL)}/${encodeURIComponent(handle.id)}`,
    }
  return { label: handle.id, raw }
}

/** A repository's host and path from an https or ssh URL (`git@host:group/repo.git`), without `.git`. */
function hostAndPath(url: string): { host: string; path: string } | null {
  const u = url.trim()
  const scp = /^[\w.-]+@([^:/]+):(?!\/)(.+)$/.exec(u)
  let host: string
  let path: string
  if (scp) {
    host = scp[1]!
    path = scp[2]!
  } else {
    let parsed: URL
    try {
      parsed = new URL(u)
    } catch {
      return null
    }
    if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol) || !parsed.hostname) return null
    host = parsed.hostname
    path = parsed.pathname
  }
  const clean = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  return clean ? { host: host.toLowerCase(), path: clean } : null
}

/**
 * A repository's web page: from `httpUrl` when set, else from its `url` (ssh or https). Null for a
 * local repository (`local:<slug>`) or a URL that isn't a web host.
 */
export function repoWebUrl(repo: { url: string; httpUrl?: string }): string | null {
  if (repo.url.startsWith('local:')) return null
  for (const u of [repo.httpUrl, repo.url]) {
    if (!u) continue
    const hp = hostAndPath(u)
    if (!hp) continue
    // An http(s) URL keeps its scheme and port; ssh becomes https on the same host.
    if (/^https?:\/\//i.test(u.trim())) {
      const parsed = new URL(u.trim())
      return `${parsed.protocol}//${parsed.host}/${hp.path}`
    }
    return `https://${hp.host}/${hp.path}`
  }
  return null
}

/** A repository as shown: its web page, and for one on the deployment's GitLab its merge requests and pipelines. */
export interface RepoView {
  raw: string
  /** Its project path or URL, shortened: `acme/app`. */
  label: string
  href?: string
  /** A repository the harness hosts: its Repository section on the project page. */
  local?: boolean
  mergeRequests?: string
  pipelines?: string
}

export function repoView(repo: { url: string; httpUrl?: string }, ctx: LinkContext = {}): RepoView {
  const raw = repo.url
  if (raw.startsWith('local:')) return { raw, label: raw.slice('local:'.length), local: true, href: '#local-repo-title' }
  const web = repoWebUrl(repo)
  if (!web) return { raw, label: raw }
  const url = new URL(web)
  const label = url.pathname.replace(/^\//, '')
  const gitlabHost = new URL(trimBase(ctx.gitlabBaseUrl ?? DEFAULT_GITLAB_URL)).host
  if (url.host !== gitlabHost) return { raw, label, href: web }
  return { raw, label, href: web, mergeRequests: `${web}/-/merge_requests`, pipelines: `${web}/-/pipelines` }
}

/** A harness thread subject with its title and channel filled in from threads the page already knows. */
export function threadSubject(
  subject: EventSubject,
  threads: { channelId: string; threadId: string; title: string }[],
): EventSubject {
  if (subject.system !== 'mp' || (subject.title && subject.channelId)) return subject
  const t = threads.find((x) => x.threadId === subject.ref)
  return t ? { ...subject, title: subject.title ?? t.title, channelId: subject.channelId ?? t.channelId } : subject
}

/** An event's subject, with the Slack channel's name from the event when it has one. */
export function eventSubject(e: { data: { subject?: EventSubject; payload?: unknown } }): EventSubject | undefined {
  const subject = e.data.subject
  if (subject?.system !== 'slack' || subject.channelName) return subject
  const name = (e.data.payload as { channel_name?: unknown } | null | undefined)?.channel_name
  return typeof name === 'string' && name ? { ...subject, channelName: name } : subject
}
