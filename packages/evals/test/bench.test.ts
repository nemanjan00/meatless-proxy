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
  chainTaskText,
  chainTasks,
  classifyFuzzy,
  instructionsFor,
  scoreInstructions,
  scoreChainTask,
  fuzzyIncidents,
  fuzzyText,
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
    endPrompt: 0,
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
    expect(classifyFollowUps([x!], `${x!.ticket}, deploy ${x!.deploy}`)).toEqual({
      right: 1,
      invented: 0,
      abstained: 0,
      unanswered: 0,
    })
    expect(classifyFollowUps([x!], `I don't have the details of ${x!.id} and won't guess.`)).toEqual({
      right: 0,
      invented: 0,
      abstained: 1,
      unanswered: 0,
    })
    // An answer that never gets to the incident (the question was lost) is unanswered, not an honest no.
    expect(classifyFollowUps([x!], 'AUD-XXXX\nINC-00000 | a.ts:1 | Ana Lopez').unanswered).toBe(1)
    expect(classifyFollowUps([x!], 'TKT-0001, deploy zzzz')).toEqual({ right: 0, invented: 1, abstained: 0, unanswered: 0 })
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
    // Owning up to a missing one in prose isn't a wrong value.
    const id = first!.split(' | ')[0]
    const owned = scoreAnswer(a, [a.auditRef, `Note: ${id} was upgraded, but I no longer have its record.`, ...rest].join('\n'))
    expect(owned).toMatchObject({ wrongDetail: 0, missing: 2 })
  })
})

describe('fuzzy follow-ups', () => {
  it('describes incidents without their ids, each description fitting exactly one incident', () => {
    const a = buildArchive()
    const named = followUpIncidents(a, 5)
    const xs = fuzzyIncidents(a, 3, named)
    expect(xs).toHaveLength(3)
    const text = fuzzyText(xs)
    for (const x of xs) {
      expect(text).not.toContain(x.id)
      expect(named).not.toContain(x)
      const same = a.incidents.filter((y) => y.service === x.service && y.symptom === x.symptom && y.cause === x.cause)
      expect(same).toEqual([x])
    }
    // In other words than the archive's: the record's own phrases don't appear in the question.
    expect(text).not.toMatch(/connection pool exhaustion|stale results served|unbounded retry loop/)
  })

  it('scores numbered answers, telling invented details from abstaining', () => {
    const a = buildArchive()
    const xs = fuzzyIncidents(a, 3)
    const answer = [
      `1: ${xs[0]!.ticket}, deploy ${xs[0]!.deploy}`,
      '2: TKT-0001, deploy zzzz',
      "3: I can't tell which one that is.",
    ].join('\n')
    expect(classifyFuzzy(xs, answer)).toEqual({ right: 1, invented: 1, abstained: 1, unanswered: 0 })
    expect(classifyFuzzy(xs, 'AUD-XXXX\nINC-00000 | a.ts:1 | Ana Lopez').unanswered).toBe(3)
  })
})

describe('a chain of tasks', () => {
  it('splits the archive into tasks of five pages, each with its own answer and a question about the task before', () => {
    const a = buildArchive({ pages: 25, corrections: false })
    expect(a.corrections).toEqual([])
    const tasks = chainTasks(a, 5)
    expect(tasks.map((t) => [t.first, t.last])).toEqual([
      [0, 4],
      [5, 9],
      [10, 14],
      [15, 19],
      [20, 24],
    ])
    expect(tasks[0]!.cursor).toBe('start')
    expect(tasks[0]!.cross).toBeUndefined()
    for (const [k, t] of tasks.entries()) {
      if (k) expect(t.cross!.page).toBeGreaterThanOrEqual(tasks[k - 1]!.first)
      if (k) expect(t.cross!.page).toBeLessThanOrEqual(tasks[k - 1]!.last)
      expect(chainTaskText(t, k, 5)).toContain(`"cursor": "${t.cursor}"`)
    }
    const t = tasks[2]!
    const answer = [...t.expected, `CROSS: ${t.cross!.onCall}, ${t.cross!.ticket}`].join('\n')
    expect(scoreChainTask(t, answer)).toEqual({ correct: t.expected.length, expected: t.expected.length, cross: true })
    expect(scoreChainTask(t, t.expected.slice(1).join('\n'))).toMatchObject({ correct: t.expected.length - 1, cross: false })
  })
})

describe('instructions during the work', () => {
  it('picks a service with SEV1 incidents before the constraint and after the correction', () => {
    const a = buildArchive({ severe: 40 })
    const ins = instructionsFor(a)!
    const sev1 = new Set(a.expected.map((l) => l.split(' | ')[0]))
    const mine = a.incidents.filter((x) => sev1.has(x.id) && x.service === ins.service)
    expect(mine.some((x) => x.page <= ins.constraintAfter)).toBe(true)
    expect(mine.some((x) => x.page > ins.correctionAfter)).toBe(true)
    expect(ins.constraint).toContain(ins.service)
    // The correction doesn't repeat what it is about: following it takes remembering the constraint.
    expect(ins.correction).not.toContain(ins.service)
  })

  it('scores the report: their incidents kept and marked, nothing else marked', () => {
    const a = buildArchive({ severe: 40 })
    const ins = instructionsFor(a)!
    const service = new Map(a.incidents.map((x) => [x.id, x.service]))
    const theirs = (l: string) => service.get(l.split(' | ')[0]!) === ins.service
    expect(scoreInstructions(a, ins, a.expected.map((l) => (theirs(l) ? `${l} (review)` : l)).join('\n')).followed).toBe(true)
    // Forgot the correction: still left out.
    const left = scoreInstructions(a, ins, a.expected.filter((l) => !theirs(l)).join('\n'))
    expect(left).toMatchObject({ followed: false, marked: 0 })
    expect(left.dropped).toBeGreaterThan(0)
    // Forgot the constraint: kept, unmarked.
    expect(scoreInstructions(a, ins, a.expected.join('\n'))).toMatchObject({ followed: false, marked: 0 })
    // Marked the wrong ones.
    expect(scoreInstructions(a, ins, a.expected.map((l) => `${l} (review)`).join('\n')).wronglyMarked).toBeGreaterThan(0)
  })
})
