import type { ApiEntry, Checklist, LiveEvent, Run, RunState, SessionDetail, SessionOutcome } from '@mp/api'
import { TERMINAL_RUN_STATES } from '@mp/api'
import {
  ChevronRight,
  CirclePause,
  CirclePlay,
  GitFork,
  Link2,
  ListChecks,
  MessagesSquare,
  Send,
  ShieldCheck,
  Workflow,
  X,
} from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { DocumentEditor } from '@/components/doc-editor.tsx'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { EntryTreeView } from '@/components/entry-tree.tsx'
import { ChatLink, SubjectLink } from '@/components/links.tsx'
import { DesktopViewer } from '@/components/desktop-viewer.tsx'
import {
  EnvironmentCard,
  EnvironmentSheet,
  StopEnvironmentDialog,
  useEnvironmentsLive,
  useNow,
} from '@/components/environment.tsx'
import { PreviewPanel } from '@/components/preview-panel.tsx'
import { RecentRuns } from '@/components/recent-runs.tsx'
import { Timeline } from '@/components/history.tsx'
import { Page, SectionTitle } from '@/components/page.tsx'
import { SplitView } from '@/components/split-view.tsx'
import { EmployeeAvatar, PersonAvatar } from '@/components/people.tsx'
import { SessionTreeGraph, TreeOutline, treeStats } from '@/components/session-tree.tsx'
import { StatusIcon, StatusLabel } from '@/components/status-icon.tsx'
import { UsageBars } from '@/components/usage-charts.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.tsx'
import { Progress } from '@/components/ui/progress.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useApi, useLive, useLoad } from '@/lib/api.tsx'
import { Can, ReadOnlyNote } from '@/lib/auth.tsx'
import { hrefFor, linkRole } from '@/lib/doclinks.ts'
import { useEmployees } from '@/lib/employees.tsx'
import { threadSubject } from '@/lib/links.ts'
import {
  duration,
  formatCostOf,
  pluralize,
  formatDateTime,
  formatTokens,
  NO_PRICING,
  shortId,
  timeAgo,
  unpriced,
} from '@/lib/format.ts'
import { fillRows, intervalFor } from '@/lib/usage-series.ts'
import { sessionStatusKey } from '@/lib/status.ts'
import { cn } from '@/lib/utils.ts'

const TABS = ['history', 'preview', 'branches', 'tree', 'runs', 'checklist', 'threads', 'usage'] as const
type Tab = (typeof TABS)[number]

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-7 grid-cols-[96px_1fr] items-center gap-2">
      <span className="text-fg-tertiary">{label}</span>
      <span className="min-w-0 truncate text-fg-secondary">{children}</span>
    </div>
  )
}

/** What the session did and waits for: the same the employee's sessions.get shows. */
function OutcomeView({ outcome }: { outcome: SessionOutcome }) {
  const waiting = outcome.waitingFor ?? []
  const produced = outcome.produced ?? []
  if (!waiting.length && !outcome.lastOutcome && !produced.length) return null
  return (
    <>
      <SectionTitle className="mt-5 mb-2">Outcome</SectionTitle>
      <div className="flex flex-col gap-2 text-micro" data-testid="session-outcome">
        {waiting.map((w) => (
          <p key={w} className="text-fg-secondary" data-testid="waiting-for">
            <span className="text-fg-tertiary">Waiting for </span>
            {w}
          </p>
        ))}
        {outcome.lastOutcome && (
          <p className="line-clamp-3 text-fg-secondary" title={outcome.lastOutcome}>
            <span className="text-fg-tertiary">Last run: </span>
            {outcome.lastOutcome}
          </p>
        )}
        {produced.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {produced.map((p) => (
              <li key={p} className="truncate font-mono text-fg-tertiary" title={p}>
                {p}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

function ChecklistView({ checklist }: { checklist: Checklist | null }) {
  if (!checklist) return <EmptyState text="This session has no checklist." />
  const items = checklist.data.items
  const done = items.filter((i) => i.checked).length
  return (
    <div className="flex flex-col gap-3" data-testid="checklist">
      <div className="flex items-center gap-3 text-micro text-fg-tertiary">
        <Progress value={(done / Math.max(1, items.length)) * 100} className="h-1 max-w-48" />
        {done} of {items.length} done · required items must be checked with evidence
      </div>
      <ul className="flex flex-col">
        {items.map((i) => (
          <li key={i.id} className="flex min-h-9 items-start gap-3 border-b py-2 last:border-0">
            <Checkbox checked={i.checked} disabled aria-label={i.text} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className={cn('text-fg-secondary', i.checked && 'text-fg-tertiary line-through decoration-fg-quaternary')}>
                {i.text}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-micro text-fg-quaternary">
                {i.required ? <span>required</span> : <span>optional</span>}
                {i.evidence?.length ? <span className="font-mono">evidence {i.evidence.map(shortId).join(', ')}</span> : null}
                {i.checkedAt && <span>checked {timeAgo(i.checkedAt)} ago</span>}
                {i.review && (
                  <span className="inline-flex items-center gap-1 text-[var(--blue)]">
                    <ShieldCheck className="size-3" /> review {i.review.state}
                  </span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RunsView({ runs, sessionId }: { runs: Run[]; sessionId: string }) {
  if (!runs.length) return <EmptyState text="No runs yet." />
  return (
    <div className="flex flex-col" data-testid="runs">
      {runs.map((r) => (
        <div key={r.id} className="flex h-9 items-center gap-3 border-b text-mini last:border-0">
          <StatusIcon status={r.data.state} />
          <span className="w-20 shrink-0 text-fg-secondary">{r.data.mode}</span>
          <span className="min-w-0 flex-1 truncate text-fg-tertiary">
            {r.data.cause.type}
            {r.data.cause.eventId && (
              <>
                {' · '}
                <ChatLink href={`/lineage/${r.data.cause.eventId}`} title={r.data.cause.eventId} className="font-mono text-micro">
                  {shortId(r.data.cause.eventId)}
                </ChatLink>
              </>
            )}
            {r.data.pauseReason && ` · ${r.data.pauseReason}`}
            {r.data.result?.error && <span className="text-[var(--red)]"> · {r.data.result.error}</span>}
            {r.data.commit && <span className="text-fg-quaternary"> · committed</span>}
          </span>
          <span className="shrink-0 text-micro tabular-nums text-fg-tertiary">{pluralize(r.data.steps, 'step')}</span>
          <span className="w-16 shrink-0 text-right text-micro text-fg-quaternary">
            {duration(r.data.startedAt, r.data.endedAt)}
          </span>
          <Link to={`/lineage/${r.id}`} className="shrink-0 text-fg-quaternary hover:text-foreground" aria-label="Run lineage">
            <Link2 className="size-3.5" />
          </Link>
        </div>
      ))}
      <p className="pt-3 text-micro text-fg-quaternary">
        Ephemeral runs leave the session as it was; continuing runs commit to it.
      </p>
      <span className="sr-only">{sessionId}</span>
    </div>
  )
}

function Composer({ sessionId, onSent }: { sessionId: string; onSent(): void }) {
  const api = useApi()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    if (!text.trim()) return
    setBusy(true)
    try {
      const r = await api.sendMessage(sessionId, text.trim())
      toast(r.inbox ? 'Delivered to the running run' : 'Delivered: starts a new run')
      setText('')
      onSent()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-4 rounded-lg border bg-level-1 focus-within:border-ring/70">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
        }}
        placeholder="Message this session… it's delivered like any other event"
        className="min-h-16 resize-none border-0 bg-transparent text-small shadow-none focus-visible:border-0 dark:bg-transparent"
        aria-label="Message"
      />
      <div className="flex items-center justify-end gap-2 px-2 pb-2">
        <Button size="sm" onClick={send} disabled={busy || !text.trim()}>
          <Send /> Send
        </Button>
      </div>
    </div>
  )
}

export function SessionDetailPage() {
  const { id = '' } = useParams()
  const api = useApi()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const preview = useLoad((a) => a.sessionPreview(id), [id])
  // The session's environment (metrics, desktop), live on the session's channel.
  const envs = useLoad((a) => a.environments({ sessionId: id }), [id])
  useEnvironmentsLive(envs, `session:${id}`)
  const env = envs.data?.items[0] ?? null
  const now = useNow(1000)
  const [envSheet, setEnvSheet] = useState(false)
  const [stopEnv, setStopEnv] = useState(false)
  const hasPorts = (preview.data?.ports.length ?? 0) > 0
  const hasDesktop = env?.desktop === true && env.status === 'running'
  const hasPreview = hasPorts || hasDesktop
  const asked = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'history') as Tab
  // The Preview tab exists only while the session's environment exposes ports or has a desktop.
  const tab: Tab = asked === 'preview' && preview.data && envs.data && !hasPreview ? 'history' : asked
  // Which the Preview tab shows: the desktop (`?desktop=1`, or when there are no ports) or the app.
  const showDesktop = hasDesktop && (params.get('desktop') === '1' || !hasPorts)
  const previewPort = Number(params.get('port')) || undefined
  const [highlight, setHighlight] = useState<string | null>(null)
  const detail = useLoad((a) => a.getSession(id), [id])
  const d = detail.data
  const activeRun = d?.activeRun ?? null
  const history = useLoad((a) => (activeRun ? a.runHistory(activeRun.id) : a.sessionHistory(id)), [id, activeRun?.id])
  const tree = useLoad((a) => a.sessionTree(id), [id])
  const entryTree = useLoad((a) => a.sessionEntryTree(id), [id])
  const runs = useLoad((a) => a.sessionRuns(id), [id])
  const subs = useLoad((a) => a.subscriptions({ sessionId: id }), [id])
  const createdAt = detail.data?.session.createdAt
  // Hours for a young session, days for an older one.
  const usageInterval = intervalFor(createdAt ? (Date.now() - Date.parse(createdAt)) / 3_600_000 : 0)
  const usage = useLoad(
    (a) =>
      Promise.all([
        a.usageBreakdown('model', { sessionId: id }),
        a.usageBreakdown('tool', { sessionId: id }),
        a.usageBreakdown(usageInterval, { sessionId: id }),
      ]),
    [id, usageInterval],
  )
  const { handle } = useEmployees()
  const [streaming, setStreaming] = useState<{ content: string; reasoning: string } | null>(null)

  const onLive = useCallback(
    (e: LiveEvent) => {
      switch (e.topic) {
        case 'entry.appended':
          history.setData((prev) =>
            prev && !prev.some((x) => x.id === e.payload.entry.id) ? [...prev, e.payload.entry as ApiEntry] : prev,
          )
          entryTree.setData((prev) =>
            prev && !prev.entries.some((x) => x.id === e.payload.entry.id)
              ? { ...prev, entries: [...prev.entries, e.payload.entry] }
              : prev,
          )
          if (e.payload.entry.kind === 'assistant') setStreaming(null)
          break
        case 'model.delta':
          setStreaming((s) => ({
            content: (s?.content ?? '') + (e.payload.content ?? ''),
            reasoning: (s?.reasoning ?? '') + (e.payload.reasoning ?? ''),
          }))
          break
        case 'step.started':
          if (e.payload.kind === 'model') setStreaming({ content: '', reasoning: '' })
          break
        case 'checklist.changed':
          detail.setData((prev) => (prev ? { ...prev, checklist: e.payload.checklist } : prev))
          break
        case 'usage.recorded':
          detail.setData((prev) =>
            prev
              ? {
                  ...prev,
                  tokens: {
                    ...prev.tokens,
                    total: prev.tokens.total + e.payload.usage.input + e.payload.usage.output,
                    input: prev.tokens.input + e.payload.usage.input,
                    output: prev.tokens.output + e.payload.usage.output,
                    cached: prev.tokens.cached + e.payload.usage.cached,
                    cost: prev.tokens.cost + e.payload.cost,
                    calls: prev.tokens.calls + 1,
                  },
                }
              : prev,
          )
          break
        case 'run.state':
          detail.reload()
          runs.reload()
          tree.reload()
          // A run may have started or torn down the environment.
          preview.reload()
          envs.reload()
          break
      }
    },
    [history, entryTree, detail, runs, tree, preview, envs],
  )
  useLive([`session:${id}`], onLive)

  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params)
    next.set('tab', t)
    setParams(next, { replace: true })
  }
  const showBranch = (entryId: string) => {
    setHighlight(entryId)
    setTab('branches')
  }
  const act = async (what: 'pause' | 'resume' | 'cancel') => {
    if (!activeRun) return
    if (what === 'pause') await api.pauseRun(activeRun.id)
    if (what === 'resume') await api.resumeRun(activeRun.id)
    if (what === 'cancel') await api.cancelRun(activeRun.id)
    detail.reload()
  }
  const fork = async () => {
    const s = await api.forkSession(id)
    toast('Forked', { description: s.data.title })
    navigate(`/sessions/${s.id}`)
  }
  const saveDoc = async (doc: string) => {
    if (!d) return
    const next = await api.updateRecord('session', id, { document: doc }, d.session.version)
    detail.setData((prev) => (prev ? { ...prev, session: next as SessionDetail['session'] } : prev))
    toast('Document saved')
  }
  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of d?.links ?? [])
      m.set(
        l.record.id,
        String(
          (l.record.data as Record<string, unknown>).title ?? (l.record.data as Record<string, unknown>).name ?? l.record.id,
        ),
      )
    return m
  }, [d])

  if (detail.error && !d)
    return (
      <Page title="Session">
        <ErrorState error={detail.error} retry={detail.reload} />
      </Page>
    )
  if (!d)
    return (
      <Page title="Session">
        <LoadingRows />
      </Page>
    )
  const s = d.session.data
  const runState: RunState | null = activeRun?.data.state ?? runs.data?.[0]?.data.state ?? null
  /** The run whose latest model call says how full the context is: the active one, else the newest that has it. */
  const contextRun = activeRun?.data.context ? activeRun : (runs.data?.find((r) => r.data.context) ?? null)
  const status = sessionStatusKey(s.status, runState)
  const live = activeRun && !TERMINAL_RUN_STATES.includes(activeRun.data.state)
  const stats = tree.data ? treeStats(tree.data) : null
  const done = d.checklist?.data.items.filter((i) => i.checked).length ?? 0
  // A checklist with no items is no checklist.
  const checklist = d.checklist?.data.items.length ? d.checklist : null

  return (
    <Page
      title={
        <span className="flex items-center gap-1.5">
          <Link to="/sessions" className="text-fg-tertiary hover:text-foreground">
            Sessions
          </Link>
          <ChevronRight className="size-3.5 text-fg-quaternary" />
          <span className="truncate">{s.title}</span>
        </span>
      }
      icon={<Workflow />}
      className="overflow-hidden"
      actions={
        <>
          <Can>
            {live && activeRun.data.state !== 'paused' && (
              <Button variant="ghost" size="sm" onClick={() => act('pause')}>
                <CirclePause /> Pause
              </Button>
            )}
            {live && activeRun.data.state === 'paused' && (
              <Button variant="ghost" size="sm" onClick={() => act('resume')}>
                <CirclePlay /> Resume
              </Button>
            )}
            {live && (
              <Button variant="ghost" size="sm" onClick={() => act('cancel')}>
                <X /> Cancel
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={fork}>
              <GitFork /> Fork
            </Button>
          </Can>
          <Button variant="outline" size="sm" asChild>
            <Link to={`/lineage/${id}`}>
              <Link2 /> Lineage
            </Link>
          </Button>
        </>
      }
    >
      <SplitView
        sideSize={300}
        sideMin={240}
        sideMax={420}
        main={
          <div className={cn('mx-auto px-6 pt-8 pb-16', tab === 'tree' ? 'max-w-[1120px]' : 'max-w-[720px]')}>
            <div className="mb-1 flex items-center gap-2 text-micro text-fg-tertiary">
              <StatusIcon status={status} />
              <span className="font-mono">
                @{handle(d.employee)}#{s.slug}
              </span>
              {s.parent && (
                <>
                  · forked from
                  <Link to={`/sessions/${s.parent.sessionId}`} className="hover:text-foreground">
                    {shortId(s.parent.sessionId)}
                  </Link>
                </>
              )}
            </div>
            <h2 className="mb-5 text-title3 font-semibold text-foreground">{s.title}</h2>
            <DocumentEditor
              value={s.document}
              title={s.title}
              onSave={saveDoc}
              resolve={(_k, rid) => names.get(rid)}
              className="mb-8"
            />
            <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
              <TabsList variant="line" className="h-8 w-full justify-start gap-3 overflow-x-auto overflow-y-hidden border-b pb-0">
                {TABS.filter((t) => t !== 'preview' || hasPreview).map((t) => (
                  <TabsTrigger key={t} value={t} className="flex-none px-0 capitalize">
                    {t}
                    {t === 'checklist' && checklist && (
                      <span className="text-fg-quaternary tabular-nums">
                        {done}/{checklist.data.items.length}
                      </span>
                    )}
                    {t === 'runs' && runs.data && <span className="text-fg-quaternary tabular-nums">{runs.data.length}</span>}
                    {t === 'threads' && d.threads.length > 0 && (
                      <span className="text-fg-quaternary tabular-nums">{d.threads.length}</span>
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="history" className="pt-3">
                {history.data ? (
                  <>
                    <Timeline
                      entries={history.data}
                      runStart={activeRun?.data.base ?? null}
                      runLabel={activeRun ? `${activeRun.data.mode} run · ${activeRun.data.state} · not committed yet` : null}
                      streaming={live ? streaming : null}
                      onShowBranch={showBranch}
                    />
                    {runs.data && <RecentRuns runs={runs.data} />}
                    <Can fallback={<ReadOnlyNote />}>
                      <Composer sessionId={id} onSent={history.reload} />
                    </Can>
                  </>
                ) : (
                  <LoadingRows />
                )}
              </TabsContent>
              <TabsContent value="preview" className="pt-3">
                {hasDesktop && hasPorts && (
                  <fieldset className="mb-2 flex w-fit items-center gap-0.5 rounded-md border p-0.5" aria-label="Show">
                    {[
                      { key: 'desktop', label: 'Desktop', on: showDesktop },
                      { key: 'app', label: 'App', on: !showDesktop },
                    ].map((o) => (
                      <Button
                        key={o.key}
                        size="sm"
                        variant={o.on ? 'secondary' : 'ghost'}
                        className={cn('h-6 px-2 text-micro', !o.on && 'text-fg-tertiary')}
                        aria-pressed={o.on}
                        onClick={() => {
                          const next = new URLSearchParams(params)
                          if (o.key === 'desktop') next.set('desktop', '1')
                          else next.delete('desktop')
                          setParams(next, { replace: true })
                        }}
                      >
                        {o.label}
                      </Button>
                    ))}
                  </fieldset>
                )}
                {showDesktop && env ? (
                  <DesktopViewer env={env} />
                ) : preview.data && hasPorts ? (
                  <PreviewPanel
                    preview={preview.data}
                    {...(previewPort ? { initialPort: previewPort } : {})}
                    onPortChange={(p) => {
                      const next = new URLSearchParams(params)
                      next.set('port', String(p))
                      setParams(next, { replace: true })
                    }}
                    onRefresh={preview.reload}
                  />
                ) : (
                  <LoadingRows />
                )}
              </TabsContent>
              <TabsContent value="branches" className="pt-3">
                <p className="mb-3 text-micro text-fg-tertiary">
                  The entry tree: the committed path on the left, run branches, rewound branches and offloaded entries to the
                  right. Nothing is ever deleted.
                </p>
                {entryTree.data ? <EntryTreeView tree={entryTree.data} highlight={highlight} /> : <LoadingRows />}
              </TabsContent>
              <TabsContent value="tree" className="pt-3">
                {stats && (
                  <p className="mb-3 text-micro text-fg-tertiary">
                    {pluralize(stats.sessions, 'session')} · {stats.live} live · {formatTokens(stats.tokens)} tokens in this tree
                  </p>
                )}
                {tree.data ? <SessionTreeGraph root={tree.data} currentId={id} height={400} /> : <LoadingRows />}
              </TabsContent>
              <TabsContent value="runs" className="pt-3">
                {runs.data ? <RunsView runs={runs.data} sessionId={id} /> : <LoadingRows />}
              </TabsContent>
              <TabsContent value="checklist" className="pt-3">
                <ChecklistView checklist={checklist} />
              </TabsContent>
              <TabsContent value="threads" className="pt-3">
                {d.threads.length === 0 ? (
                  <EmptyState
                    text="No chat threads are linked to this session."
                    action={
                      <Link to="/chat" className="text-[#828fff] hover:underline">
                        Open chat
                      </Link>
                    }
                  />
                ) : (
                  d.threads.map((t) => (
                    <Link
                      key={t.threadId}
                      to={`/chat/${t.channelId}/${t.threadId}`}
                      className="flex h-9 items-center gap-2 border-b text-fg-secondary last:border-0 hover:text-foreground"
                    >
                      <MessagesSquare className="size-4 text-fg-tertiary" />
                      <span className="truncate">{t.title}</span>
                    </Link>
                  ))
                )}
              </TabsContent>
              <TabsContent value="usage" className="pt-3">
                {usage.data ? (
                  <div className="flex flex-col gap-6">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {[
                        ['Tokens', formatTokens(d.tokens.total)],
                        ['Cached', `${Math.round((d.tokens.cached / Math.max(1, d.tokens.input)) * 100)}%`],
                        ['Model calls', String(d.tokens.calls)],
                        ['Cost', unpriced(d.tokens) ? '—' : formatCostOf(d.tokens)],
                      ].map(([k, v]) => (
                        <div key={k} className="rounded-lg border bg-level-1 px-3 py-2">
                          <div className="text-micro text-fg-tertiary">{k}</div>
                          <div className="text-title1 font-semibold tabular-nums">{v}</div>
                        </div>
                      ))}
                    </div>
                    <div>
                      <SectionTitle className="mb-2">By {usageInterval}</SectionTitle>
                      <UsageBars
                        rows={fillRows(
                          usage.data[2].rows,
                          usageInterval,
                          Math.max(Date.parse(d.session.createdAt), Date.now() - 14 * 86_400_000),
                          Date.now(),
                        )}
                        interval={usageInterval}
                        height={140}
                      />
                    </div>
                    <div className="grid gap-6 sm:grid-cols-2">
                      {[usage.data[0], usage.data[1]].map((b) => (
                        <div key={b.groupBy}>
                          <SectionTitle className="mb-1 capitalize">By {b.groupBy}</SectionTitle>
                          {b.rows.map((r) => (
                            <div key={r.key} className="flex h-7 items-center gap-2 text-mini">
                              <span className="min-w-0 flex-1 truncate font-mono text-micro text-fg-secondary">{r.label}</span>
                              <span className="tabular-nums text-fg-tertiary">{formatTokens(r.total)}</span>
                              <span
                                className="w-14 text-right tabular-nums text-fg-quaternary"
                                title={unpriced(r) ? NO_PRICING : undefined}
                              >
                                {formatCostOf(r)}
                              </span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <LoadingRows />
                )}
              </TabsContent>
            </Tabs>
          </div>
        }
        side={
          <aside className="h-full overflow-auto bg-level-1 px-4 py-4" data-testid="properties">
            <SectionTitle className="mb-2">Properties</SectionTitle>
            <div className="flex flex-col">
              <Prop label="Status">
                <StatusLabel status={status} />
              </Prop>
              <Prop label="Employee">
                <span className="inline-flex items-center gap-1.5">
                  <EmployeeAvatar name={d.employee.name} className="size-4" />
                  {d.employee.name}
                </span>
              </Prop>
              <Prop label="Slug">
                <span className="font-mono text-micro">{s.slug}</span>
              </Prop>
              {activeRun && (
                <Prop label="Run">
                  <span className="inline-flex items-center gap-1.5">
                    <StatusIcon status={activeRun.data.state} className="size-3.5" />
                    {activeRun.data.mode} · {pluralize(activeRun.data.steps, 'step')}
                  </span>
                </Prop>
              )}
              {contextRun?.data.context && (
                <Prop label="Context">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="tabular-nums" data-testid="context-size">
                        {formatTokens(contextRun.data.context.tokens)} / {formatTokens(contextRun.data.context.window)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-72 text-micro">
                      Prompt tokens at the latest model call ({contextRun.data.context.model}), against its context window. The
                      model is told at 50% and 75%; near the limit the harness compacts automatically.
                    </TooltipContent>
                  </Tooltip>
                </Prop>
              )}
              <Prop label="Tokens">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="tabular-nums">
                      {formatTokens(d.tokens.total)}
                      {unpriced(d.tokens) ? '' : ` · ${formatCostOf(d.tokens)}`}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="font-mono text-micro">
                    in {formatTokens(d.tokens.input)} · cached {formatTokens(d.tokens.cached)} · out{' '}
                    {formatTokens(d.tokens.output)}
                  </TooltipContent>
                </Tooltip>
              </Prop>
              {checklist && (
                <Prop label="Checklist">
                  <button type="button" onClick={() => setTab('checklist')} className="inline-flex w-full items-center gap-2">
                    <Progress value={(done / Math.max(1, checklist.data.items.length)) * 100} className="h-1" />
                    <span className="tabular-nums">
                      {done}/{checklist.data.items.length}
                    </span>
                  </button>
                </Prop>
              )}
              <Prop label="Model">{s.model ?? 'employee default'}</Prop>
              <Prop label="Tools">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>{s.toolset.length} fixed at creation</span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-72 font-mono text-micro">{s.toolset.join(', ')}</TooltipContent>
                </Tooltip>
              </Prop>
              <Prop label="Default run">{s.defaultRunMode ?? 'continuing'}</Prop>
              <Prop label="Created">{formatDateTime(d.session.createdAt)}</Prop>
              <Prop label="Updated">{timeAgo(d.session.updatedAt)} ago</Prop>
            </div>

            {d.outcome && <OutcomeView outcome={d.outcome} />}

            {env && (
              <>
                <SectionTitle className="mt-5 mb-2">Environment</SectionTitle>
                <EnvironmentCard
                  env={env}
                  now={now}
                  onLogs={() => setEnvSheet(true)}
                  onDesktop={() => {
                    const next = new URLSearchParams(params)
                    next.set('tab', 'preview')
                    next.set('desktop', '1')
                    setParams(next, { replace: true })
                  }}
                  onStop={() => setStopEnv(true)}
                />
              </>
            )}

            <SectionTitle className="mt-5 mb-1">Links</SectionTitle>
            {d.links.length === 0 ? (
              <p className="text-fg-quaternary">No links.</p>
            ) : (
              d.links.map((l) => {
                const data = l.record.data as Record<string, unknown>
                const name = String(data.title ?? data.name ?? l.record.id)
                return (
                  <Link
                    key={l.link.id}
                    to={hrefFor(l.record.kind, l.record.id)}
                    className="flex h-7 items-center gap-2 rounded-md px-1 hover:bg-secondary"
                  >
                    {l.record.kind === 'contact' ? (
                      <PersonAvatar name={name} className="size-4" />
                    ) : (
                      <span className="size-1.5 rounded-full bg-[var(--indigo)]" />
                    )}
                    <span className="min-w-0 truncate text-fg-secondary">{name}</span>
                    <span className="ml-auto shrink-0 text-micro text-fg-quaternary">{linkRole(l.link, id)}</span>
                  </Link>
                )
              })
            )}

            <SectionTitle className="mt-5 mb-1">Subscriptions</SectionTitle>
            {(subs.data ?? []).length === 0 ? (
              <p className="text-fg-quaternary">Not subscribed to anything.</p>
            ) : (
              subs.data!.map((sub) => (
                <div key={sub.id} className="flex h-7 items-center gap-2 px-1 text-mini">
                  <span
                    className={cn('size-1.5 rounded-full', sub.data.active ? 'bg-[var(--green)]' : 'bg-[var(--fg-quaternary)]')}
                  />
                  <SubjectLink subject={threadSubject(sub.data.subject, d.threads)} sessionId={id} />
                  <span className="ml-auto shrink-0 font-mono text-tiny text-fg-quaternary">{sub.data.subject.system}</span>
                  {sub.data.primary && <span className="shrink-0 text-tiny text-fg-tertiary">primary</span>}
                </div>
              ))
            )}

            <Collapsible defaultOpen className="mt-5">
              <CollapsibleTrigger className="group flex w-full items-center gap-1 text-micro font-medium text-fg-tertiary hover:text-foreground">
                <ChevronRight className="size-3 transition-quick group-data-[state=open]:rotate-90" />
                Fork tree
                {stats && <span className="ml-auto text-fg-quaternary">{stats.sessions}</span>}
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-1">
                {tree.data ? <TreeOutline root={tree.data} currentId={id} /> : null}
              </CollapsibleContent>
            </Collapsible>
            <div className="mt-5 flex items-center gap-2 text-micro text-fg-quaternary">
              <ListChecks className="size-3.5" />
              <span className="font-mono">{d.session.id}</span>
            </div>
          </aside>
        }
      />
      <EnvironmentSheet env={env} open={envSheet && !!env} onOpenChange={setEnvSheet} now={now} />
      <StopEnvironmentDialog
        env={stopEnv ? env : null}
        onOpenChange={setStopEnv}
        onStopped={() => {
          envs.reload()
          preview.reload()
        }}
      />
    </Page>
  )
}
