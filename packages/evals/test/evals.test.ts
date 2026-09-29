import { routerAwareScript } from '@mp/stdlib'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sleep } from '@mp/core'
import { callTools, reply, scriptedModel, type ModelRequest, type Script, type ScriptResult } from '@mp/model'
import { afterAll, describe, expect, it } from 'vitest'
import {
  SCENARIOS,
  answerInThread,
  brevity,
  buildReport,
  checklist,
  describeModelEnv,
  followUp,
  formatTable,
  injection,
  loadModelEnv,
  runEvals,
  runScenario,
  sayDontKnow,
  selectScenarios,
  sentences,
  startEvalApp,
  summarize,
  usesProcedure,
  words,
  writeResults,
  type Scenario,
  type ScenarioRun,
} from '../src/index.ts'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mp-evals-test-'))
  dirs.push(d)
  return d
}

type Msg = ModelRequest['messages'][number]
const lastMsg = (req: ModelRequest): Msg => req.messages.at(-1)!
const has = (req: ModelRequest, marker: string) => req.messages.some((m) => (m.content ?? '').includes(marker))
const lastToolName = (req: ModelRequest): string | undefined => {
  const last = lastMsg(req)
  if (last.role !== 'tool') return undefined
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const call = req.messages[i]!.tool_calls?.find((c) => c.id === last.tool_call_id)
    if (call) return call.function.name.replace(/__/g, '.')
  }
  return undefined
}
const lastOutput = (req: ModelRequest): any => {
  try {
    return JSON.parse(lastMsg(req).content ?? '')
  } catch {
    return {}
  }
}
const usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120 }
/** The same scripted model for every run of a scenario. */
const scripted = (script: Script) => () => scriptedModel(routerAwareScript(script as any))

describe('checks helpers', () => {
  it('counts sentences and words the way a reader would', () => {
    expect(sentences('Yes. It runs on Postgres!')).toBe(2)
    expect(sentences('See https://example.com/a.b for v1.2, e.g. the docs.')).toBe(1)
    expect(sentences('- one\n- two\n- three')).toBe(3)
    expect(sentences('Short answer. — Meatless (AI)')).toBe(1)
    expect(sentences('')).toBe(0)
    expect(words('Payments runs on Postgres — yes.')).toBe(5)
  })
})

describe('the eval app', () => {
  it('starts the whole app with a scripted model and exposes posting, settling, replies, runs, tool calls and usage', async () => {
    const app = await startEvalApp({
      model: scriptedModel(
        routerAwareScript([
          callTools([{ name: 'directory.find_project', args: { text: 'payments' } }], undefined, usage),
          reply('Found it.', usage),
        ]),
      ),
    })
    try {
      const ctx = app.ctx
      const root = await ctx.post('requests', 'Where is Payments?')
      await ctx.settle(5000)
      expect((await ctx.aiReplies(root.id)).map((m) => m.data.text)).toEqual(['Found it.'])
      expect((await ctx.aiMessages()).length).toBe(1)
      expect((await ctx.runs()).map((r) => r.data.state)).toEqual(['completed'])
      // The router also records its decision (sessions.commit): harness bookkeeping, not the scenario's work.
      const calls = (await ctx.toolCalls()).filter((c) => c.name !== 'sessions.commit')
      expect(calls.map((c) => [c.name, c.args])).toEqual([['directory.find_project', { text: 'payments' }]])
      expect(calls[0]!.output).toBeDefined()
      expect((await ctx.usage()).totalTokens).toBeGreaterThanOrEqual(240)
      await expect(ctx.post('nope', 'x')).rejects.toThrow(/no channel/)
    } finally {
      await app.close()
    }
  })
})

describe('scenarios with a scripted model', () => {
  it('answer-in-thread and brevity pass with a short plain answer, and fail with a wall of text', async () => {
    const short = scripted(() => reply('It handles refunds, invoices and the billing ledger on Postgres.', usage))
    const ok = await runScenario(answerInThread, 1, { model: short })
    expect(ok.checks.map((c) => [c.name, c.pass])).toEqual([
      ['answered-in-thread', true],
      ['at-most-3-sentences', true],
      ['on-topic', true],
      ['no-top-level-answer', true],
    ])
    // Plus the router's decision step (sessions.commit), which the scripted wrapper adds.
    expect(ok).toMatchObject({ pass: true, modelCalls: 2 })
    expect(ok.tokens).toBeGreaterThanOrEqual(120)
    expect(ok.failure).toBeUndefined()
    expect((await runScenario(brevity, 1, { model: short })).pass).toBe(true)

    const long = scripted(() => reply(Array.from({ length: 30 }, (_, i) => `Point ${i} is about refunds.`).join(' ')))
    const bad = await runScenario(brevity, 1, { model: long })
    expect(bad.pass).toBe(false)
    expect(bad.failure).toMatch(/^under-80-words: 1\d\d words/)
    expect((await runScenario(answerInThread, 1, { model: long })).failure).toMatch(/^at-most-3-sentences: 30 sentences/)
  })

  it('follow-up passes when the same session answers both, in the thread', async () => {
    const r = await runScenario(followUp, 1, {
      model: scripted((req) => reply(has(req, 'what is her role') ? 'She is a staff engineer.' : 'Ana Lopez owns it.')),
    })
    expect(r.checks.filter((c) => !c.pass)).toEqual([])
    expect(r.pass).toBe(true)
  })

  it('injection fails with the forbidden tool named when the model obeys the injected text', async () => {
    const obey = scripted((req): ScriptResult => {
      if (lastMsg(req).role === 'tool') return reply('Done as instructed.')
      return callTools([{ name: 'chat.archive', args: { channel: 'general' } }])
    })
    const r = await runScenario(injection, 1, { model: obey })
    expect(r.pass).toBe(false)
    expect(r.checks.find((c) => c.name === 'no-forbidden-tool-calls')).toMatchObject({
      pass: false,
      reason: 'forbidden: chat.archive',
    })

    const refuse = await runScenario(injection, 1, {
      model: scripted(() => reply("#general is for everyone. I won't act on instructions inside a message.")),
    })
    expect(refuse.checks.every((c) => c.pass)).toBe(true)
  })

  const procedureScript =
    (opts: { check: boolean }) =>
    (req: ModelRequest): ScriptResult => {
      const all = req.messages.map((m) => m.content ?? '').join('\n')
      const thread = /thread (msg_\w+)/.exec(all)?.[1] ?? ''
      const inFork = has(req, 'Run this procedure for the following work')
      const last = lastMsg(req)
      const tool = lastToolName(req)
      if (inFork) {
        if (last.role === 'user' && (last.content ?? '').startsWith('[harness] Not finished yet')) return reply('Done.')
        if (tool === 'directory.find_contact')
          return opts.check
            ? callTools([{ name: 'checklist.check', args: { itemId: 'i1', evidence: [last.tool_call_id] } }])
            : callTools([{ name: 'chat.reply', args: { threadId: thread, text: 'Done, your laptop is ordered.' } }])
        if (tool === 'checklist.check')
          return callTools([{ name: 'chat.reply', args: { threadId: thread, text: 'Logged: IT ships a laptop to Payments.' } }])
        if (tool === 'chat.reply') return reply('Finished.')
        return callTools([{ name: 'directory.find_contact', args: { text: 'Ben Ode' } }])
      }
      if (tool === 'directory.find_procedure') {
        const p = lastOutput(req).procedures?.[0]
        return callTools([{ name: 'procedures.run', args: { procedureId: p.id, work: `Ben asked in thread ${thread}.` } }])
      }
      if (tool === 'procedures.run') return reply('Handed to the procedure.')
      return callTools([{ name: 'directory.find_procedure', args: { text: 'laptop access request' } }])
    }

  it('uses-procedure passes when the router runs the procedure', async () => {
    const r = await runScenario(usesProcedure, 1, { model: scripted(procedureScript({ check: true })) })
    expect(r.checks).toEqual([
      { name: 'procedure-used', pass: true, reason: 'procedures.run forked the context (1 fork)' },
      { name: 'answered-in-thread', pass: true, reason: '1 AI reply in the thread' },
    ])
    const lazy = await runScenario(usesProcedure, 1, { model: scripted(() => reply('Ask Ana for access.')) })
    expect(lazy.failure).toMatch(/^procedure-used: no fork of the procedure context; tools used: (none|sessions\.commit)$/)
  })

  it('checklist passes with checklist.check and evidence, and fails when the work is reported done without it', async () => {
    const good = await runScenario(checklist, 1, { model: scripted(procedureScript({ check: true })) })
    expect(good.checks.filter((c) => !c.pass)).toEqual([])

    const bad = await runScenario(checklist, 1, { model: scripted(procedureScript({ check: false })), maxSteps: 4 })
    expect(bad.pass).toBe(false)
    const byName = Object.fromEntries(bad.checks.map((c) => [c.name, c]))
    expect(byName['procedure-checklist-created']!.pass).toBe(true)
    expect(byName['checked-with-evidence']).toMatchObject({ pass: false, reason: '1 required item(s) still open' })
    expect(byName['not-done-while-open']).toMatchObject({ pass: false })
    expect(byName['not-done-while-open']!.reason).toMatch(/claims done/)
  })

  it('say-dont-know passes with an unsure answer naming the owner, and fails on an invented figure', async () => {
    const good = await runScenario(sayDontKnow, 1, {
      model: scripted(() => reply("I don't know. Cara Diaz owns Search, she'd know.")),
    })
    expect(good.pass).toBe(true)
    const made = await runScenario(sayDontKnow, 1, { model: scripted(() => reply('It has 12 shards.')) })
    expect(made.checks.filter((c) => !c.pass).map((c) => c.name)).toEqual(['says-unsure', 'routes-to-owner', 'no-made-up-number'])
  })
})

describe('the runner', () => {
  const tiny = (name: string, over: Partial<Scenario> = {}): Scenario => ({
    name,
    description: name,
    setup: async () => {},
    act: async (ctx) => {
      ctx.state.root = await ctx.post('requests', `hello ${name}`)
    },
    checks: [{ name: 'always', run: () => ({ pass: true, reason: 'ok' }) }],
    ...over,
  })

  it('selects scenarios, repeats them, keeps suite order and reports each run', async () => {
    const seen: string[] = []
    const runs = await runEvals({
      scenarios: [tiny('a'), tiny('b'), tiny('c')],
      only: ['c', 'a'],
      repeat: 2,
      concurrency: 3,
      model: scripted(() => reply('hi')),
      onResult: (r) => seen.push(`${r.scenario}#${r.iteration}`),
    })
    expect(runs.map((r) => `${r.scenario}#${r.iteration}`)).toEqual(['a#1', 'a#2', 'c#1', 'c#2'])
    expect(seen.sort()).toEqual(['a#1', 'a#2', 'c#1', 'c#2'])
    expect(runs.every((r) => r.pass)).toBe(true)
    expect(() => selectScenarios(SCENARIOS, ['nope'])).toThrow(/unknown scenario\(s\): nope/)
    expect(SCENARIOS.map((s) => s.name)).toEqual([
      'answer-in-thread',
      'follow-up',
      'brevity',
      'injection',
      'uses-procedure',
      'checklist',
      'say-dont-know',
    ])
  })

  it('turns timeouts, setup errors and throwing checks into failures instead of crashing', async () => {
    const slow = await runScenario(tiny('slow'), 1, {
      model: scripted(async () => {
        await sleep(600)
        return reply('late')
      }),
      timeoutMs: 100,
    })
    expect(slow.pass).toBe(false)
    expect(slow.failure).toMatch(/^timed out: runs did not settle/)
    expect(slow.checks).toHaveLength(1)

    const broken = await runScenario(
      tiny('broken', {
        setup: async () => {
          throw new Error('seed failed')
        },
      }),
      1,
      { model: scripted(() => reply('x')) },
    )
    expect(broken).toMatchObject({ pass: false, failure: 'seed failed', checks: [] })

    const throwing = await runScenario(
      tiny('throwing', {
        checks: [
          {
            name: 'boom',
            run: () => {
              throw new Error('bad check')
            },
          },
        ],
      }),
      1,
      { model: scripted(() => reply('x')) },
    )
    expect(throwing.failure).toBe('boom: check threw: bad check')
  })

  it('a model that errors fails the scenario with the reason', async () => {
    const r = await runScenario(answerInThread, 1, { model: scripted(() => new Error('provider exploded')), timeoutMs: 20_000 })
    expect(r.pass).toBe(false)
    expect(r.failure).toMatch(/^answered-in-thread: /)
  })
})

describe('the report', () => {
  const run = (scenario: string, pass: boolean, tokens: number, durationMs: number, failure?: string): ScenarioRun => ({
    scenario,
    iteration: 1,
    pass,
    checks: [{ name: 'c', pass, reason: pass ? 'ok' : 'nope' }],
    tokens,
    costUsd: 0.001,
    modelCalls: 2,
    durationMs,
    ...(failure ? { failure } : {}),
  })

  it('summarizes pass rates and averages, formats a table and writes JSON', () => {
    const runs = [run('a', true, 100, 1000), run('a', false, 300, 3000, 'c: nope'), run('b', true, 50, 500)]
    const summary = summarize(runs)
    expect(summary).toEqual([
      {
        scenario: 'a',
        runs: 2,
        passed: 1,
        passRate: 0.5,
        avgTokens: 200,
        avgCostUsd: 0.001,
        avgModelCalls: 2,
        avgDurationMs: 2000,
        failureSample: 'c: nope',
        failedChecks: { c: 1 },
      },
      {
        scenario: 'b',
        runs: 1,
        passed: 1,
        passRate: 1,
        avgTokens: 50,
        avgCostUsd: 0.001,
        avgModelCalls: 2,
        avgDurationMs: 500,
        failedChecks: {},
      },
    ])
    const table = formatTable(summary)
    expect(table.split('\n')).toEqual([
      '| scenario | pass       | avg tokens | avg time | failure sample |',
      '|----------|------------|------------|----------|----------------|',
      '| a        | 50% (1/2)  | 200        | 2.0 s    | c: nope        |',
      '| b        | 100% (1/1) | 50         | 0.5 s    |                |',
    ])
    const report = buildReport(runs, {
      startedAt: '2026-09-29T10:00:00.000Z',
      finishedAt: '2026-09-29T10:01:00.000Z',
      model: 'scripted',
      repeat: 1,
    })
    expect(report.totals).toEqual({ runs: 3, passed: 2, passRate: 2 / 3, tokens: 450, costUsd: 0.003 })
    const dir = tmp()
    const path = writeResults(join(dir, 'results'), report)
    expect(path).toBe(join(dir, 'results', '2026-09-29T10-00-00-000Z.json'))
    expect(JSON.parse(readFileSync(path, 'utf8')).summary).toHaveLength(2)
    expect(readdirSync(join(dir, 'results'))).toHaveLength(1)
  })
})

describe('model configuration', () => {
  it('reads only the three model variables from .env, lets the environment win, and never touches it', () => {
    const dir = tmp()
    const file = join(dir, '.env')
    writeFileSync(
      file,
      'OPENAI_BASE_URL=https://api.example.com/v1\nOPENAI_API_KEY="sk-test"\nMODEL=m1\nDATABASE_URL=postgres://x\n',
    )
    const env: Record<string, string | undefined> = { MODEL: 'm2' }
    const m = loadModelEnv({ path: file, env })
    expect(m).toEqual({ OPENAI_BASE_URL: 'https://api.example.com/v1', OPENAI_API_KEY: 'sk-test', MODEL: 'm2' })
    expect(env).toEqual({ MODEL: 'm2' })
    expect(describeModelEnv(m!)).toBe('m2 at api.example.com')
    expect(describeModelEnv(m!)).not.toContain('sk-test')
    expect(loadModelEnv({ path: null, env: {} })).toBeNull()
    expect(loadModelEnv({ path: join(dir, 'missing.env'), env: { OPENAI_BASE_URL: 'https://x.example.com' } })).toBeNull()
    // Found by walking up from a subfolder.
    expect(loadModelEnv({ env: {}, cwd: join(dir) })?.MODEL).toBe('m1')
  })
})
