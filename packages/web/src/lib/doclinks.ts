/**
 * Documents and chat messages link to records by id: `[[contact:con_01J…]]`
 * or `[[project:pro_01J…|Payments]]`. For rendering, links become markdown
 * links to the record's page, labelled with the given label or a resolved
 * title; tags (`@billing-bot#pay-123-refund`, `@ana`) become styled spans.
 */
const LINK_RE = /\[\[([a-z][a-z0-9_-]*):([a-z][a-z0-9]*_[0-9A-Za-z]+)(?:\|([^\]]*))?\]\]/g

export interface DocLink {
  kind: string
  id: string
  label?: string
}

export function parseDocLinks(markdown: string): DocLink[] {
  const out: DocLink[] = []
  const seen = new Set<string>()
  for (const m of markdown.matchAll(LINK_RE)) {
    const key = `${m[1]}:${m[2]}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind: m[1]!, id: m[2]!, ...(m[3] ? { label: m[3] } : {}) })
  }
  return out
}

/** The UI route for a record. */
export function hrefFor(kind: string, id: string): string {
  switch (kind) {
    case 'session':
      return `/sessions/${id}`
    case 'run':
      return `/lineage/${id}`
    case 'event':
      return `/lineage/${id}`
    case 'contact':
      return `/contacts/${id}`
    case 'project':
      return `/projects/${id}`
    case 'procedure':
      return `/procedures/${id}`
    case 'skill':
      return `/skills/${id}`
    case 'memory':
      return `/memory/${id}`
    case 'channel':
      return `/chat/${id}`
    default:
      return `/records/${kind}/${id}`
  }
}

/** Rewrites `[[kind:id|label]]` into markdown links. `resolve` names unlabelled links. */
export function linkifyDoc(markdown: string, resolve?: (kind: string, id: string) => string | undefined): string {
  return markdown.replace(LINK_RE, (_all, kind: string, id: string, label?: string) => {
    const text = label || resolve?.(kind, id) || `${kind}:${id}`
    return `[${text.replace(/[[\]]/g, '')}](${hrefFor(kind, id)})`
  })
}

/** Tags in chat text: `@employee`, `@employee#session-slug`, `@person`. */
export const TAG_RE = /(^|[\s(])(@[a-z][a-z0-9-]*(?:#[a-z0-9][a-z0-9-]*)?)/g

/** Wraps tags in inline code with a marker so the renderer can style them. */
export function markTags(text: string): string {
  return text.replace(TAG_RE, (_all, pre: string, tag: string) => `${pre}[${tag}](tag:${encodeURIComponent(tag)})`)
}
