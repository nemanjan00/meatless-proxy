/** A tag as written in a message: `@name` or `@name#session-slug`. */
export interface ParsedTag {
  /** Exactly as written, e.g. `@billing-bot#pay-123`. */
  raw: string
  name: string
  slug?: string
}

// `@` must not follow a character that could be part of an email's local part or a word.
const TAG_RE =
  /(?<![A-Za-z0-9._%+\-@/:])@([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:#([A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?))?/g

/** Removes fenced code blocks and inline code spans. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ')
}

/**
 * Tags in a message, in order of first appearance, without duplicates
 * (case-insensitive). Emails (`ana@example.com`) and anything inside code
 * spans or fenced code blocks are ignored.
 */
export function parseTags(text: string): ParsedTag[] {
  const out: ParsedTag[] = []
  const seen = new Set<string>()
  const src = stripCode(text)
  for (const m of src.matchAll(TAG_RE)) {
    const end = (m.index ?? 0) + m[0].length
    // `@ana@example.com` or `@host.example.com/path`-like continuations are not tags.
    if (src[end] === '@') continue
    const key = m[0].toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ raw: m[0], name: m[1]!, ...(m[2] ? { slug: m[2] } : {}) })
  }
  return out
}
