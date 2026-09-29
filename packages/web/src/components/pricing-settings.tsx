import type { ModelPriceView, PricingInfo } from '@mp/api'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ErrorState, LoadingRows } from '@/components/empty.tsx'
import { SectionTitle } from '@/components/page.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { useApi, useLoad } from '@/lib/api.tsx'
import { NO_PRICING } from '@/lib/format.ts'

/** One editable row: text as typed, so a half-typed number isn't lost. */
interface Row {
  model: string
  input: string
  cached: string
  output: string
}

const rowOf = (model: string, p: ModelPriceView): Row => ({
  model,
  input: String(p.inputPerM),
  cached: p.cachedInputPerM === undefined ? '' : String(p.cachedInputPerM),
  output: String(p.outputPerM),
})

/** Checks the rows and builds the table, or returns the problem. */
export function buildPricing(rows: Row[]): { pricing: Record<string, ModelPriceView> } | { error: string } {
  const pricing: Record<string, ModelPriceView> = {}
  for (const r of rows) {
    const model = r.model.trim()
    if (!model && !r.input.trim() && !r.output.trim() && !r.cached.trim()) continue
    if (!model) return { error: 'Every price needs a model name.' }
    if (pricing[model]) return { error: `${model} is listed twice.` }
    const num = (s: string, what: string, required: boolean): number | undefined | string => {
      const t = s.trim()
      if (!t) return required ? `${model}: enter the ${what} price.` : undefined
      const n = Number(t)
      return Number.isFinite(n) && n >= 0 ? n : `${model}: the ${what} price must be a number of 0 or more.`
    }
    const input = num(r.input, 'input', true)
    const output = num(r.output, 'output', true)
    const cached = num(r.cached, 'cached input', false)
    for (const v of [input, output, cached]) if (typeof v === 'string') return { error: v }
    pricing[model] = {
      inputPerM: input as number,
      outputPerM: output as number,
      ...(cached !== undefined ? { cachedInputPerM: cached as number } : {}),
    }
  }
  return { pricing }
}

const SOURCE_LABEL = { custom: 'set here', env: 'PRICING', builtin: 'built-in' } as const

const usd = (n: number | undefined) => (n === undefined ? '—' : `$${n}`)

/** Settings → Pricing: USD per million tokens per model, over the built-in table and `PRICING`. Admins only. */
export function PricingSettings() {
  const api = useApi()
  const data = useLoad((a) => a.pricing(), [])
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (data.data) setRows(Object.entries(data.data.custom).map(([m, p]) => rowOf(m, p)))
  }, [data.data])
  if (data.error && !data.data) return <ErrorState error={data.error} retry={data.reload} />
  if (!data.data) return <LoadingRows />
  const info: PricingInfo = data.data
  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const addRow = (r: Row = { model: '', input: '', cached: '', output: '' }) => {
    if (r.model && rows.some((x) => x.model === r.model)) return
    setRows((rs) => [...rs, r])
  }
  const save = async () => {
    const built = buildPricing(rows)
    if ('error' in built) {
      setError(built.error)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.setPricing(built.pricing)
      toast('Prices saved', { description: 'New model calls are priced with them; earlier calls keep their cost.' })
      data.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const reference = { ...info.builtin, ...info.env }
  return (
    <div className="flex max-w-[860px] flex-col gap-6" data-testid="pricing-settings">
      <p className="text-fg-tertiary">
        What a model call costs, in USD per million tokens. Prices set here win over the{' '}
        <code className="font-mono">PRICING</code> variable, which wins over the built-in table (checked on the providers&apos;
        pricing pages). A model without a price shows &ldquo;{NO_PRICING}&rdquo; and counts as $0.
      </p>

      <section className="flex flex-col gap-2">
        <SectionTitle>Models in use</SectionTitle>
        <div className="rounded-xl border" data-testid="pricing-models">
          {info.models.length === 0 && <div className="px-3 py-2 text-fg-tertiary">No model calls in the last 30 days.</div>}
          {info.models.map((m) => (
            <div key={m.model} className="flex min-h-9 flex-wrap items-center gap-3 border-b px-3 py-1.5 last:border-0">
              <span className="min-w-0 flex-1 truncate font-mono text-micro text-fg-secondary">{m.model}</span>
              {m.price ? (
                <span className="text-micro text-fg-tertiary tabular-nums">
                  {usd(m.price.inputPerM)} in · {usd(m.price.cachedInputPerM ?? m.price.inputPerM)} cached ·{' '}
                  {usd(m.price.outputPerM)} out
                </span>
              ) : (
                <span className="text-micro text-[var(--orange)]">{NO_PRICING}</span>
              )}
              {m.source ? (
                <Badge variant="outline" className="text-fg-tertiary">
                  {SOURCE_LABEL[m.source]}
                </Badge>
              ) : (
                <Button size="xs" variant="outline" onClick={() => addRow({ model: m.model, input: '', cached: '', output: '' })}>
                  Set a price
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle
          actions={
            <Button size="xs" variant="ghost" onClick={() => addRow()}>
              <Plus /> Add model
            </Button>
          }
        >
          Prices set here
        </SectionTitle>
        <div className="rounded-xl border" data-testid="pricing-editor">
          <div className="hidden grid-cols-[1fr_110px_110px_110px_28px] gap-2 border-b px-3 py-1.5 text-micro text-fg-tertiary sm:grid">
            <span>Model</span>
            <span>Input</span>
            <span>Cached input</span>
            <span>Output</span>
            <span />
          </div>
          {rows.length === 0 && <div className="px-3 py-2 text-fg-tertiary">None: the built-in table and PRICING apply.</div>}
          {rows.map((r, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place, the model name can change
              key={i}
              className="grid grid-cols-2 gap-2 border-b px-3 py-1.5 last:border-0 sm:grid-cols-[1fr_110px_110px_110px_28px]"
            >
              <Input
                aria-label={`Model ${i + 1}`}
                className="col-span-2 h-7 font-mono text-micro sm:col-span-1"
                placeholder="model name"
                value={r.model}
                onChange={(e) => setRow(i, { model: e.target.value })}
              />
              {(
                [
                  ['input', 'Input'],
                  ['cached', 'Cached input'],
                  ['output', 'Output'],
                ] as const
              ).map(([k, label]) => (
                <Input
                  key={k}
                  aria-label={`${label} price of ${r.model || `model ${i + 1}`}`}
                  inputMode="decimal"
                  className="h-7 text-mini tabular-nums"
                  placeholder={k === 'cached' ? 'as input' : '$ / 1M'}
                  value={r[k]}
                  onChange={(e) => setRow(i, { [k]: e.target.value })}
                />
              ))}
              <Button
                size="icon-xs"
                variant="ghost"
                className="self-center"
                aria-label={`Remove ${r.model || `model ${i + 1}`}`}
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-micro text-[var(--red)]">
            {error}
          </p>
        )}
        <div>
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save prices'}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle>Built-in and PRICING</SectionTitle>
        <div className="rounded-xl border" data-testid="pricing-reference">
          {Object.entries(reference)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([model, p]) => (
              <div key={model} className="flex min-h-9 flex-wrap items-center gap-3 border-b px-3 py-1.5 last:border-0">
                <span className="min-w-0 flex-1 truncate font-mono text-micro text-fg-secondary">{model}</span>
                <span className="text-micro text-fg-tertiary tabular-nums">
                  {usd(p.inputPerM)} in · {usd(p.cachedInputPerM ?? p.inputPerM)} cached · {usd(p.outputPerM)} out
                </span>
                <Badge variant="outline" className="text-fg-quaternary">
                  {info.env[model] ? 'PRICING' : 'built-in'}
                </Badge>
                <Button size="xs" variant="ghost" onClick={() => addRow(rowOf(model, p))}>
                  Override
                </Button>
              </div>
            ))}
        </div>
      </section>
    </div>
  )
}
