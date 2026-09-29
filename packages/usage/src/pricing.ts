/** USD per million tokens of one model. */
export interface ModelPrice {
  /** USD per million uncached input tokens. */
  inputPerM: number
  /** USD per million output tokens. */
  outputPerM: number
  /** USD per million cached input tokens. Defaults to `inputPerM`. */
  cachedInputPerM?: number
}

/** Prices by model name. */
export type Pricing = Record<string, ModelPrice>

/**
 * Prices checked on the providers' official pricing pages, standard (not batch
 * or priority) rates. Only models whose price could be verified are here; any
 * other model costs 0 until it gets a price (the `PRICING` variable or
 * Settings → Pricing, which both win over this table). Cache writes, where a
 * provider charges them, aren't modelled: cached input is what's billed per hit.
 */
export const BUILTIN_PRICING: Pricing = {
  // Source: https://platform.kimi.ai/docs/pricing/chat (checked 2026-09-29).
  'kimi-k3': { inputPerM: 3, cachedInputPerM: 0.3, outputPerM: 15 },
  // Source: https://platform.kimi.ai/docs/pricing/chat (checked 2026-09-29).
  'kimi-k2.7-code': { inputPerM: 0.95, cachedInputPerM: 0.19, outputPerM: 4 },
  // Source: https://platform.kimi.ai/docs/pricing/chat (checked 2026-09-29).
  'kimi-k2.7-code-highspeed': { inputPerM: 1.9, cachedInputPerM: 0.38, outputPerM: 8 },
  // Source: https://platform.kimi.ai/docs/pricing/chat (checked 2026-09-29).
  'kimi-k2.6': { inputPerM: 0.95, cachedInputPerM: 0.16, outputPerM: 4 },
  // Source: https://platform.openai.com/docs/pricing (checked 2026-09-29).
  'gpt-5.4-mini': { inputPerM: 0.75, cachedInputPerM: 0.075, outputPerM: 4.5 },
  // Source: https://platform.openai.com/docs/pricing (checked 2026-09-29).
  'gpt-5.4-nano': { inputPerM: 0.2, cachedInputPerM: 0.02, outputPerM: 1.25 },
  // Source: https://platform.openai.com/docs/pricing (checked 2026-09-29).
  'gpt-5': { inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10 },
  // Source: https://platform.openai.com/docs/pricing (checked 2026-09-29).
  'gpt-5-mini': { inputPerM: 0.25, cachedInputPerM: 0.025, outputPerM: 2 },
  // Source: https://platform.openai.com/docs/pricing (checked 2026-09-29).
  'gpt-5-nano': { inputPerM: 0.05, cachedInputPerM: 0.005, outputPerM: 0.4 },
  // Source: https://platform.openai.com/docs/pricing (checked 2026-09-29).
  'gpt-4.1': { inputPerM: 2, cachedInputPerM: 0.5, outputPerM: 8 },
  // Source: https://platform.openai.com/docs/pricing (checked 2026-09-29).
  'gpt-4.1-mini': { inputPerM: 0.4, cachedInputPerM: 0.1, outputPerM: 1.6 },
  // Source: https://platform.openai.com/docs/pricing (checked 2026-09-29).
  'gpt-4o': { inputPerM: 2.5, cachedInputPerM: 1.25, outputPerM: 10 },
  // Source: https://platform.openai.com/docs/pricing (checked 2026-09-29).
  'gpt-4o-mini': { inputPerM: 0.15, cachedInputPerM: 0.075, outputPerM: 0.6 },
}

/** A model name compared loosely: lower case, no `vendor/` prefix, `.` as `-` (`kimi-k2-7-code` is `kimi-k2.7-code`). */
export function normalizeModel(model: string): string {
  const m = model.trim().toLowerCase()
  return m.slice(m.lastIndexOf('/') + 1).replace(/\./g, '-')
}

/**
 * The price of a model from the first table that has it (earlier tables win),
 * by exact name, then by the loose name (`normalizeModel`). Null when none has it.
 */
export function priceFor(model: string, ...tables: (Pricing | undefined)[]): ModelPrice | null {
  for (const t of tables) if (t && Object.hasOwn(t, model)) return t[model]!
  const want = normalizeModel(model)
  for (const t of tables) {
    if (!t) continue
    for (const [name, price] of Object.entries(t)) if (normalizeModel(name) === want) return price
  }
  return null
}

/** Throws a message naming the problem when `value` isn't a valid pricing table. */
export function checkPricing(value: unknown): Pricing {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('pricing must be an object of model → price')
  const out: Pricing = {}
  for (const [model, p] of Object.entries(value as Record<string, unknown>)) {
    if (!model.trim()) throw new Error('a model name is empty')
    if (!p || typeof p !== 'object' || Array.isArray(p))
      throw new Error(`${model}: must be { inputPerM, outputPerM, cachedInputPerM? }`)
    const price = p as Record<string, unknown>
    const num = (k: string, required: boolean) => {
      const v = price[k]
      if (v === undefined || v === null) {
        if (required) throw new Error(`${model}: ${k} is required`)
        return undefined
      }
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${model}: ${k} must be a non-negative number`)
      return v
    }
    const inputPerM = num('inputPerM', true)!
    const outputPerM = num('outputPerM', true)!
    const cachedInputPerM = num('cachedInputPerM', false)
    out[model.trim()] = { inputPerM, outputPerM, ...(cachedInputPerM !== undefined ? { cachedInputPerM } : {}) }
  }
  return out
}
