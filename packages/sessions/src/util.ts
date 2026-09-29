import { ValidationError, type Json } from '@mp/core'

/** `"Fix the Login bug!"` -> `"fix-the-login-bug"`. Falls back to `session`. */
export function slugify(title: string, maxLength = 60): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')
  return s || 'session'
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g

/** Placeholder names used in a text, in order of first use. */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))]
}

/**
 * Fills `{{name}}` placeholders. Declared parameters without a value become
 * empty; undeclared placeholders without a value are left as they are.
 */
export function fillPlaceholders(text: string, params: Record<string, string>, declared: Iterable<string> = []): string {
  const known = new Set(declared)
  return text.replace(PLACEHOLDER, (whole, name: string) => params[name] ?? (known.has(name) ? '' : whole))
}

/** Throws `ValidationError` naming every required parameter that has no (non-empty) value. */
export function checkRequiredParams(
  declared: { name: string; required?: boolean }[] | undefined,
  params: Record<string, string>,
): void {
  const missing = (declared ?? []).filter((p) => p.required && !params[p.name]).map((p) => p.name)
  if (missing.length)
    throw new ValidationError(
      'missing required template parameters',
      missing.map((m) => `${m} is required`),
    )
}

/** The readable text of entry content: every string in it, joined. */
export function contentText(content: Json): string {
  const out: string[] = []
  const walk = (v: Json) => {
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    else if (v !== null) out.push(String(v))
  }
  walk(content)
  return out.join(' ')
}

/** About `width` characters of `text` around the first case-insensitive match of `needle`. */
export function snippet(text: string, needle: string, width = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= width) return flat
  const at = needle ? flat.toLowerCase().indexOf(needle.toLowerCase()) : -1
  if (at < 0) return `${flat.slice(0, width - 1)}…`
  const before = Math.floor((width - needle.length) / 2)
  let start = Math.max(0, at - Math.max(0, before))
  const end = Math.min(flat.length, start + width)
  start = Math.max(0, end - width)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}
