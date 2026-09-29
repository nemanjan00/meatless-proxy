import type { Ref } from '@mp/store'

/**
 * Documents link to records by id: `[[contact:con_01J…]]`, optionally with a
 * label: `[[project:pro_01J…|Payments]]`. Ids never change, so links don't
 * break when names do.
 */
const LINK_RE = /\[\[([a-z][a-z0-9_-]*):([a-z][a-z0-9]*_[0-9A-Za-z]+)(?:\|([^\]]*))?\]\]/g

export interface DocLink extends Ref {
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

export function docLink(ref: Ref, label?: string): string {
  return `[[${ref.kind}:${ref.id}${label ? `|${label}` : ''}]]`
}

/** Markdown chapters, split on headings. A chapter's body runs until the next heading of the same or a higher level. */
export interface Chapter {
  heading: string
  level: number
  /** The chapter's text without its heading line. */
  body: string
  start: number
  end: number
}

export function chapters(markdown: string): Chapter[] {
  const lines = markdown.split('\n')
  const heads: { heading: string; level: number; line: number }[] = []
  let inFence = false
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) inFence = !inFence
    const m = !inFence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l)
    if (m) heads.push({ heading: m[2]!, level: m[1]!.length, line: i })
  })
  const offsets: number[] = []
  let pos = 0
  for (const l of lines) {
    offsets.push(pos)
    pos += l.length + 1
  }
  return heads.map((h, idx) => {
    const next = heads.slice(idx + 1).find((n) => n.level <= h.level)
    const endLine = next ? next.line : lines.length
    const body = lines
      .slice(h.line + 1, endLine)
      .join('\n')
      .replace(/^\n+|\n+$/g, '')
    return {
      heading: h.heading,
      level: h.level,
      body,
      start: offsets[h.line]!,
      end: next ? offsets[next.line]! : markdown.length,
    }
  })
}

export function findChapter(markdown: string, heading: string): Chapter | undefined {
  const norm = (s: string) => s.trim().toLowerCase()
  return chapters(markdown).find((c) => norm(c.heading) === norm(heading))
}

/** Replaces a chapter's body, or appends a new chapter at `level` if it doesn't exist. */
export function upsertChapter(markdown: string, heading: string, body: string, level = 2): string {
  const c = findChapter(markdown, heading)
  const text = body.replace(/^\n+|\n+$/g, '')
  if (!c) {
    const sep = markdown.length === 0 ? '' : markdown.endsWith('\n\n') ? '' : markdown.endsWith('\n') ? '\n' : '\n\n'
    return `${markdown}${sep}${'#'.repeat(level)} ${heading}\n\n${text}\n`
  }
  const headLine = markdown.slice(c.start).split('\n', 1)[0]!
  const after = markdown.slice(c.end)
  return `${markdown.slice(0, c.start)}${headLine}\n\n${text}\n${after ? '\n' + after : ''}`
}
