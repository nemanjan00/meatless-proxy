import type { UsageRow, UsageSeries } from '@mp/api'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from 'recharts'
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart.tsx'
import { formatTokens } from '@/lib/format.ts'

/**
 * Categorical order for series: the stylebook's chart tokens, reordered so
 * that neighbours stay distinguishable (validated: indigo and blue are never
 * adjacent). More than five series fold into "Other".
 */
export const SERIES_COLORS = ['var(--chart-1)', 'var(--chart-3)', 'var(--chart-2)', 'var(--chart-5)', 'var(--chart-4)']
export const MAX_SERIES = SERIES_COLORS.length

/** Keeps the top `MAX_SERIES - 1` series by total and folds the rest into `other`. */
export function foldSeries(series: UsageSeries): UsageSeries {
  if (series.keys.length <= MAX_SERIES) return series
  const totals = series.keys.map((k) => ({ ...k, total: series.points.reduce((n, p) => n + Number(p[k.key] ?? 0), 0) }))
  totals.sort((a, b) => b.total - a.total)
  const keep = totals.slice(0, MAX_SERIES - 1)
  const rest = totals.slice(MAX_SERIES - 1)
  return {
    ...series,
    keys: [...keep.map(({ key, label }) => ({ key, label })), { key: 'other', label: 'Other' }],
    points: series.points.map((p) => {
      const out: UsageSeries['points'][number] = { t: p.t }
      for (const k of keep) out[k.key] = p[k.key] ?? 0
      out.other = rest.reduce((n, k) => n + Number(p[k.key] ?? 0), 0)
      return out
    }),
  }
}

const tick = { fill: 'var(--fg-quaternary)', fontSize: 11 }

function shortDate(t: string, interval: 'hour' | 'day') {
  const d = new Date(interval === 'day' ? `${t}T00:00:00Z` : `${t.replace(':00', '')}:00:00Z`)
  if (Number.isNaN(d.getTime())) return t
  return interval === 'day'
    ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : `${String(d.getUTCHours()).padStart(2, '0')}:00`
}

/** Token use over time, stacked by series; crosshair tooltip, legend below. */
export function UsageArea({ series, height = 240 }: { series: UsageSeries; height?: number }) {
  const s = foldSeries(series)
  const config: ChartConfig = Object.fromEntries(s.keys.map((k, i) => [k.key, { label: k.label, color: SERIES_COLORS[i]! }]))
  return (
    <ChartContainer config={config} className="w-full" style={{ height }}>
      <AreaChart data={s.points} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="t"
          tickLine={false}
          axisLine={false}
          tick={tick}
          minTickGap={32}
          tickFormatter={(t: string) => shortDate(t, s.interval)}
        />
        <YAxis tickLine={false} axisLine={false} tick={tick} width={44} tickFormatter={(v: number) => formatTokens(v)} />
        <ChartTooltip
          cursor={{ stroke: 'var(--fg-quaternary)' }}
          content={<ChartTooltipContent labelFormatter={(t) => shortDate(String(t), s.interval)} />}
        />
        {s.keys.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        {s.keys.map((k) => (
          <Area
            key={k.key}
            dataKey={k.key}
            type="monotone"
            stackId="a"
            stroke={`var(--color-${k.key})`}
            strokeWidth={2}
            fill={`var(--color-${k.key})`}
            fillOpacity={0.18}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  )
}

/** One bar per row (e.g. per day), single series. */
export function UsageBars({ rows, height = 180 }: { rows: UsageRow[]; height?: number }) {
  const config: ChartConfig = { total: { label: 'Tokens', color: 'var(--chart-1)' } }
  return (
    <ChartContainer config={config} className="w-full" style={{ height }}>
      <BarChart data={rows} margin={{ left: 4, right: 8, top: 8 }} barCategoryGap={2}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="key"
          tickLine={false}
          axisLine={false}
          tick={tick}
          minTickGap={24}
          tickFormatter={(t: string) => shortDate(t, 'day')}
        />
        <YAxis tickLine={false} axisLine={false} tick={tick} width={44} tickFormatter={(v: number) => formatTokens(v)} />
        <ChartTooltip
          cursor={{ fill: 'var(--accent)' }}
          content={<ChartTooltipContent labelFormatter={(t) => shortDate(String(t), 'day')} />}
        />
        <Bar dataKey="total" fill="var(--color-total)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  )
}

/** Horizontal bars for a breakdown (by employee, model, …), largest first. */
export function BreakdownBars({ rows, height }: { rows: UsageRow[]; height?: number }) {
  const top = rows.slice(0, 8)
  const config: ChartConfig = { total: { label: 'Tokens', color: 'var(--chart-1)' } }
  return (
    <ChartContainer config={config} className="w-full" style={{ height: height ?? Math.max(120, top.length * 30 + 20) }}>
      <BarChart data={top} layout="vertical" margin={{ left: 4, right: 48 }} barCategoryGap={4}>
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tick={{ ...tick, fill: 'var(--fg-secondary)' }}
          width={150}
        />
        <ChartTooltip cursor={{ fill: 'var(--accent)' }} content={<ChartTooltipContent />} />
        <Bar dataKey="total" fill="var(--color-total)" radius={[0, 4, 4, 0]} isAnimationActive={false}>
          <LabelList
            dataKey="total"
            position="right"
            formatter={(v: unknown) => formatTokens(Number(v))}
            fill="var(--fg-tertiary)"
            fontSize={11}
          />
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}
