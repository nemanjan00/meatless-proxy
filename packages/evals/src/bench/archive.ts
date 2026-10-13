/**
 * A synthetic incident archive for the context benchmark: pages of incident records, read one at a time
 * through a cursor chain, with a few severe incidents among many minor ones, corrections on later pages, and
 * an audit reference on the first page that the final answer must quote. Everything is generated from a
 * seed, so every arm of the benchmark reads exactly the same text.
 */

export interface Incident {
  id: string
  severity: 1 | 2 | 3 | 4
  service: string
  file: string
  line: number
  onCall: string
  page: number
  /** Set when the page is written: details nobody asks about until the follow-up question. */
  deploy?: string
  ticket?: string
}

export interface Correction {
  id: string
  /** The severity it really has. */
  severity: 1 | 2 | 3 | 4
  page: number
}

export interface Archive {
  pages: string[]
  cursors: string[]
  auditRef: string
  incidents: Incident[]
  corrections: Correction[]
  /** What a correct answer lists: every incident whose final severity is 1, as `INC-… | path:line | name`. */
  expected: string[]
}

export interface ArchiveOptions {
  seed?: number
  pages?: number
  perPage?: number
  /** Severity-1 incidents as first recorded (some are then downgraded, and others upgraded, by corrections). */
  severe?: number
}

const FIRST = ['Ana', 'Bo', 'Cara', 'Dev', 'Eli', 'Fen', 'Gus', 'Hana', 'Ivo', 'Jun', 'Kai', 'Lea', 'Mio', 'Nils', 'Ola', 'Pia']
const LAST = ['Lopez', 'Ode', 'Diaz', 'Marsh', 'Quist', 'Rowe', 'Sand', 'Teller', 'Ueda', 'Voss', 'Wren', 'Yates']
const SERVICES = [
  'ledger-api',
  'checkout',
  'search-indexer',
  'auth-gateway',
  'notifier',
  'billing-worker',
  'media-cdn',
  'reports',
]
const DIRS = ['src/ledger', 'src/checkout', 'src/search', 'src/auth', 'src/notify', 'src/billing', 'src/media', 'src/reports']
const FILES = ['pool.ts', 'retry.ts', 'handler.ts', 'cache.ts', 'queue.ts', 'client.ts', 'schema.ts', 'limits.ts', 'session.ts']
const SYMPTOMS = [
  'elevated p99 latency',
  'a spike of 5xx responses',
  'stuck jobs in the queue',
  'stale results served',
  'login failures for some users',
  'duplicate notifications',
  'timeouts on the export endpoint',
  'memory growth until restart',
]
const CAUSES = [
  'connection pool exhaustion',
  'an unbounded retry loop',
  'a missing index after a migration',
  'a cache key collision',
  'a race between two writers',
  'an expired client certificate',
  'a schema mismatch after deploy',
  'a rate limit set too low',
]

/** A small, fast, seeded PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T>(xs: readonly T[]) => xs[int(xs.length)]!
  const token = (n: number) => Array.from({ length: n }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[int(31)]).join('')
  return { next, int, pick, token }
}

export function buildArchive(o: ArchiveOptions = {}): Archive {
  const pageCount = o.pages ?? 20
  const perPage = o.perPage ?? 22
  const severe = o.severe ?? 12
  const r = rng(o.seed ?? 7)
  const auditRef = `AUD-${r.token(4).toUpperCase()}-${10 + r.int(90)}`
  const cursors = Array.from({ length: pageCount }, (_, i) => (i === 0 ? 'start' : r.token(6)))

  // Severe incidents land on pages 2 … n-2, spread out; everything else is minor.
  const usedIds = new Set<string>()
  const newId = () => {
    let id: string
    do id = `INC-${10000 + r.int(89999)}`
    while (usedIds.has(id))
    usedIds.add(id)
    return id
  }
  const incidents: Incident[] = []
  const severePages = Array.from({ length: severe }, (_, i) => 1 + Math.floor(((i + 0.5) * (pageCount - 3)) / severe))
  for (let p = 0; p < pageCount; p++) {
    const sev1Here = severePages.filter((x) => x === p).length
    for (let k = 0; k < perPage; k++) {
      const svc = r.int(SERVICES.length)
      incidents.push({
        id: newId(),
        severity: k < sev1Here ? 1 : ((2 + r.int(3)) as 2 | 3 | 4),
        service: SERVICES[svc]!,
        file: `${DIRS[svc]}/${r.pick(FILES)}`,
        line: 20 + r.int(480),
        onCall: `${r.pick(FIRST)} ${r.pick(LAST)}`,
        page: p,
      })
    }
  }
  // Shuffle within each page so the severe ones aren't always first.
  const byPage = Array.from({ length: pageCount }, (_, p) => incidents.filter((x) => x.page === p))
  for (const list of byPage)
    for (let i = list.length - 1; i > 0; i--) {
      const j = r.int(i + 1)
      ;[list[i], list[j]] = [list[j]!, list[i]!]
    }

  // Corrections on later pages: two severe ones downgraded, two minor ones (SEV2) upgraded.
  const sev1 = incidents.filter((x) => x.severity === 1)
  const sev2 = incidents.filter((x) => x.severity === 2 && x.page < pageCount - 4)
  const corrections: Correction[] = []
  for (const x of [sev1[1], sev1[Math.floor(sev1.length / 2)]]) {
    if (x) corrections.push({ id: x.id, severity: 2, page: Math.min(pageCount - 1, x.page + 4 + r.int(4)) })
  }
  for (const x of [sev2[3], sev2[Math.floor(sev2.length / 2)]]) {
    if (x) corrections.push({ id: x.id, severity: 1, page: Math.min(pageCount - 1, x.page + 4 + r.int(4)) })
  }

  const finalSeverity = new Map(incidents.map((x) => [x.id, x.severity as number]))
  for (const c of corrections) finalSeverity.set(c.id, c.severity)
  const expected = incidents
    .filter((x) => finalSeverity.get(x.id) === 1)
    .map((x) => `${x.id} | ${x.file}:${x.line} | ${x.onCall}`)

  const record = (x: Incident) => {
    x.deploy = r.token(4)
    x.ticket = `TKT-${1000 + r.int(9000)}`
    const day = 1 + r.int(28)
    const hh = String(r.int(24)).padStart(2, '0')
    const mm = String(r.int(60)).padStart(2, '0')
    const noise = Array.from(
      { length: 3 },
      () =>
        `  ${hh}:${String(r.int(60)).padStart(2, '0')}:${String(r.int(60)).padStart(2, '0')} ${x.service} worker-${r.int(40)} ` +
        `${r.pick(['WARN', 'ERROR', 'INFO'])} req=${r.token(10)} dur=${50 + r.int(9000)}ms status=${r.pick(['200', '502', '504', '429', '500'])}`,
    ).join('\n')
    return [
      `${x.id} · 2026-03-${String(day).padStart(2, '0')} ${hh}:${mm} UTC · SEV${x.severity} · service: ${x.service}`,
      `Summary: ${r.pick(SYMPTOMS)} after deploy ${x.deploy}.`,
      `Root cause: ${r.pick(CAUSES)} in ${x.file}:${x.line}.`,
      `On call: ${x.onCall}. Follow-up: ${x.ticket}.`,
      'Log excerpt:',
      noise,
    ].join('\n')
  }

  const pages = byPage.map((list, p) => {
    const head = [
      `INCIDENT ARCHIVE — page ${p + 1} of ${pageCount}`,
      ...(p === 0
        ? [
            `Audit reference: ${auditRef} (quote it at the top of any audit report built from this archive).`,
            'Severity scale: SEV1 = customer-facing outage, SEV2 = degraded, SEV3/SEV4 = minor.',
          ]
        : []),
      '',
    ]
    const fixes = corrections
      .filter((c) => c.page === p)
      .map((c) => `CORRECTION: ${c.id} was reclassified as SEV${c.severity} after review. This supersedes its original record.`)
    const body = list.map(record)
    const next =
      p + 1 < pageCount
        ? `\n— end of page ${p + 1}. Next: archive.read_page { "page": ${p + 2}, "cursor": "${cursors[p + 1]}" }`
        : '\n— end of the archive.'
    return [...head, ...(fixes.length ? [...fixes, ''] : []), body.join('\n\n'), next].join('\n')
  })

  return { pages, cursors, auditRef, incidents, corrections, expected }
}

export interface Score {
  /** Expected lines found exactly (id, file:line and on-call all right). */
  correct: number
  expected: number
  /** Lines in the answer that name an incident not in the expected set. */
  extra: number
  /** Expected incidents named, but with a wrong file, line or person. */
  wrongDetail: number
  /** Expected incidents the answer doesn't name at all (dropped, not blurred). */
  missing: number
  auditRef: boolean
  /** correct / expected, minus a penalty for extras, and 0 without the audit reference counted separately. */
  f1: number
}

/** Scores a final answer against the archive: exact lines, extras, and the audit reference. */
export function scoreAnswer(archive: Archive, answer: string): Score {
  const norm = (s: string) => s.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim()
  const text = norm(answer)
  const expectedById = new Map(archive.expected.map((l) => [l.split(' | ')[0]!, norm(l)]))
  const mentioned = new Set(text.match(/INC-\d{5}/g) ?? [])
  let correct = 0
  let wrongDetail = 0
  for (const [id, line] of expectedById) {
    if (text.includes(line)) correct++
    else if (mentioned.has(id)) wrongDetail++
  }
  // Incidents the answer lists as severe that aren't: count ids on lines that look like answer rows.
  const rows = answer.split('\n').filter((l) => /INC-\d{5}\s*\|/.test(l))
  const extra = rows.map((l) => l.match(/INC-\d{5}/)![0]).filter((id) => !expectedById.has(id)).length
  const precision = rows.length ? (rows.length - extra) / rows.length : 0
  const recall = correct / archive.expected.length
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
  return {
    correct,
    expected: archive.expected.length,
    extra,
    wrongDetail,
    missing: archive.expected.length - correct - wrongDetail,
    auditRef: text.includes(archive.auditRef),
    f1,
  }
}

/**
 * The incident a follow-up question asks about: a minor one on an early page, so its details were read long
 * before the question, and no summary written for the audit report had a reason to keep them.
 */
export function followUpIncident(archive: Archive): Incident {
  const page = Math.min(2, archive.pages.length - 1)
  const x =
    archive.incidents.find((i) => i.page === page && i.severity === 3) ??
    archive.incidents.find((i) => i.page === page && i.severity !== 1)!
  return x
}

export function followUpText(x: Incident): string {
  return `One more question about the archive: what were the follow-up ticket and the deploy id of ${x.id}? Reply with just: TKT-1234, deploy abcd`
}

/** Whether a follow-up answer has both the ticket and the deploy id of the incident. */
export function scoreFollowUp(x: Incident, answer: string): boolean {
  return answer.includes(x.ticket!) && new RegExp(`\\b${x.deploy}\\b`).test(answer)
}

/**
 * The incidents several follow-up questions ask about: minor ones (never severe, never corrected) on pages spread
 * across the archive, so the answers sit in different stretches of what was read. One gives the page-3 question.
 */
export function followUpIncidents(archive: Archive, count = 1): Incident[] {
  if (count <= 1) return [followUpIncident(archive)]
  const last = archive.pages.length - 1
  const corrected = new Set(archive.corrections.map((c) => c.id))
  const out: Incident[] = []
  for (let i = 0; i < count; i++) {
    const page = Math.round(1 + (i * (last - 1)) / (count - 1))
    const x = archive.incidents.find((y) => y.page === page && y.severity !== 1 && !corrected.has(y.id) && !out.includes(y))
    if (x) out.push(x)
  }
  return out
}

export function followUpsText(xs: Incident[]): string {
  if (xs.length === 1) return followUpText(xs[0]!)
  return [
    `A few more questions about the archive: for each of these incidents, what were the follow-up ticket and the deploy id? ${xs.map((x) => x.id).join(', ')}`,
    'Reply with one line each, exactly: INC-12345: TKT-1234, deploy abcd',
  ].join('\n')
}

/** How many follow-ups an answer got right: the incident's line (or the whole answer, for one) has both details. */
export function scoreFollowUps(xs: Incident[], answer: string): number {
  if (xs.length === 1) return scoreFollowUp(xs[0]!, answer) ? 1 : 0
  const lines = answer.split('\n')
  return xs.filter((x) => lines.some((l) => l.includes(x.id) && scoreFollowUp(x, l))).length
}

/**
 * How follow-up answers went, per incident: right (both details), invented (a ticket or deploy id that isn't its
 * own: a hallucination), or abstained (said it doesn't have them). For an employee, inventing is far worse.
 */
export function classifyFollowUps(xs: Incident[], answer: string): { right: number; invented: number; abstained: number } {
  const lines = xs.length === 1 ? [answer] : answer.split('\n')
  let right = 0
  let invented = 0
  for (const x of xs) {
    const mine = xs.length === 1 ? answer : lines.filter((l) => l.includes(x.id)).join('\n')
    if (scoreFollowUp(x, mine)) right++
    else if ((mine.match(/TKT-\d+/g) ?? []).some((t) => t !== x.ticket) || /deploy[:\s]+[a-z0-9]{4}\b/i.test(mine)) invented++
  }
  return { right, invented, abstained: xs.length - right - invented }
}
