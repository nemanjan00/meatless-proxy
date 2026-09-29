/** `Ana Lopez` -> `ana-lopez`. Used for `@name` handles and employee keys. */
export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const STOP = new Set(
  'a an and are as at be by can do does for from has have how i in is it its me my of on or our please should so that the this to we what when where which who why will with you your'.split(
    ' ',
  ),
)

/** Lowercase keywords of a text, without stop words and duplicates. */
export function keywords(text: string): string[] {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
  return [...new Set(words)]
}

/** Sum of `weight` for every keyword found in a field, over weighted fields. */
export function scoreText(words: string[], fields: [text: string | undefined, weight: number][]): number {
  let score = 0
  for (const [text, weight] of fields) {
    if (!text) continue
    const t = text.toLowerCase()
    for (const w of words) if (t.includes(w)) score += weight
  }
  return score
}
