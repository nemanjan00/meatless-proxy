import { ApiRequestError, MEMORY_KINDS, type MemoryDetail, type MemoryItem, type MemoryListQuery } from '@mp/api'
import {
  Brain,
  CheckCheck,
  History,
  Lock,
  MessageSquare,
  PencilLine,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Users,
  Wrench,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { ANY, BarSelect, ConfirmDialog, RefChip, Tag, errorText } from '@/components/knowledge-ui.tsx'
import { Markdown } from '@/components/markdown.tsx'
import { type MemoryDraft, MemoryForm, NewMemoryDialog, scopeOf } from '@/components/new-memory-dialog.tsx'
import { Page } from '@/components/page.tsx'
import { EmployeeAvatar, PersonAvatar } from '@/components/people.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useApi, useLiveReload, useLoad } from '@/lib/api.tsx'
import { Can, useAuth } from '@/lib/auth.tsx'
import { agoPhrase, formatDateTime, pluralize, timeAgo } from '@/lib/format.ts'
import { MEMORY_KIND, fieldList, peopleIn, scopeWords } from '@/lib/knowledge.ts'
import { cn } from '@/lib/utils.ts'

/** URL parameters the filter bar owns ("Clear filters" removes them). */
const FILTER_PARAMS = ['employee', 'kind', 'about', 'taught', 'mine', 'q', 'sort']
const SORTS = [
  { value: 'learned', label: 'Newest first' },
  { value: 'used', label: 'Last used' },
  { value: 'updated', label: 'Recently changed' },
]

function KindIcon({ kind, className }: { kind: MemoryItem['memory']['data']['kind']; className?: string }) {
  const info = MEMORY_KIND[kind] ?? MEMORY_KIND.other
  const Icon = info.icon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex shrink-0', className)}>
          <Icon className="size-3.5" style={{ color: info.color }} aria-label={info.label} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{info.label}</TooltipContent>
    </Tooltip>
  )
}

/** Whose memory it is: an employee's avatar, or "shared". */
function Owner({ item, withName = false }: { item: MemoryItem; withName?: boolean }) {
  if (!item.employee)
    return (
      <span className="inline-flex items-center gap-1 text-fg-tertiary" title="Every employee shares it">
        <Users className="size-3.5" />
        {withName && 'Every employee'}
      </span>
    )
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={item.employee.name}>
      <EmployeeAvatar name={item.employee.name} className="size-4" />
      {withName && <span className="truncate text-fg-secondary">{item.employee.name}</span>}
    </span>
  )
}

function MemoryRow({ item, onOpen }: { item: MemoryItem; onOpen(): void }) {
  const d = item.memory.data
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="memory-row"
      className="group grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 px-4 py-2 text-left transition-quick hover:bg-secondary sm:px-6 lg:flex lg:h-9 lg:items-center lg:py-0"
    >
      <KindIcon kind={d.kind} className="pt-0.5 lg:pt-0" />
      <span className="flex min-w-0 flex-1 flex-col gap-1 lg:flex-row lg:items-center lg:gap-3">
        <span className="flex min-w-0 items-center gap-1.5">
          {item.personal && <Lock className="size-3 shrink-0 text-fg-quaternary" aria-label="Personal" />}
          <span className="min-w-0 truncate text-fg-secondary group-hover:text-foreground">{d.summary}</span>
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-1 lg:ml-auto lg:flex-nowrap lg:justify-end">
          {item.about.slice(0, 3).map((a) => (
            <RefChip key={a.id} r={a} />
          ))}
          {item.about.length > 3 && <Tag>+{item.about.length - 3}</Tag>}
          <span className="flex shrink-0 items-center gap-3 pl-1 text-micro text-fg-tertiary lg:hidden">
            <Owner item={item} withName />
            <span>learned {agoPhrase(item.memory.createdAt)}</span>
            <span>{item.lastUsedAt ? `used ${agoPhrase(item.lastUsedAt)}` : 'not used yet'}</span>
          </span>
        </span>
      </span>
      <span className="hidden shrink-0 items-center gap-3 text-micro text-fg-tertiary lg:flex">
        <span className="flex w-4 justify-center">
          <Owner item={item} />
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <time className="w-10 text-right tabular-nums" dateTime={item.memory.createdAt}>
              {timeAgo(item.memory.createdAt)}
            </time>
          </TooltipTrigger>
          <TooltipContent>Learned {formatDateTime(item.memory.createdAt)}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="w-16 text-right text-fg-quaternary tabular-nums">
              {item.lastUsedAt ? `used ${timeAgo(item.lastUsedAt)}` : 'unused'}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {item.lastUsedAt
              ? `Last recalled ${formatDateTime(item.lastUsedAt)} · ${pluralize(item.uses, 'time')}`
              : 'No employee has recalled it yet'}
          </TooltipContent>
        </Tooltip>
      </span>
    </button>
  )
}

function ListHeader() {
  return (
    <div
      className="hidden h-8 items-center gap-3 border-b px-6 text-micro text-fg-tertiary lg:flex"
      aria-hidden
      data-testid="memory-header"
    >
      <span className="w-3.5" />
      <span>Memory</span>
      <span className="ml-auto">About</span>
      <span className="w-4">By</span>
      <span className="w-10 text-right">Learned</span>
      <span className="w-16 text-right">Used</span>
    </div>
  )
}

// ─── Drawer ─────────────────────────────────────────────────────────────────

const draftOf = (m: MemoryDetail): MemoryDraft => ({
  summary: m.memory.data.summary,
  kind: m.memory.data.kind,
  content: m.memory.data.content ?? '',
  employeeId: m.memory.data.employeeId ?? '',
  about: m.about,
  scopeId: m.memory.data.scope?.type === 'company' ? 'company' : (m.memory.data.scope?.id ?? 'company'),
  note: '',
})

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-0.5 text-fg-tertiary">{label}</dt>
      <dd className="min-w-0 text-fg-secondary">{children}</dd>
    </>
  )
}

function SourceLine({ m }: { m: MemoryDetail }) {
  const s = m.source
  const bits: ReactNode[] = []
  if (s.person)
    bits.push(
      <span key="p" className="inline-flex items-center gap-1">
        {s.person.kind === 'ai' ? (
          <EmployeeAvatar name={s.person.name} className="size-3.5" />
        ) : (
          <PersonAvatar name={s.person.name} className="size-3.5" />
        )}
        {s.person.kind === 'person' ? (
          <Link to={`/contacts/${s.person.contactId}`} className="hover:text-foreground">
            {s.person.name}
          </Link>
        ) : (
          s.person.name
        )}
      </span>,
    )
  if (s.session)
    bits.push(
      <Link key="s" to={`/sessions/${s.session.id}`} className="text-[#828fff] hover:underline">
        {s.session.title}
      </Link>,
    )
  else if (s.private) bits.push(<span key="s">a private conversation</span>)
  if (s.message)
    bits.push(
      <Link
        key="m"
        to={`/chat/${s.message.channelId}/${s.message.threadId}`}
        className="inline-flex min-w-0 items-center gap-1 text-[#828fff] hover:underline"
        title={s.message.text}
      >
        <MessageSquare className="size-3 shrink-0" />
        <span className="truncate">{s.message.channelName ? `#${s.message.channelName}` : 'the message'}</span>
      </Link>,
    )
  if (!bits.length) return <span className="text-fg-quaternary">Not recorded</span>
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {bits.map((b, i) => (
        <span key={(b as { key?: string }).key ?? 'x'} className="inline-flex min-w-0 items-center gap-1.5">
          {i > 0 && <span className="text-fg-quaternary">·</span>}
          {b}
        </span>
      ))}
    </span>
  )
}

function HistoryList({ m }: { m: MemoryDetail }) {
  return (
    <ol className="flex flex-col gap-2" data-testid="memory-history">
      {m.history.map((h) => (
        <li key={h.version} className="flex min-w-0 flex-col gap-0.5 border-l-2 pl-3 text-micro">
          <span className="text-fg-secondary">
            v{h.version} ·{' '}
            {h.op === 'create'
              ? 'Learned'
              : h.note
                ? 'Corrected'
                : `Changed ${fieldList(h.changed.filter((f) => f !== 'correction')) || 'details'}`}
          </span>
          <span className="text-fg-quaternary">
            {h.actor.name} · {formatDateTime(h.at)}
          </span>
          {h.note && <span className="text-fg-tertiary italic">“{h.note}”</span>}
          {h.op !== 'create' && h.changed.includes('summary') && <span className="truncate text-fg-tertiary">{h.summary}</span>}
        </li>
      ))}
    </ol>
  )
}

function MemoryDrawerBody({ id, onClose, onChanged }: { id: string; onClose(): void; onChanged(): void }) {
  const api = useApi()
  const { me } = useAuth()
  const d = useLoad((a) => a.memory(id), [id])
  const [mode, setMode] = useState<'view' | 'edit' | 'correct'>('view')
  const [draft, setDraft] = useState<MemoryDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field?: 'summary' | 'note'; message: string } | null>(null)
  const [forgetOpen, setForgetOpen] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: back to reading when another memory opens
  useEffect(() => setMode('view'), [id])

  if (d.error && !d.data)
    return (
      <div className="p-6">
        <SheetTitle className="text-title1">Memory</SheetTitle>
        <p className="mt-3 text-fg-tertiary">
          {d.error instanceof ApiRequestError && d.error.status === 404
            ? "It's gone, or it's about someone else: memories about a person are only shown to them and to admins."
            : `Couldn't load it: ${d.error.message}`}
        </p>
      </div>
    )
  if (!d.data)
    return (
      <div className="p-2">
        <SheetTitle className="sr-only">Memory</SheetTitle>
        <LoadingRows rows={4} />
      </div>
    )
  const m = d.data
  const data = m.memory.data
  const info = MEMORY_KIND[data.kind] ?? MEMORY_KIND.other
  const KindGlyph = info.icon
  const aboutMe = peopleIn(m).some((p) => p.id === me?.contactId)
  const nameOf = (rid: string) => m.about.find((a) => a.id === rid)?.name

  const start = (next: 'edit' | 'correct') => {
    setDraft(draftOf(m))
    setError(null)
    setMode(next)
  }
  const save = async () => {
    if (!draft || busy) return
    if (!draft.summary.trim()) return setError({ field: 'summary', message: 'A memory needs a summary.' })
    if (mode === 'correct' && !draft.note.trim())
      return setError({ field: 'note', message: 'Say what was wrong: it goes in the history.' })
    setBusy(true)
    setError(null)
    try {
      const next = await api.updateMemory(m.memory.id, {
        summary: draft.summary.trim(),
        kind: draft.kind,
        content: draft.content.trim(),
        employeeId: draft.employeeId || null,
        about: draft.about.map((a) => ({ kind: a.kind as 'contact' | 'project', id: a.id })),
        scope: scopeOf(draft),
        ...(mode === 'correct' ? { note: draft.note.trim() } : {}),
        version: m.memory.version,
      })
      d.setData(next)
      setMode('view')
      toast(mode === 'correct' ? 'Corrected' : 'Saved', {
        description: mode === 'correct' ? 'The employees recall the corrected version from now on.' : undefined,
      })
      onChanged()
    } catch (e) {
      setError({
        message:
          e instanceof ApiRequestError && e.status === 409
            ? 'Someone changed it meanwhile, or another memory already says this. Reload and try again.'
            : errorText(e),
      })
    } finally {
      setBusy(false)
    }
  }
  const forget = async () => {
    setBusy(true)
    try {
      await api.forgetMemory(m.memory.id)
      toast('Forgotten', { description: 'No employee will recall it again.' })
      setForgetOpen(false)
      onChanged()
      onClose()
    } catch (e) {
      toast(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="memory-drawer">
      <div className="border-b px-5 pt-5 pb-4 pr-12">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <Tag className="text-fg-secondary">
            <KindGlyph className="size-3" style={{ color: info.color }} />
            {info.label}
          </Tag>
          {m.personal && (
            <Tag title="Only the people it's about and admins see it">
              <Lock className="size-3" /> Personal
            </Tag>
          )}
          {data.verified && (
            <Tag title={`Confirmed ${formatDateTime(data.verified)}`}>
              <ShieldCheck className="size-3" /> Confirmed {timeAgo(data.verified)}
            </Tag>
          )}
        </div>
        <SheetTitle className="text-title1 leading-snug font-semibold">{data.summary}</SheetTitle>
        <SheetDescription className="sr-only">A memory and where it came from</SheetDescription>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {mode !== 'view' && draft ? (
          <div className="flex flex-col gap-4" data-testid={mode === 'correct' ? 'memory-correct' : 'memory-edit'}>
            {mode === 'correct' && (
              <p className="text-mini text-fg-tertiary">
                Fix what's wrong and say why. The note is kept in its history, and the memory counts as confirmed now.
              </p>
            )}
            <MemoryForm
              value={draft}
              onChange={setDraft}
              correcting={mode === 'correct'}
              idPrefix="em"
              errors={error?.field ? { [error.field]: error.message } : {}}
            />
            {error && !error.field && (
              <p role="alert" className="text-micro text-[var(--red)]">
                {error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setMode('view')} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : mode === 'correct' ? 'Save correction' : 'Save'}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {data.content?.trim() ? (
              <Markdown text={data.content} className="mb-5 text-regular" />
            ) : (
              <p className="mb-5 text-fg-quaternary">No details beyond the summary.</p>
            )}
            <dl className="mb-6 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-mini">
              <Prop label="Remembered by">
                <Owner item={m} withName />
              </Prop>
              <Prop label="About">
                {m.about.length ? (
                  <span className="flex flex-wrap gap-1">
                    {m.about.map((a) => (
                      <RefChip key={a.id} r={a} />
                    ))}
                  </span>
                ) : (
                  <span className="text-fg-quaternary">Nothing in particular</span>
                )}
              </Prop>
              <Prop label="Comes up">{scopeWords(data.scope, nameOf)}</Prop>
              <Prop label="Learned">
                <span className="block">{formatDateTime(m.memory.createdAt)}</span>
                <span className="block text-micro text-fg-tertiary">
                  <SourceLine m={m} />
                </span>
              </Prop>
              <Prop label="Last used">
                {m.lastUsedAt ? (
                  <>
                    {agoPhrase(m.lastUsedAt)} <span className="text-fg-quaternary">· recalled {pluralize(m.uses, 'time')}</span>
                  </>
                ) : (
                  <span className="text-fg-quaternary">Not recalled yet</span>
                )}
              </Prop>
              {data.correction && (
                <Prop label="Corrected">
                  {agoPhrase(data.correction.at)} <span className="text-fg-tertiary italic">“{data.correction.note}”</span>
                </Prop>
              )}
            </dl>
            {m.personal && (
              <p className="mb-6 flex items-start gap-1.5 rounded-md bg-level-2 px-3 py-2 text-micro text-fg-tertiary">
                <Lock className="mt-0.5 size-3 shrink-0" />
                {aboutMe
                  ? "It's about you: only you and admins see it here. You can correct it or have it forgotten."
                  : 'Only the people it is about and admins see it here.'}
              </p>
            )}
            <h3 className="mb-2 flex items-center gap-1.5 text-micro font-medium text-fg-tertiary">
              <History className="size-3.5" /> History
            </h3>
            <HistoryList m={m} />
          </>
        )}
      </div>
      {mode === 'view' && m.canEdit && (
        <div className="flex flex-wrap items-center gap-1.5 border-t px-5 py-3" data-testid="memory-actions">
          <Button size="sm" variant="outline" onClick={() => start('correct')}>
            <Wrench /> Correct it
          </Button>
          <Button size="sm" variant="ghost" onClick={() => start('edit')}>
            <PencilLine /> Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              d.setData(await api.verifyMemory(m.memory.id))
              toast('Marked as still true')
              onChanged()
            }}
          >
            <CheckCheck /> Still true
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto text-[var(--red)]" onClick={() => setForgetOpen(true)}>
            <Trash2 /> Forget
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={forgetOpen}
        onOpenChange={setForgetOpen}
        title="Forget this memory?"
        description="It's deleted for good: no employee will recall it again, and its history goes with it. Correct it instead if it's only partly wrong."
        confirm="Forget it"
        busy={busy}
        onConfirm={forget}
      />
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

/** `/memory` (and `/memory/:id`, with that memory open): what the employees remember, filtered, with a drawer per memory. */
export function MemoryPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { me } = useAuth()
  const [text, setText] = useState(params.get('q') ?? '')
  const [newOpen, setNewOpen] = useState(false)
  const employee = params.get('employee') ?? ANY
  const kind = params.get('kind') ?? ANY
  const about = params.get('about') ?? ANY
  const taught = params.get('taught') ?? ANY
  const mine = params.get('mine') === '1'
  const sort = params.get('sort') ?? 'learned'
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === ANY) next.delete(k)
      else next.set(k, v)
    }
    setParams(next, { replace: true })
  }
  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get('q') ?? '') !== text) update({ q: text || null })
    }, 250)
    return () => clearTimeout(t)
  })
  const query: MemoryListQuery = {
    ...(employee !== ANY ? { employeeId: employee } : {}),
    ...(kind !== ANY ? { kind: kind as MemoryListQuery['kind'] } : {}),
    ...(about !== ANY ? { about } : {}),
    ...(taught !== ANY ? { taughtBy: taught } : {}),
    ...(mine ? { mine: true } : {}),
    ...(params.get('q') ? { text: params.get('q')! } : {}),
    ...(sort !== 'learned' ? { sort: sort as MemoryListQuery['sort'] } : {}),
    limit: 500,
  }
  const key = JSON.stringify(query)
  const list = useLoad((a) => a.memories(query), [key])
  useLiveReload(['records:memory'], list.reload)
  const facets = list.data?.facets
  const filtersSet = FILTER_PARAMS.some((k) => params.has(k)) || !!text
  const clear = () => {
    setText('')
    update(Object.fromEntries(FILTER_PARAMS.map((k) => [k, null])))
  }
  const open = (mid: string | null) => navigate({ pathname: mid ? `/memory/${mid}` : '/memory', search: params.toString() })
  const addButton = (variant: 'outline' | 'default') => (
    <Can>
      <Button size="sm" variant={variant} onClick={() => setNewOpen(true)}>
        <Plus /> Add memory
      </Button>
    </Can>
  )
  const withMissing = (opts: { value: string; label: ReactNode }[], value: string) =>
    value !== ANY && !opts.some((o) => o.value === value) ? [...opts, { value, label: 'Picked' }] : opts
  const items = list.data?.items ?? []

  return (
    <Page
      title="Memory"
      icon={<Brain />}
      actions={addButton('outline')}
      filters={
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2" data-testid="memory-filters">
          <div className="relative w-full min-w-0 sm:w-56">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-quaternary" />
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Search what they remember"
              aria-label="Search memories"
              className="h-7 pl-7 text-mini"
            />
          </div>
          <BarSelect
            label="Employee"
            value={employee}
            onChange={(v) => update({ employee: v })}
            options={withMissing(
              [
                { value: ANY, label: 'Any employee' },
                { value: 'shared', label: `Shared by all${facets ? ` · ${facets.shared}` : ''}` },
                ...(facets?.employees ?? []).map((e) => ({
                  value: e.id,
                  label: (
                    <>
                      <EmployeeAvatar name={e.name} className="size-3.5" />
                      {e.name} · {e.count}
                    </>
                  ),
                })),
              ],
              employee,
            )}
          />
          <BarSelect
            label="Kind"
            value={kind}
            onChange={(v) => update({ kind: v })}
            options={[
              { value: ANY, label: 'Any kind' },
              ...MEMORY_KINDS.map((k) => ({
                value: k,
                label: `${MEMORY_KIND[k].label}${facets ? ` · ${facets.kinds.find((x) => x.kind === k)?.count ?? 0}` : ''}`,
              })),
            ]}
          />
          <BarSelect
            label="About"
            value={about}
            onChange={(v) => update({ about: v })}
            options={withMissing(
              [
                { value: ANY, label: 'About anything' },
                ...(facets?.subjects ?? []).map((sub) => ({ value: sub.id, label: `${sub.name} · ${sub.count}` })),
              ],
              about,
            )}
          />
          <BarSelect
            label="Taught by"
            value={taught}
            onChange={(v) => update({ taught: v })}
            options={withMissing(
              [
                { value: ANY, label: 'Taught by anyone' },
                ...(facets?.teachers ?? []).map((t) => ({ value: t.contactId, label: `${t.name} · ${t.count}` })),
              ],
              taught,
            )}
          />
          {me && (
            <label htmlFor="memory-mine" className="flex h-7 items-center gap-1.5 text-micro text-fg-tertiary">
              <Checkbox id="memory-mine" checked={mine} onCheckedChange={(v) => update({ mine: v === true ? '1' : null })} />
              About me
            </label>
          )}
          {filtersSet && (
            <button type="button" onClick={clear} className="h-7 px-1 text-micro text-[#828fff] hover:underline">
              Clear filters
            </button>
          )}
          <span className="flex items-center gap-1.5 text-micro text-fg-tertiary sm:ml-auto">
            <BarSelect label="Sort" value={sort} onChange={(v) => update({ sort: v === 'learned' ? null : v })} options={SORTS} />
            <span className="text-fg-quaternary tabular-nums" data-testid="memory-count">
              {list.data ? pluralize(list.data.total, 'memory', 'memories') : ''}
            </span>
          </span>
        </div>
      }
    >
      <p className="border-b px-4 py-3 text-mini text-fg-tertiary sm:px-6" data-testid="memory-explainer">
        What the employees remember from their work and from what people tell them, so they don't ask twice: facts, preferences,
        feedback and decisions. They recall these in later sessions. Memories about a person are shown only to that person and to
        admins.
      </p>
      {list.error && !list.data ? (
        <ErrorState error={list.error} retry={list.reload} />
      ) : !list.data ? (
        <LoadingRows />
      ) : items.length === 0 ? (
        filtersSet ? (
          <EmptyState
            text="No memory matches these filters."
            action={
              <button type="button" onClick={clear} className="text-[#828fff] hover:underline">
                Clear filters
              </button>
            }
          />
        ) : (
          <EmptyState
            text="Nothing remembered yet. Employees remember as they work; you can also teach them something."
            action={addButton('default')}
          />
        )
      ) : (
        <div className="pb-10">
          <ListHeader />
          {items.map((i) => (
            <MemoryRow key={i.memory.id} item={i} onOpen={() => open(i.memory.id)} />
          ))}
        </div>
      )}
      <Sheet open={!!id} onOpenChange={(o) => !o && open(null)}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-[560px]">
          {id && <MemoryDrawerBody id={id} onClose={() => open(null)} onChanged={list.reload} />}
        </SheetContent>
      </Sheet>
      <NewMemoryDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={(mid) => {
          list.reload()
          open(mid)
        }}
      />
    </Page>
  )
}
