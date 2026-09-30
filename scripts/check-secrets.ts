/**
 * Fails if any tracked (or staged) file looks like it contains a secret. The
 * repo is public, so this runs in CI and should run before every commit.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname

const PATTERNS: [string, RegExp][] = [
  ['Kimi / OpenAI-style API key', /\bsk-(?:kimi-|proj-|ant-)?[A-Za-z0-9_-]{24,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Linear API key', /\blin_api_[A-Za-z0-9]{32,}\b/],
  ['password in URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{6,}@/i],
]

const ALLOW = [/example/i, /\bxxx+/i, /<[^>]+>/]

/**
 * Private terms: names, workspace and user ids, message text and the like from a live deployment, which must
 * never be copied into tests, comments or docs. One per line (# comments), in `.private-terms`, which is
 * git-ignored and never committed (the list itself is private). Matched case-insensitively.
 */
const PRIVATE_TERMS_FILE = '.private-terms'
const privateTerms = (() => {
  try {
    return readFileSync(join(root, PRIVATE_TERMS_FILE), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.toLowerCase())
  } catch {
    return []
  }
})()

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

const problems: string[] = []
for (const f of files) {
  if (f === PRIVATE_TERMS_FILE) {
    problems.push(`${f}: the private terms list must not be committed`)
    continue
  }
  if (f.endsWith('package-lock.json') || f.startsWith('scripts/check-secrets')) continue
  const p = join(root, f)
  let text: string
  try {
    if (statSync(p).size > 2_000_000) continue
    text = readFileSync(p, 'utf8')
  } catch {
    continue
  }
  if (f === '.env' || (/(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example')))
    problems.push(`${f}: env files must not be committed`)
  text.split('\n').forEach((line, i) => {
    for (const [what, re] of PATTERNS) {
      const m = re.exec(line)
      if (m && !ALLOW.some((a) => a.test(m[0]))) problems.push(`${f}:${i + 1}: looks like a ${what}`)
    }
    const lower = line.toLowerCase()
    for (const term of privateTerms)
      if (lower.includes(term)) problems.push(`${f}:${i + 1}: contains a private term (${PRIVATE_TERMS_FILE})`)
  })
}

if (problems.length) {
  console.error(`Possible secrets found (${problems.length}):\n` + problems.map((p) => `  - ${p}`).join('\n'))
  process.exit(1)
}
console.log(`No secrets found in ${files.length} files.`)
