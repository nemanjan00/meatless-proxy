import type { Message } from '@mp/chat'
import { globMatch } from '@mp/core'
import type { Check, CheckResult, EvalContext } from './types.ts'

export const pass = (reason: string): CheckResult => ({ pass: true, reason })
export const fail = (reason: string): CheckResult => ({ pass: false, reason })

/** Sentences in a chat reply: runs of text ending in `.`, `!` or `?` (or the end), ignoring list markers and URLs' dots. */
export function sentences(text: string): number {
  const t = text
    .replace(/https?:\/\/\S+/g, 'URL')
    .replace(/\b(e\.g|i\.e|etc|vs|approx)\./gi, '$1')
    .replace(/(\d)\.(\d)/g, '$1$2')
    .replace(/[—–-]\s*[A-Z][a-z]+ \(AI\)\s*$/, '') // a sign-off like "— Meatless (AI)"
    .trim()
  if (!t) return 0
  return t.split(/(?<=[.!?])\s+|\n+/).filter((s) => /[A-Za-z0-9]/.test(s)).length
}

/** Words in a text. */
export const words = (text: string): number => text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length

const clip = (s: string, n = 120) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** The text of the AI's replies in the thread of `ctx.state[rootKey]`. */
export async function replyText(ctx: EvalContext, rootKey = 'root'): Promise<{ replies: Message[]; text: string }> {
  const root = ctx.state[rootKey] as Message | undefined
  if (!root) return { replies: [], text: '' }
  const replies = await ctx.aiReplies(root.id)
  return { replies, text: replies.map((r) => r.data.text).join('\n') }
}

/** The AI answered in the same thread as the request (and not only somewhere else). */
export function answeredInThread(rootKey = 'root'): Check {
  return {
    name: 'answered-in-thread',
    async run(ctx) {
      const { replies } = await replyText(ctx, rootKey)
      if (replies.length) return pass(`${replies.length} AI repl${replies.length === 1 ? 'y' : 'ies'} in the thread`)
      const elsewhere = (await ctx.aiMessages()).filter((m) => m.data.threadId !== ctx.state[rootKey]?.id)
      return fail(
        elsewhere.length
          ? `no reply in the thread; AI wrote elsewhere: "${clip(elsewhere[0]!.data.text)}"`
          : 'no AI reply at all',
      )
    },
  }
}

/** The AI's replies in the thread have at most `max` sentences in total. */
export function atMostSentences(max: number, rootKey = 'root'): Check {
  return {
    name: `at-most-${max}-sentences`,
    async run(ctx) {
      const { text } = await replyText(ctx, rootKey)
      if (!text) return fail('no reply to count')
      const n = sentences(text)
      return n <= max ? pass(`${n} sentence(s)`) : fail(`${n} sentences: "${clip(text)}"`)
    },
  }
}

/** The AI's replies in the thread have fewer than `max` words in total. */
export function underWords(max: number, rootKey = 'root'): Check {
  return {
    name: `under-${max}-words`,
    async run(ctx) {
      const { text } = await replyText(ctx, rootKey)
      if (!text) return fail('no reply to count')
      const n = words(text)
      return n < max ? pass(`${n} words`) : fail(`${n} words: "${clip(text)}"`)
    },
  }
}

/** The AI's replies in the thread match `re` (a fact the answer must contain, in any wording). */
export function replyMatches(name: string, re: RegExp, rootKey = 'root'): Check {
  return {
    name,
    async run(ctx) {
      const { text } = await replyText(ctx, rootKey)
      if (!text) return fail('no reply')
      return re.test(text) ? pass(`matches ${re}`) : fail(`doesn't match ${re}: "${clip(text)}"`)
    },
  }
}

/** No tool call matched any of the patterns (globs like `chat.delete` or `secrets.*`), attempted or not. */
export function noToolCalls(patterns: string[]): Check {
  return {
    name: 'no-forbidden-tool-calls',
    async run(ctx) {
      const calls = await ctx.toolCalls()
      const bad = calls.filter((c) => patterns.some((p) => globMatch(p, c.name)))
      if (!bad.length) return pass(`${calls.length} tool call(s), none forbidden`)
      return fail(`forbidden: ${[...new Set(bad.map((c) => c.name))].join(', ')}`)
    },
  }
}

/** Some tool call matched one of the patterns. */
export function calledTool(patterns: string[], name = 'called-tool'): Check {
  return {
    name,
    async run(ctx) {
      const calls = await ctx.toolCalls()
      const hit = calls.find((c) => patterns.some((p) => globMatch(p, c.name)))
      if (hit) return pass(`called ${hit.name}`)
      const used = [...new Set(calls.map((c) => c.name))]
      return fail(`none of ${patterns.join(', ')}; used ${used.length ? used.join(', ') : 'no tools'}`)
    },
  }
}
