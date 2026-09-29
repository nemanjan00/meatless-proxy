import type { UsageFilter, UsageGroupBy, UsageRow } from '@mp/api'
import { ChartBar } from 'lucide-react'
import { useMemo } from 'react'
import { NavLink, useNavigate, useSearchParams } from 'react-router'
import { type DataColumn, DataTable } from '@/components/data-table.tsx'
import { ErrorState, LoadingRows } from '@/components/empty.tsx'
import { Page, SectionTitle } from '@/components/page.tsx'
import { BreakdownBars, UsageArea } from '@/components/usage-charts.tsx'
import { useLiveReload, useLoad } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'
import { useEmployees } from '@/lib/employees.tsx'
import { formatCostOf, formatNumber, formatTokens, NO_PRICING, unpriced } from '@/lib/format.ts'
import { fillSeries } from '@/lib/usage-series.ts'
import { cn } from '@/lib/utils.ts'

const RANGES = [
  { key: '24h', label: '24 hours', hours: 24, interval: 'hour' as const },
  { key: '7d', label: '7 days', hours: 24 * 7, interval: 'day' as const },
  { key: '14d', label: '14 days', hours: 24 * 14, interval: 'day' as const },
]
const SPLITS: UsageGroupBy[] = ['employee', 'model', 'project']
const GROUPS: UsageGroupBy[] = ['session', 'tree', 'employee', 'model', 'project', 'contact', 'template', 'tool']

function Pill({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-6 rounded-md border border-transparent px-2 text-fg-tertiary capitalize hover:text-foreground',
        active && 'border-border bg-secondary text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/** Token usage and cost: over time, by employee, model, session and more, with a breakdown table. */
export function UsagePage() {
  const [params, setParams] = useSearchParams()
  const range = RANGES.find((r) => r.key === params.get('range')) ?? RANGES[1]!
  const split = (params.get('split') as UsageGroupBy) ?? 'employee'
  const group = (params.get('group') as UsageGroupBy) ?? 'session'
  const { currentId } = useEmployees()
  const navigate = useNavigate()
  const admin = useAuth().can('admin')
  // Round to the minute so the filter (and the load) is stable across renders.
  const since = useMemo(
    () => new Date(Math.floor(Date.now() / 60_000) * 60_000 - range.hours * 3_600_000).toISOString(),
    [range.hours],
  )
  const filter: UsageFilter = { since, ...(currentId ? { employeeId: currentId } : {}) }
  const data = useLoad(
    (api) =>
      Promise.all([
        api.usageTotals(filter),
        api.usageSeries(range.interval, { ...filter, splitBy: split }),
        api.usageBreakdown('employee', filter),
        api.usageBreakdown('model', filter),
        api.usageBreakdown(group, filter),
      ]),
    [since, split, group, currentId, range.interval],
  )
  useLiveReload(['now'], data.reload, ['usage.recorded'], 3000)
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params)
    n.set(k, v)
    setParams(n, { replace: true })
  }
  const columns = useMemo<DataColumn<UsageRow>[]>(
    () => [
      {
        id: 'label',
        header: group.charAt(0).toUpperCase() + group.slice(1),
        value: (r) => r.label,
        cell: (r) => (
          <span className={cn('truncate', ['model', 'tool'].includes(group) && 'font-mono text-micro')}>{r.label}</span>
        ),
      },
      {
        id: 'calls',
        header: 'Calls',
        value: (r) => r.calls,
        cell: (r) => formatNumber(r.calls),
        align: 'right',
        className: 'w-20',
      },
      {
        id: 'input',
        header: 'Input',
        value: (r) => r.input,
        cell: (r) => formatTokens(r.input),
        align: 'right',
        className: 'w-24',
      },
      {
        id: 'cached',
        header: 'Cached',
        value: (r) => r.cached / Math.max(1, r.input),
        cell: (r) => `${Math.round((r.cached / Math.max(1, r.input)) * 100)}%`,
        align: 'right',
        className: 'w-20',
      },
      {
        id: 'output',
        header: 'Output',
        value: (r) => r.output,
        cell: (r) => formatTokens(r.output),
        align: 'right',
        className: 'w-24',
      },
      {
        id: 'total',
        header: 'Total',
        value: (r) => r.total,
        cell: (r) => <span className="text-foreground">{formatTokens(r.total)}</span>,
        align: 'right',
        className: 'w-24',
      },
      {
        id: 'cost',
        header: 'Cost',
        value: (r) => r.cost,
        cell: (r) => <span title={unpriced(r) ? NO_PRICING : undefined}>{formatCostOf(r)}</span>,
        align: 'right',
        className: 'w-20',
      },
    ],
    [group],
  )
  const [totals, rawSeries, byEmployee, byModel, breakdown] = data.data ?? []
  // Every bucket of the range, empty ones as 0 (the API only returns buckets with usage).
  const series = useMemo(() => (rawSeries ? fillSeries(rawSeries, Date.parse(since), Date.now()) : undefined), [rawSeries, since])
  return (
    <Page
      title="Usage"
      icon={<ChartBar />}
      filters={
        <>
          {RANGES.map((r) => (
            <Pill key={r.key} active={r.key === range.key} onClick={() => set('range', r.key)}>
              {r.label}
            </Pill>
          ))}
          <span className="mx-2 h-4 w-px bg-border" />
          <span className="text-micro text-fg-tertiary">Split by</span>
          {SPLITS.map((s) => (
            <Pill key={s} active={s === split} onClick={() => set('split', s)}>
              {s}
            </Pill>
          ))}
        </>
      }
    >
      {data.error && !data.data ? (
        <ErrorState error={data.error} retry={data.reload} />
      ) : !totals || !series || !byEmployee || !byModel || !breakdown ? (
        <LoadingRows />
      ) : (
        <div className="flex flex-col gap-8 px-6 py-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="usage-totals">
            {[
              ['Tokens', formatTokens(totals.total), `${formatTokens(totals.input)} in · ${formatTokens(totals.output)} out`],
              unpriced(totals)
                ? [
                    'Cost',
                    '—',
                    <>
                      {NO_PRICING}
                      {admin && (
                        <>
                          {' · '}
                          <NavLink to="/settings/pricing" className="text-[#828fff] hover:underline">
                            set prices
                          </NavLink>
                        </>
                      )}
                    </>,
                  ]
                : ['Cost', formatCostOf(totals), `${range.label}`],
              [
                'Model calls',
                formatNumber(totals.calls),
                `${formatTokens(totals.total / Math.max(1, totals.calls))} tokens per call`,
              ],
              [
                'Cache hits',
                `${Math.round((totals.cached / Math.max(1, totals.input)) * 100)}%`,
                `${formatTokens(totals.cached)} cached input`,
              ],
            ].map(([k, v, sub]) => (
              <div key={String(k)} className="rounded-xl border bg-card px-4 py-3">
                <div className="text-micro text-fg-tertiary">{k}</div>
                <div className="mt-0.5 text-title2 font-semibold tabular-nums">{v}</div>
                <div className="text-micro text-fg-quaternary">{sub}</div>
              </div>
            ))}
          </div>
          <section>
            <SectionTitle className="mb-2">Tokens over time, by {split}</SectionTitle>
            <div className="rounded-xl border bg-card p-3">
              <UsageArea series={series} height={260} />
            </div>
          </section>
          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <SectionTitle className="mb-2">By employee</SectionTitle>
              <div className="rounded-xl border bg-card p-3">
                <BreakdownBars rows={byEmployee.rows} />
              </div>
            </section>
            <section>
              <SectionTitle className="mb-2">By model</SectionTitle>
              <div className="rounded-xl border bg-card p-3">
                <BreakdownBars rows={byModel.rows} />
              </div>
            </section>
          </div>
          <section>
            <SectionTitle
              className="mb-2"
              actions={GROUPS.map((g) => (
                <Pill key={g} active={g === group} onClick={() => set('group', g)}>
                  {g}
                </Pill>
              ))}
            >
              What's expensive
            </SectionTitle>
            <div className="rounded-xl border bg-card px-2">
              <DataTable
                rows={breakdown.rows}
                columns={columns}
                rowKey={(r) => r.key}
                initialSort={[{ id: 'total', desc: true }]}
                onRowClick={['session', 'tree'].includes(group) ? (r) => navigate(`/sessions/${r.key}`) : undefined}
              />
            </div>
          </section>
        </div>
      )}
    </Page>
  )
}
