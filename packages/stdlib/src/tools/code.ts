import { errorMessage } from '@mp/core'
import { LANGUAGES, type Language, type Sandbox } from '@mp/sandbox'
import type { SessionData } from '@mp/sessions'
import { fail, ok, type Kit } from '../kit.ts'

const ENDED: readonly SessionData['status'][] = ['done', 'abandoned']

export function registerCodeTools(kit: Kit, sandbox: Sandbox): void {
  kit.tool(
    {
      name: 'code.run',
      description:
        "Run Python or Node in your sandbox, like a notebook: variables, imports and functions stay for your next code.run in this session (one kernel per language), and the last expression's value comes back as result. Use it for math, data and charts instead of working things out in your head. The working directory is /work/files: your own files (the same ones as fs.*), so read inputs there and save outputs there to keep them (e.g. plt.savefig('chart.png')), then attach them to a chat message or fs.share them. /work/files in code.run is your filesystem root: /work/files/a.txt is /a.txt for fs.* and attachments; files_changed lists both (path and sandboxPath). Files shared with you are under /work/shared/<owner>/… (read-only unless shared for writing). Python has numpy, pandas, sympy and matplotlib. No network unless the deployment allows some hosts. A timeout (default 30 s, at most 300 s) restarts the kernel and loses its state; fresh: true runs in a throwaway kernel.",
      effect: 'non_idempotent',
      params: {
        properties: {
          language: { type: 'string', enum: [...LANGUAGES] },
          code: { type: 'string' },
          timeoutMs: { type: 'number', description: 'Default 30000, at most 300000.' },
          fresh: { type: 'boolean', description: 'Run in a new, throwaway kernel instead of this session’s.' },
        },
        required: ['language', 'code'],
      },
    },
    async (a, ctx) => {
      await kit.ownSession(undefined, ctx)
      const r = await sandbox.run({
        employeeId: ctx.employeeId,
        sessionId: ctx.sessionId,
        language: a.language as Language,
        code: a.code,
        ...(typeof a.timeoutMs === 'number' ? { timeoutMs: a.timeoutMs } : {}),
        ...(a.fresh === true ? { fresh: true } : {}),
        signal: ctx.signal,
        actor: kit.actor(ctx),
      })
      return { output: r as unknown as Record<string, never>, ...(r.error ? { isError: true } : {}) }
    },
  )

  kit.tool(
    {
      name: 'code.reset',
      description:
        "Restart this session's code.run kernel for a language (or both), dropping its variables and imports. Your files stay.",
      effect: 'idempotent',
      params: { properties: { language: { type: 'string', enum: [...LANGUAGES] } } },
    },
    async (a, ctx) => {
      await kit.ownSession(undefined, ctx)
      if (a.language !== undefined && !LANGUAGES.includes(a.language))
        return fail(`language must be one of ${LANGUAGES.join(', ')}`)
      const reset = await sandbox.reset(ctx.sessionId, a.language)
      return ok({ reset, ...(reset.length ? {} : { note: 'there was no running kernel' }) })
    },
  )

  // A finished session's kernels go.
  kit.deps.bus?.subscribe<{ kind: string; id: string }>('record.changed', async (m) => {
    if (m.payload.kind !== 'session' || !sandbox.hasSession(m.payload.id)) return
    const s = await kit.deps.sessions.get(m.payload.id)
    if (!s || ENDED.includes(s.data.status))
      await sandbox
        .endSession(m.payload.id)
        .catch((e) => kit.deps.logger.warn('could not stop kernels', { err: errorMessage(e) }))
  })
}
