/**
 * Fails if a markdown file in the repo links to a file that doesn't exist, or
 * to a heading (`#anchor`) that doesn't exist in the target markdown file.
 * External links (http, mailto) aren't checked. Runs in CI.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter((f) => f && existsSync(join(root, f)))

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to dashes, duplicates numbered. */
function anchorsOf(markdown: string): Set<string> {
  const out = new Set<string>()
  const counts = new Map<string, number>()
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence
    const m = !inFence && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const text = m[1]!
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s/g, '-')
    const n = counts.get(base) ?? 0
    counts.set(base, n + 1)
    out.add(n === 0 ? base : `${base}-${n}`)
  }
  return out
}

const cache = new Map<string, Set<string>>()
const anchors = (file: string) => {
  let a = cache.get(file)
  if (!a) {
    a = anchorsOf(readFileSync(file, 'utf8'))
    cache.set(file, a)
  }
  return a
}

const problems: string[] = []
const LINK_RE = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g

for (const f of files) {
  const abs = join(root, f)
  const text = readFileSync(abs, 'utf8')
  let inFence = false
  text.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (inFence) return
    for (const m of line.replace(/`[^`]*`/g, '').matchAll(LINK_RE)) {
      const target = m[1]!
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue // http:, https:, mailto:, …
      const [path, anchor] = target.split('#') as [string, string | undefined]
      const dest = path ? normalize(join(dirname(abs), decodeURIComponent(path))) : abs
      if (!existsSync(dest)) {
        problems.push(`${f}:${i + 1}: ${target} → ${relative(root, dest)} does not exist`)
        continue
      }
      if (anchor && dest.endsWith('.md') && statSync(dest).isFile() && !anchors(dest).has(anchor.toLowerCase())) {
        problems.push(`${f}:${i + 1}: ${target} → no heading #${anchor} in ${relative(root, dest)}`)
      }
    }
  })
}

if (problems.length) {
  console.error(`Broken links (${problems.length}):\n` + problems.map((p) => `  - ${p}`).join('\n'))
  process.exit(1)
}
console.log(`All links OK in ${files.length} markdown files.`)
