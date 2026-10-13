import { describe, expect, it } from 'vitest'
import {
  buildArchive,
  followUpIncident,
  followUpIncidents,
  followUpsText,
  scoreAnswer,
  scoreFollowUp,
  scoreFollowUps,
  classifyFollowUps,
} from '../src/bench/archive.ts'
import { ARMS, type PhaseStats, taskText } from '../src/bench/context.ts'
import { billed, median } from '../src/bench/summary.ts'

describe('context benchmark archive', () => {
  it('is the same for the same seed and different for another', () => {
    expect(buildArchive({ seed: 3 }).pages).toEqual(buildArchive({ seed: 3 }).pages)
    expect(buildArchive({ seed: 3 }).pages[1]).not.toEqual(buildArchive({ seed: 4 }).pages[1])
  })

  it('chains pages by cursor and puts the audit reference on page 1 only', () => {
    const a = buildArchive({ pages: 6 })
    expect(a.cursors[0]).toBe('start')
    for (let i = 0; i + 1 < a.pages.length; i++) expect(a.pages[i]).toContain(`"cursor": "${a.cursors[i + 1]}"`)
    expect(a.pages[0]).toContain(a.auditRef)
    expect(a.pages.slice(1).some((p) => p.includes(a.auditRef))).toBe(false)
  })

  it('applies corrections: downgraded incidents are not expected, upgraded ones are', () => {
    const a = buildArchive()
    const down = a.corrections.filter((c) => c.severity !== 1)
    const up = a.corrections.filter((c) => c.severity === 1)
    expect(down.length).toBeGreaterThan(0)
    expect(up.length).toBeGreaterThan(0)
    for (const c of down) expect(a.expected.some((l) => l.startsWith(`${c.id} |`))).toBe(false)
    for (const c of up) expect(a.expected.some((l) => l.startsWith(`${c.id} |`))).toBe(true)
    // A correction is always on a later page than its record.
    for (const c of a.corrections) expect(c.page).toBeGreaterThan(a.incidents.find((x) => x.id === c.id)!.page)
  })
})

describe('scoring', () => {
  const a = buildArchive()

  it('gives a perfect answer full marks, formatting aside', () => {
    const s = scoreAnswer(a, `**${a.auditRef}**\n${a.expected.map((l) => `\`${l}\``).join('\n')}`)
    expect(s).toMatchObject({ correct: a.expected.length, extra: 0, wrongDetail: 0, auditRef: true, f1: 1 })
  })

  it('counts a wrong line number as wrong detail, and a non-severe incident as extra', () => {
    const [first, ...rest] = a.expected
    const wrong = first!.replace(/:(\d+) \|/, (_, n) => `:${Number(n) + 1} |`)
    const minor = a.incidents.find((x) => x.severity === 3)!
    const s = scoreAnswer(a, [wrong, ...rest, `${minor.id} | ${minor.file}:${minor.line} | ${minor.onCall}`].join('\n'))
    expect(s.correct).toBe(a.expected.length - 1)
    expect(s.wrongDetail).toBe(1)
    expect(s.extra).toBe(1)
    expect(s.auditRef).toBe(false)
    expect(s.f1).toBeLessThan(1)
  })

  it('scores an empty answer as zero', () => {
    expect(scoreAnswer(a, '')).toMatchObject({ correct: 0, f1: 0, auditRef: false })
  })
})

describe('the follow-up question', () => {
  it('asks about a minor incident on an early page, and needs both its ticket and its deploy id', () => {
    const a = buildArchive()
    const x = followUpIncident(a)
    expect(x.page).toBe(2)
    expect(x.severity).not.toBe(1)
    expect(a.pages[2]).toContain(`Follow-up: ${x.ticket}.`)
    expect(a.pages[2]).toContain(`after deploy ${x.deploy}.`)
    expect(scoreFollowUp(x, `${x.ticket}, deploy ${x.deploy}`)).toBe(true)
    expect(scoreFollowUp(x, `${x.ticket}, deploy zzzz`)).toBe(false)
    expect(scoreFollowUp(x, `deploy ${x.deploy}`)).toBe(false)
  })
})

describe('arms', () => {
  it('compares classic compaction with ours, and only the managed arm gets the context tools', () => {
    expect(ARMS.map((x) => x.name)).toEqual(['classic', 'safety-net', 'managed-early', 'managed'])
    expect(ARMS.find((x) => x.name === 'classic')!.env).toMatchObject({ CONTEXT_COMPACT_KEEP: '0', CONTEXT_NOTES: 'off' })
    expect(ARMS.filter((x) => x.contextTools).map((x) => x.name)).toEqual(['managed-early', 'managed'])
    expect(taskText(20)).toContain('20 pages')
  })
})

describe('summary', () => {
  const stats = (o: Partial<PhaseStats>): PhaseStats => ({
    calls: 1,
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    peakPrompt: 0,
    compactions: 0,
    compactionsFailed: 0,
    collapses: 0,
    offloads: 0,
    restores: 0,
    notes: 0,
    reads: 0,
    retries: 0,
    durationMs: 0,
    ...o,
  })

  it('weighs cached reads at a tenth and output at five times an input token', () => {
    expect(billed(stats({ promptTokens: 1000, cachedTokens: 600, completionTokens: 10 }))).toBe(400 + 60 + 50)
    // A provider reporting more cached than prompt tokens can't make a call cheaper than all-cached.
    expect(billed(stats({ promptTokens: 100, cachedTokens: 500 }))).toBe(10)
  })

  it('takes medians, so one runaway run does not hide the typical one', () => {
    expect(median([100, 108, 492])).toBe(108)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([])).toBe(0)
  })
})

describe('scaling', () => {
  it('scales the facts to keep: 150 severe incidents still fit, each expected once', () => {
    const a = buildArchive({ severe: 150 })
    expect(a.expected.length).toBe(150)
    expect(new Set(a.expected).size).toBe(150)
  })

  it('spreads several follow-ups across the archive and scores each one', () => {
    const a = buildArchive()
    const xs = followUpIncidents(a, 5)
    expect(xs).toHaveLength(5)
    expect(new Set(xs.map((x) => x.page)).size).toBe(5)
    expect(xs.every((x) => !a.expected.some((l) => l.startsWith(`${x.id} |`)))).toBe(true)
    const answer = xs.map((x, i) => `${x.id}: ${x.ticket}, deploy ${i === 0 ? 'zzzz' : x.deploy}`).join('\n')
    expect(scoreFollowUps(xs, answer)).toBe(4)
    expect(followUpsText(xs)).toContain(xs[4]!.id)
  })
})

describe('wrong follow-ups', () => {
  it('tells abstaining from inventing', () => {
    const a = buildArchive()
    const [x] = followUpIncidents(a, 1)
    expect(classifyFollowUps([x!], `${x!.ticket}, deploy ${x!.deploy}`)).toEqual({ right: 1, invented: 0, abstained: 0 })
    expect(classifyFollowUps([x!], "I don't have its details and won't guess.")).toEqual({ right: 0, invented: 0, abstained: 1 })
    expect(classifyFollowUps([x!], 'TKT-0001, deploy zzzz')).toEqual({ right: 0, invented: 1, abstained: 0 })
  })
})

describe('report errors', () => {
  it('tells a wrong value from a missing incident', () => {
    const a = buildArchive()
    const [first, second, ...rest] = a.expected
    const wrong = first!.replace(/:(\d+) \|/, (_, n) => `:${Number(n) + 1} |`)
    // The first with a wrong line number, the second left out.
    const s = scoreAnswer(a, [a.auditRef, wrong, ...rest].join('\n'))
    expect(s).toMatchObject({ correct: a.expected.length - 2, wrongDetail: 1, missing: 1, extra: 0 })
    expect(second).toBeTruthy()
  })
})
