/** Named entities worth decoding in page text; the rest are rare enough to stay as they are. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  times: '×',
  rarr: '→',
  larr: '←',
}

/** Decodes HTML entities: numeric ones and the common named ones. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const PRE_NEWLINE = '\u0000'

/** Elements dropped with everything in them: code, styling, page chrome and controls. */
const DROPPED = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'nav',
  'footer',
  'form',
  'button',
  'select',
]

/** Elements that end a line of text. */
const BLOCK =
  'p|div|section|article|main|header|aside|blockquote|pre|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|figure|figcaption|address|details|summary|hr|h[1-6]'

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim()) : undefined
}

const absolute = (href: string, base: string | undefined) => {
  try {
    return base ? new URL(href, base).href : new URL(href).href
  } catch {
    return href
  }
}

/**
 * A page's readable text, from its HTML: the title, headings as `#`, list items as `-`, links as
 * `text (url)` (absolute against `baseUrl`), table cells separated by `|`, image alt text, and
 * preformatted text as it is. Scripts, styles, navigation, footers and forms are left out.
 */
export function htmlToText(html: string, baseUrl?: string): { title?: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch
    ? decodeEntities(titleMatch[1]!.replace(/<[^>]+>/g, ''))
        .replace(/\s+/g, ' ')
        .trim()
    : undefined
  let s = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<head[\s>][\s\S]*?<\/head>/i, '')
  // The main content when the page marks it, else the whole body.
  const main = /<main[\s>][\s\S]*<\/main>/i.exec(s)?.[0] ?? /<article[\s>][\s\S]*<\/article>/i.exec(s)?.[0]
  if (main && main.replace(/<[^>]+>/g, '').trim().length > 200) s = main
  for (const t of DROPPED) s = s.replace(new RegExp(`<${t}[\\s>/][\\s\\S]*?</${t}\\s*>`, 'gi'), ' ')
  s = s
    .replace(/<pre[\s>][\s\S]*?<\/pre>/gi, (m) => m.replace(/\r?\n/g, PRE_NEWLINE))
    .replace(/<a\s[^>]*>[\s\S]*?<\/a>/gi, (m) => {
      const href = attr(m, 'href')
      const text = m
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) return text
      const url = absolute(href, baseUrl)
      if (!text) return url
      return decodeEntities(text) === url ? url : `${text} (${url})`
    })
    .replace(/<img\s[^>]*>/gi, (m) => {
      const alt = attr(m, 'alt')
      return alt ? ` [image: ${alt}] ` : ' '
    })
    .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<li(?:\s[^>]*)?>/gi, '\n- ')
    .replace(/<tr(?:\s[^>]*)?>/gi, '\n')
    .replace(/<\/tr\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(t[dh])[^>]*>/gi, ' | ')
    .replace(new RegExp(`</?(?:${BLOCK})(?:\\s[^>]*)?>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  const text = s
    .split('\n')
    .map((l) =>
      l
        .replace(/[ \t\f\v ]+/g, ' ')
        .replace(/(\s*\|\s*)+/g, ' | ')
        .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
        .trim(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replaceAll(PRE_NEWLINE, '\n')
    .trim()
  return { ...(title ? { title } : {}), text }
}
