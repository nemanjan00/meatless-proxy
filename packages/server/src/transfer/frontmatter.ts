import { ValidationError, stableStringify } from '@mp/core'

/**
 * Markdown with YAML frontmatter, in the subset this module writes: one
 * `key: value` line per field, where a value is a plain scalar, or JSON in
 * flow style (JSON is valid YAML) for strings that need quoting, lists and
 * objects. The parser reads that subset back, plus the usual hand edits
 * (quoted strings, numbers, booleans, `null`, `# comments`, blank lines).
 */

export interface MarkdownDoc {
  fields: Record<string, unknown>
  body: string
}

const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_ .@/+-]*$/
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~'])

/** Whether a string can be written without quotes and read back as the same string. */
function plainSafe(s: string): boolean {
  if (!PLAIN.test(s) || s !== s.trim()) return false
  if (RESERVED.has(s.toLowerCase())) return false
  if (/^[-+]?(\d|\.\d)/.test(s)) return false
  return !s.includes(': ') && !s.includes(' #')
}

function scalar(v: unknown): string {
  if (typeof v === 'string') return plainSafe(v) ? v : JSON.stringify(v)
  return stableStringify(v)
}

/**
 * Serialises fields and a body. Keys keep the given order (callers sort them),
 * `undefined` values are skipped. The output always ends with a newline.
 */
export function stringifyMarkdown(fields: Record<string, unknown>, body = ''): string {
  const lines = ['---']
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new ValidationError(`frontmatter key ${JSON.stringify(k)} is not a plain name`)
    lines.push(`${k}: ${scalar(v)}`)
  }
  lines.push('---')
  const text = body.replace(/\s+$/, '')
  return `${lines.join('\n')}\n${text ? `\n${text}\n` : ''}`
}

function parseValue(raw: string, where: string): unknown {
  const v = raw.trim()
  if (v === '' || v === '~' || v === 'null') return null
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) return Number(v)
  const c = v[0]
  if (c === '"' || c === '[' || c === '{') {
    try {
      return JSON.parse(v)
    } catch {
      throw new ValidationError(`${where}: not valid JSON/YAML flow value`)
    }
  }
  if (c === "'") {
    if (!v.endsWith("'") || v.length < 2) throw new ValidationError(`${where}: unterminated quoted string`)
    return v.slice(1, -1).replace(/''/g, "'")
  }
  const hash = v.search(/\s#/)
  return hash >= 0 ? v.slice(0, hash).trimEnd() : v
}

/** Parses a markdown file with optional frontmatter. `name` is used in error messages. */
export function parseMarkdown(text: string, name = 'document'): MarkdownDoc {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!src.startsWith('---\n')) return { fields: {}, body: src.replace(/^\n+|\s+$/g, '') }
  const end = src.indexOf('\n---', 3)
  if (end < 0) throw new ValidationError(`${name}: frontmatter is not closed with ---`)
  const head = src.slice(4, end)
  const rest = src.slice(end + 4)
  const fields: Record<string, unknown> = {}
  head.split('\n').forEach((line, i) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/.exec(line)
    if (!m) throw new ValidationError(`${name}: frontmatter line ${i + 2} is not "key: value"`)
    fields[m[1]!] = parseValue(m[2]!, `${name}: ${m[1]}`)
  })
  return { fields, body: rest.replace(/^[^\n]*\n?/, '').replace(/^\n+|\s+$/g, '') }
}
