import type {
  Access,
  PersonDetail,
  PersonHandle,
  PersonItem,
  PersonLearnedFact,
  PersonSuggestion,
  PersonType,
  SignInLinkResult,
} from '@mp/api'
import {
  ArrowRight,
  Bot,
  Brain,
  Check,
  ChevronRight,
  FolderKanban,
  Link2,
  Pencil,
  Plus,
  Search,
  UserCheck,
  UserX,
  Users,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { ANY, BarSelect, ConfirmDialog, DetailSection, Field, SidePanel, Tag, errorText } from '@/components/knowledge-ui.tsx'
import { PickedChip } from '@/components/new-procedure-dialog.tsx'
import { HandlesEditor, NewPersonDialog, SignInLinkBox, cleanHandles } from '@/components/new-person-dialog.tsx'
import { Page } from '@/components/page.tsx'
import { EmployeeAvatar, PersonAvatar } from '@/components/people.tsx'
import { RecordPicker } from '@/components/record-picker.tsx'
import { SplitView } from '@/components/split-view.tsx'
import { StatusIcon } from '@/components/status-icon.tsx'
import { selectClass } from '@/components/start-form.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useApi, useLiveReload, useLoad } from '@/lib/api.tsx'
import { Can, useAuth } from '@/lib/auth.tsx'
import { agoPhrase, formatDateTime, pluralize, timeAgo } from '@/lib/format.ts'
import { ACCESS_INFO, ACCESS_ORDER, PERSON_TYPES, systemLabel } from '@/lib/knowledge.ts'
import { sessionStatusKey } from '@/lib/status.ts'
import { cn } from '@/lib/utils.ts'

const LIVE = ['records:contact', 'records:employee'] as const
const FILTER_PARAMS = ['type', 'access', 'team', 'q', 'deactivated']

function Avatar({ p, className }: { p: PersonItem; className?: string }) {
  return p.type === 'person' ? (
    <PersonAvatar name={p.contact.data.name} className={className} />
  ) : (
    <EmployeeAvatar name={p.contact.data.name} className={className} />
  )
}

/** Where a row goes: an AI employee's own page, else the person's. */
const hrefOf = (p: PersonItem) => (p.employeeId ? `/employees/${p.employeeId}` : `/contacts/${p.contact.id}`)

function AccessTag({ p }: { p: PersonItem }) {
  if (p.deactivated) return <Tag className="text-[var(--red)]">deactivated</Tag>
  if (p.type === 'ai') return <Tag>AI employee</Tag>
  if (p.type === 'agent') return <Tag>agent</Tag>
  if (p.noAccess)
    return (
      <Tag className="text-fg-quaternary" title="Found through an integration; give them access to let them sign in">
        can't sign in
      </Tag>
    )
  const a = p.access ?? 'viewer'
  return (
    <Tag className={cn(a === 'admin' && 'text-foreground', a === 'viewer' && 'text-fg-quaternary')} title={ACCESS_INFO[a].hint}>
      {a}
    </Tag>
  )
}

const handlesText = (p: PersonItem) =>
  (p.contact.data.handles ?? [])
    .filter((h) => h.system !== 'mp')
    .map((h) => `${systemLabel(h.system)} ${h.id}`)
    .join(' · ')

function PersonRow({ p, showSignIn }: { p: PersonItem; showSignIn: boolean }) {
  const d = p.contact.data
  const handles = handlesText(p)
  return (
    <Link
      to={hrefOf(p)}
      data-testid="person-row"
      className={cn(
        'group grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2 transition-quick hover:bg-secondary sm:px-6 lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,14rem)_minmax(0,12rem)_5.5rem_4.5rem] lg:py-1.5',
        p.deactivated && 'opacity-60',
      )}
    >
      <Avatar p={p} className="size-6" />
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-fg-secondary group-hover:text-foreground">{d.name}</span>
          {p.sponsor && <span className="hidden truncate text-micro text-fg-quaternary sm:inline">for {p.sponsor.name}</span>}
        </span>
        <span className="truncate text-micro text-fg-tertiary">
          {[d.role, d.team].filter(Boolean).join(' · ') || (p.type === 'person' ? 'No title yet' : '')}
        </span>
        <span className="truncate text-micro text-fg-quaternary lg:hidden">{[d.email, handles].filter(Boolean).join(' · ')}</span>
      </span>
      <span className="hidden min-w-0 flex-col lg:flex">
        <span className="truncate text-micro text-fg-secondary">{d.email ?? <span className="text-fg-quaternary">—</span>}</span>
        <span className="truncate font-mono text-tiny text-fg-quaternary">{handles}</span>
      </span>
      <span className="hidden min-w-0 flex-wrap gap-1 lg:flex">
        {p.projects.slice(0, 2).map((pr) => (
          <Tag key={pr.id} title={`${pr.name}: ${pr.roles.join(', ')}`} className="max-w-28 truncate">
            <FolderKanban className="size-3 shrink-0" />
            <span className="truncate">{pr.name}</span>
          </Tag>
        ))}
        {p.projects.length > 2 && <Tag>+{p.projects.length - 2}</Tag>}
      </span>
      <span className="justify-self-end lg:justify-self-start">
        <AccessTag p={p} />
      </span>
      <span className="hidden text-right text-micro text-fg-quaternary tabular-nums lg:block">
        {p.type !== 'person' ? (
          ''
        ) : p.lastSignInAt ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>{timeAgo(p.lastSignInAt)}</span>
            </TooltipTrigger>
            <TooltipContent>
              Signed in {formatDateTime(p.lastSignInAt)}
              {p.lastSeenAt ? `, last active ${agoPhrase(p.lastSeenAt)}` : ''}
            </TooltipContent>
          </Tooltip>
        ) : showSignIn ? (
          'never'
        ) : (
          ''
        )}
      </span>
    </Link>
  )
}

/** `/contacts`: people, AI employees and agents, with access, projects and last sign-in; admins add people here. */
export function PeoplePage() {
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const navigate = useNavigate()
  const admin = can('admin')
  const [text, setText] = useState(params.get('q') ?? '')
  const [newOpen, setNewOpen] = useState(false)
  const type = (params.get('type') ?? ANY) as PersonType | typeof ANY
  const access = params.get('access') ?? ANY
  const team = params.get('team') ?? ANY
  const showDeactivated = params.get('deactivated') === '1'
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
    }, 200)
    return () => clearTimeout(t)
  })
  const list = useLoad((a) => a.people(), [])
  useLiveReload([...LIVE], list.reload)
  const all = list.data ?? []
  const teams = useMemo(
    () => [...new Set(all.map((p) => p.contact.data.team).filter((t): t is string => !!t))].sort((a, b) => a.localeCompare(b)),
    [all],
  )
  const words = (params.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const shown = all.filter((p) => {
    const d = p.contact.data
    if (type !== ANY && p.type !== type) return false
    if (access !== ANY && p.access !== access) return false
    if (team !== ANY && d.team !== team) return false
    if (!showDeactivated && p.deactivated) return false
    if (words.length) {
      const hay = [d.name, d.email, d.role, d.team, ...(d.handles ?? []).map((h) => h.id)].filter(Boolean).join(' ').toLowerCase()
      if (!words.every((w) => hay.includes(w))) return false
    }
    return true
  })
  const counts = Object.fromEntries(
    PERSON_TYPES.map((t) => [t.value, all.filter((p) => p.type === t.value && !p.deactivated).length]),
  )
  const deactivatedCount = all.filter((p) => p.deactivated).length
  const filtersSet = FILTER_PARAMS.some((k) => params.has(k)) || !!text
  const clear = () => {
    setText('')
    update(Object.fromEntries(FILTER_PARAMS.map((k) => [k, null])))
  }
  const addButton = (variant: 'outline' | 'default') => (
    <Can need="admin">
      <Button size="sm" variant={variant} onClick={() => setNewOpen(true)}>
        <Plus /> Add person
      </Button>
    </Can>
  )
  return (
    <Page
      title="People"
      icon={<Users />}
      actions={addButton('outline')}
      filters={
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2" data-testid="people-filters">
          <div className="flex items-center gap-0.5" role="tablist" aria-label="Show">
            {[{ value: ANY, plural: 'Everyone' }, ...PERSON_TYPES].map((t) => (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={type === t.value}
                onClick={() => update({ type: t.value })}
                className={cn(
                  'h-6 rounded-md border border-transparent px-2 text-fg-tertiary transition-quick hover:text-foreground',
                  type === t.value && 'border-border bg-secondary text-foreground',
                )}
              >
                {t.plural}
                {t.value !== ANY && list.data && <span className="ml-1 text-fg-quaternary tabular-nums">{counts[t.value]}</span>}
              </button>
            ))}
          </div>
          <div className="relative w-full min-w-0 sm:w-56">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-quaternary" />
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Name, email, team or handle"
              aria-label="Search people"
              className="h-7 pl-7 text-mini"
            />
          </div>
          <BarSelect
            label="Access"
            value={access}
            onChange={(v) => update({ access: v })}
            options={[
              { value: ANY, label: 'Any access' },
              ...ACCESS_ORDER.map((a) => ({ value: a, label: ACCESS_INFO[a].label })),
            ]}
          />
          <BarSelect
            label="Team"
            value={team}
            onChange={(v) => update({ team: v })}
            options={[{ value: ANY, label: 'Any team' }, ...teams.map((t) => ({ value: t, label: t }))]}
          />
          {deactivatedCount > 0 && (
            <label htmlFor="people-deactivated" className="flex h-7 items-center gap-1.5 text-micro text-fg-tertiary">
              <Checkbox
                id="people-deactivated"
                checked={showDeactivated}
                onCheckedChange={(v) => update({ deactivated: v === true ? '1' : null })}
              />
              Deactivated ({deactivatedCount})
            </label>
          )}
          {filtersSet && (
            <button type="button" onClick={clear} className="h-7 px-1 text-micro text-[#828fff] hover:underline">
              Clear filters
            </button>
          )}
          <span className="ml-auto text-micro text-fg-quaternary tabular-nums" data-testid="people-count">
            {list.data ? pluralize(shown.length, 'entry', 'entries') : ''}
          </span>
        </div>
      }
    >
      <p className="border-b px-4 py-3 text-mini text-fg-tertiary sm:px-6" data-testid="people-explainer">
        Everyone the employees work with: people, the AI employees themselves, and local agents that joined chat. People sign in
        with a one-time link, and their access decides what they can do here. Employees recognise people by their handles in
        Slack, GitLab and Linear.
      </p>
      {list.error && !list.data ? (
        <ErrorState error={list.error} retry={list.reload} />
      ) : !list.data ? (
        <LoadingRows />
      ) : shown.length === 0 ? (
        <EmptyState
          text={filtersSet ? 'Nobody matches these filters.' : 'Nobody here yet.'}
          action={
            filtersSet ? (
              <button type="button" onClick={clear} className="text-[#828fff] hover:underline">
                Clear filters
              </button>
            ) : (
              addButton('default')
            )
          }
        />
      ) : (
        <div className="pb-10">
          <div
            className="hidden h-8 items-center gap-3 border-b px-6 text-micro text-fg-tertiary lg:grid lg:grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,14rem)_minmax(0,12rem)_5.5rem_4.5rem]"
            aria-hidden
          >
            <span />
            <span>Name</span>
            <span>Email and handles</span>
            <span>Projects</span>
            <span>Access</span>
            <span className="text-right">Signed in</span>
          </div>
          {shown.map((p) => (
            <PersonRow key={p.contact.id} p={p} showSignIn={admin} />
          ))}
        </div>
      )}
      <NewPersonDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        teams={teams}
        onCreated={(r) => {
          list.reload()
          if (!r.signInLink) navigate(`/contacts/${r.person.contact.id}`)
        }}
      />
    </Page>
  )
}

// ─── Person page ────────────────────────────────────────────────────────────

function EditPersonDialog({
  open,
  onOpenChange,
  detail,
  onSaved,
}: {
  open: boolean
  onOpenChange(o: boolean): void
  detail: PersonDetail
  onSaved(d: PersonDetail): void
}) {
  const api = useApi()
  const c = detail.contact
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('')
  const [team, setTeam] = useState('')
  const [manager, setManager] = useState<{ id: string; label: string } | null>(null)
  const [handles, setHandles] = useState<PersonHandle[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: fill in when it opens
  useEffect(() => {
    if (!open) return
    setName(c.data.name)
    setEmail(c.data.email ?? '')
    setRole(c.data.role ?? '')
    setTeam(c.data.team ?? '')
    setManager(detail.manager ? { id: detail.manager.contactId, label: detail.manager.name } : null)
    setHandles((c.data.handles ?? []).filter((h) => h.system !== 'mp'))
    setError(null)
  }, [open])
  const save = async () => {
    if (!name.trim()) return setError('A name is needed.')
    setBusy(true)
    try {
      onSaved(
        await api.updatePerson(c.id, {
          name: name.trim(),
          email: email.trim() || null,
          role: role.trim() || null,
          team: team.trim() || null,
          manager: manager?.id ?? null,
          handles: cleanHandles(handles),
          version: c.version,
        }),
      )
      toast('Saved')
      onOpenChange(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[92svh] gap-4 overflow-y-auto sm:max-w-[560px]" data-testid="edit-person-dialog">
        <DialogHeader>
          <DialogTitle className="text-title1">Edit {c.data.name}</DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">
            Their profile, as the employees see it. Access is changed in the side panel.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="ep-name" label="Name">
              <Input id="ep-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field id="ep-email" label="Email">
              <Input id="ep-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field id="ep-role" label="Title">
              <Input id="ep-role" value={role} onChange={(e) => setRole(e.target.value)} />
            </Field>
            <Field id="ep-team" label="Team">
              <Input id="ep-team" value={team} onChange={(e) => setTeam(e.target.value)} />
            </Field>
          </div>
          <Field id="ep-manager" label="Manager">
            {manager ? (
              <PickedChip label={manager.label} onClear={() => setManager(null)} clearLabel="Change manager" />
            ) : (
              <RecordPicker
                id="ep-manager"
                kinds={['contact']}
                exclude={[c.id]}
                filter={(r) => ((r.data as { kind?: string }).kind ?? 'person') === 'person'}
                placeholder="Type a name"
                onPick={(o) => setManager({ id: o.id, label: o.label })}
              />
            )}
          </Field>
          <Field label="Handles">
            <HandlesEditor value={handles} onChange={setHandles} idPrefix="ep-h" />
          </Field>
          {error && (
            <p role="alert" className="text-micro text-[var(--red)]">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Tokens({ detail, onChanged }: { detail: PersonDetail; onChanged(): void }) {
  const api = useApi()
  const { me } = useAuth()
  if (!detail.tokens) return null
  const self = me?.contactId === detail.contact.id
  const live = detail.tokens.filter((t) => !t.revoked)
  return (
    <DetailSection
      title={`API tokens${live.length ? ` · ${live.length}` : ''}`}
      id="person-tokens"
      actions={
        self ? (
          <Button variant="ghost" size="xs" asChild>
            <Link to="/settings/tokens">
              <Plus /> New token
            </Link>
          </Button>
        ) : undefined
      }
    >
      {detail.tokens.length === 0 ? (
        <p className="text-fg-tertiary">No tokens. Tokens let scripts and agents act as {self ? 'you' : 'them'}.</p>
      ) : (
        <ul className="flex flex-col">
          {detail.tokens.map((t) => (
            <li
              key={t.id}
              className={cn('flex min-h-9 items-center gap-2 text-mini', t.revoked && 'opacity-60')}
              data-testid="person-token"
            >
              <span className="min-w-0 truncate text-fg-secondary">{t.name ?? 'Unnamed token'}</span>
              <span className="shrink-0 text-micro text-fg-quaternary">created {agoPhrase(t.createdAt)}</span>
              {t.revoked ? (
                <Tag className="ml-auto">revoked</Tag>
              ) : (
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto text-[var(--red)]"
                  onClick={async () => {
                    await api.revokeToken(t.id)
                    toast(`${t.name ?? 'Token'} revoked`, { description: 'It stops working right away.' })
                    onChanged()
                  }}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </DetailSection>
  )
}

/** "learned by Infra Bot from <source>, 2 days ago": where an AI employee got a field or note. */
function Provenance({ fact }: { fact: PersonLearnedFact }) {
  return (
    <p className="mt-0.5 text-micro text-fg-quaternary" data-testid="person-provenance">
      learned by{' '}
      <Link to={`/employees/${fact.employee.employeeId}`} className="text-fg-tertiary hover:text-foreground">
        {fact.employee.name}
      </Link>{' '}
      from <span className="text-fg-tertiary">{fact.source}</span>,{' '}
      <time dateTime={fact.at} title={formatDateTime(fact.at)}>
        {agoPhrase(fact.at)}
      </time>
      {fact.acceptedBy && <> · accepted by {fact.acceptedBy.name}</>}
    </p>
  )
}

const FIELD_LABEL: Record<PersonSuggestion['field'], string> = { role: 'Role', team: 'Team', manager: 'Manager' }

/** Changes employees suggested for fields that already have a value: the person or an admin accepts or rejects them. */
function Suggestions({ detail, onChanged }: { detail: PersonDetail; onChanged(d: PersonDetail): void }) {
  const api = useApi()
  const [busy, setBusy] = useState<string | null>(null)
  if (!detail.suggestions.length) return null
  const first = detail.contact.data.name.split(' ')[0]
  const decide = async (x: PersonSuggestion, accept: boolean) => {
    setBusy(x.id)
    try {
      const next = accept
        ? await api.acceptPersonSuggestion(detail.contact.id, x.id)
        : await api.rejectPersonSuggestion(detail.contact.id, x.id)
      toast(accept ? `${FIELD_LABEL[x.field]} updated` : 'Suggestion dismissed')
      onChanged(next)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <DetailSection title={`Suggested changes · ${detail.suggestions.length}`} id="person-suggestions">
      {!detail.canReview && <p className="mb-2 text-micro text-fg-tertiary">Only {first} or an admin can accept these.</p>}
      <ul className="flex flex-col gap-3">
        {detail.suggestions.map((x) => (
          <li key={x.id} className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start" data-testid="person-suggestion">
            <div className="min-w-0 flex-1">
              <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-mini">
                <span className="text-fg-tertiary">{FIELD_LABEL[x.field]}</span>
                <span className="text-fg-tertiary line-through">{x.currentLabel ?? x.current ?? 'None'}</span>
                <ArrowRight className="size-3 text-fg-quaternary" />
                <span className="font-medium text-foreground">{x.proposedLabel ?? x.proposed}</span>
              </p>
              <p className="mt-0.5 text-micro text-fg-quaternary">
                suggested by{' '}
                <Link to={`/employees/${x.employee.employeeId}`} className="text-fg-tertiary hover:text-foreground">
                  {x.employee.name}
                </Link>{' '}
                from <span className="text-fg-tertiary">{x.source}</span>,{' '}
                <time dateTime={x.suggestedAt} title={formatDateTime(x.suggestedAt)}>
                  {agoPhrase(x.suggestedAt)}
                </time>
                {x.times > 1 && <> · said {x.times} times</>}
              </p>
            </div>
            {detail.canReview && (
              <div className="flex shrink-0 gap-1">
                <Button size="xs" variant="outline" disabled={busy === x.id} onClick={() => decide(x, true)}>
                  <Check /> Accept
                </Button>
                <Button size="xs" variant="ghost" disabled={busy === x.id} onClick={() => decide(x, false)}>
                  <X /> Reject
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </DetailSection>
  )
}

/** The bio, with the notes employees added shown with where they came from. */
function Bio({ detail }: { detail: PersonDetail }) {
  const bio = detail.contact.data.bio?.trim()
  if (!bio) return null
  const notes = new Map(detail.learned.filter((f) => f.field === 'bio' && f.line).map((f) => [f.line!, f]))
  return (
    <DetailSection title="Bio" id="person-bio">
      <ul className="flex flex-col gap-2 text-mini">
        {bio.split('\n').map((line, i) => {
          const note = notes.get(line)
          if (!line.trim()) return null
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: bio lines can repeat, their order is stable
            <li key={i} className="min-w-0 break-words text-fg-secondary">
              {note ? (
                <>
                  <span>{note.value}</span>
                  <Provenance fact={note} />
                </>
              ) : (
                line
              )}
            </li>
          )
        })}
      </ul>
    </DetailSection>
  )
}

function RecentRequests({ id }: { id: string }) {
  const list = useLoad((a) => a.listSessions({ requesterId: id, limit: 8, sort: 'activity' }), [id])
  return (
    <DetailSection
      title={`Recent requests${list.data?.total ? ` · ${list.data.total}` : ''}`}
      id="person-requests"
      actions={
        list.data?.total ? (
          <Button variant="ghost" size="xs" asChild>
            <Link to={`/sessions?requester=${id}`}>All of them</Link>
          </Button>
        ) : undefined
      }
    >
      {!list.data ? (
        <LoadingRows rows={2} />
      ) : list.data.items.length === 0 ? (
        <p className="text-fg-tertiary">Nothing asked of the employees yet.</p>
      ) : (
        <ul className="flex flex-col">
          {list.data.items.map((r) => {
            const at = r.lastActivityAt ?? r.session.updatedAt
            return (
              <li key={r.session.id}>
                <Link
                  to={`/sessions/${r.session.id}`}
                  data-testid="person-request"
                  className="group -mx-2 flex h-9 min-w-0 items-center gap-2.5 rounded-md px-2 hover:bg-secondary"
                >
                  <StatusIcon status={sessionStatusKey(r.session.data.status, r.runState)} />
                  <span className="min-w-0 flex-1 truncate text-fg-secondary group-hover:text-foreground">
                    {r.session.data.title}
                  </span>
                  {r.project && <Tag className="hidden max-w-32 truncate sm:inline-flex">{r.project.name}</Tag>}
                  <EmployeeAvatar name={r.employee.name} className="size-4" />
                  <time className="w-8 shrink-0 text-right text-micro text-fg-quaternary tabular-nums" dateTime={at}>
                    {timeAgo(at)}
                  </time>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </DetailSection>
  )
}

function AccessPanel({ detail, onChanged }: { detail: PersonDetail; onChanged(d: PersonDetail): void }) {
  const api = useApi()
  const [link, setLink] = useState<SignInLinkResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const name = detail.contact.data.name
  if (detail.type !== 'person')
    return (
      <SidePanel title="Access">
        <p className="text-micro text-fg-tertiary">
          {detail.type === 'ai'
            ? 'AI employees never sign in: they act with their own permissions.'
            : `A local agent acts for ${detail.sponsor?.name ?? 'its sponsor'}, with their access (at most member).`}
        </p>
      </SidePanel>
    )
  const access = detail.access ?? 'viewer'
  return (
    <>
      <SidePanel title="Access" testId="person-access">
        {detail.canAdmin && !detail.deactivated ? (
          <select
            aria-label="Access"
            value={detail.noAccess ? '' : access}
            className={selectClass}
            onChange={async (e) => {
              try {
                onChanged(await api.updatePerson(detail.contact.id, { access: e.target.value as Access }))
                toast(`${name} is now ${e.target.value === 'admin' ? 'an' : 'a'} ${e.target.value}`)
              } catch (err) {
                toast(errorText(err))
              }
            }}
          >
            {detail.noAccess && (
              <option value="" disabled>
                Can't sign in
              </option>
            )}
            {ACCESS_ORDER.map((a) => (
              <option key={a} value={a}>
                {ACCESS_INFO[a].label}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-mini text-fg-secondary">{detail.deactivated ? 'Deactivated' : ACCESS_INFO[access].label}</p>
        )}
        <p className="mt-1 text-micro text-fg-tertiary">
          {detail.deactivated
            ? `Deactivated ${agoPhrase(String(detail.contact.data.deactivatedAt))}: can't sign in. Their history stays.`
            : detail.noAccess
              ? `Found through ${String(detail.contact.data.source ?? 'an integration')}: they can't sign in until you choose an access.`
              : ACCESS_INFO[access].hint}
        </p>
      </SidePanel>
      <SidePanel title="Sign-in" testId="person-sign-in">
        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-y-1 text-micro">
          <dt className="text-fg-tertiary">Last sign-in</dt>
          <dd className="text-fg-secondary">
            {detail.lastSignInAt ? agoPhrase(detail.lastSignInAt) : detail.canAdmin || detail.tokens ? 'Never' : '—'}
          </dd>
          <dt className="text-fg-tertiary">Last active</dt>
          <dd className="text-fg-secondary">{detail.lastSeenAt ? agoPhrase(detail.lastSeenAt) : '—'}</dd>
        </dl>
        {detail.canAdmin && (
          <div className="mt-3 flex flex-col gap-2">
            {link && <SignInLinkBox link={link} name={name} />}
            {detail.deactivated ? (
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    onChanged(await api.reactivatePerson(detail.contact.id))
                    toast(`${name} can sign in again`, { description: 'Send them a new sign-in link.' })
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                <UserCheck /> Reactivate
              </Button>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      setLink(await api.personSignInLink(detail.contact.id))
                    } catch (e) {
                      toast(errorText(e))
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  <Link2 /> {link ? 'New link' : 'Sign-in link'}
                </Button>
                <Button size="sm" variant="ghost" className="text-[var(--red)]" onClick={() => setConfirm(true)}>
                  <UserX /> Deactivate
                </Button>
              </div>
            )}
          </div>
        )}
      </SidePanel>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Deactivate ${name}?`}
        description="They're signed out everywhere and can't sign in again; their API tokens stop working. Their sessions, messages and history stay. You can reactivate them later."
        confirm="Deactivate"
        busy={busy}
        onConfirm={async () => {
          setBusy(true)
          try {
            onChanged(await api.deactivatePerson(detail.contact.id))
            setLink(null)
            toast(`${name} was deactivated`)
            setConfirm(false)
          } catch (e) {
            toast(errorText(e))
          } finally {
            setBusy(false)
          }
        }}
      />
    </>
  )
}

/** `/contacts/:id`: a person's profile, access, projects, memories about them, requests and tokens. */
export function PersonPage() {
  const { id = '' } = useParams()
  const d = useLoad((a) => a.person(id), [id])
  useLiveReload([...LIVE], d.reload)
  const [editOpen, setEditOpen] = useState(false)
  const back = (
    <span className="flex min-w-0 items-center gap-1.5">
      <Link to="/contacts" className="shrink-0 text-fg-tertiary hover:text-foreground">
        People
      </Link>
      <ChevronRight className="size-3.5 shrink-0 text-fg-quaternary" />
      <span className="truncate">{d.data?.contact.data.name ?? ''}</span>
    </span>
  )
  if (d.error && !d.data)
    return (
      <Page title={back} icon={<Users />}>
        <ErrorState error={d.error} retry={d.reload} />
      </Page>
    )
  if (!d.data)
    return (
      <Page title={back} icon={<Users />}>
        <LoadingRows />
      </Page>
    )
  const p = d.data
  const c = p.contact.data
  const handles = (c.handles ?? []).filter((h) => h.system !== 'mp')
  const first = c.name.split(' ')[0]
  const learnedField = (field: PersonLearnedFact['field']) => p.learned.find((f) => f.field === field)
  return (
    <Page
      title={back}
      icon={<Users />}
      className="overflow-hidden"
      actions={
        <>
          {p.employeeId && (
            <Button size="sm" variant="ghost" asChild>
              <Link to={`/employees/${p.employeeId}`} aria-label="Employee page">
                <Bot /> <span className="hidden sm:inline">Employee page</span>
              </Link>
            </Button>
          )}
          {p.canEdit && (
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil /> Edit
            </Button>
          )}
        </>
      }
    >
      <SplitView
        sideSize={320}
        sideMin={280}
        sideMax={420}
        main={
          <div className="mx-auto max-w-[720px] px-4 pt-8 pb-16 sm:px-6">
            {p.deactivated && (
              <p className="mb-4 rounded-md border px-3 py-2 text-mini text-fg-tertiary">
                Deactivated: {first} can't sign in. Their sessions and history are kept.
              </p>
            )}
            <div className="mb-6 flex min-w-0 items-center gap-4">
              <Avatar p={p} className="size-12 text-title1" />
              <div className="min-w-0">
                <h2 className="text-title3 font-semibold break-words">{c.name}</h2>
                <p className="flex flex-wrap items-center gap-x-2 text-regular text-fg-tertiary">
                  {[c.role, c.team].filter(Boolean).join(' · ') || (p.type === 'ai' ? 'AI employee' : 'No title yet')}
                  <AccessTag p={p} />
                </p>
              </div>
            </div>
            <DetailSection title="Profile" id="person-profile">
              <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-mini">
                <dt className="text-fg-tertiary">Email</dt>
                <dd className="min-w-0 truncate text-fg-secondary">
                  {c.email ?? <span className="text-fg-quaternary">None</span>}
                </dd>
                <dt className="text-fg-tertiary">Handles</dt>
                <dd className="flex min-w-0 flex-wrap gap-1">
                  {handles.length ? (
                    handles.map((h) => (
                      <Tag key={`${h.system}:${h.id}`} className="text-fg-secondary">
                        {systemLabel(h.system)} <span className="font-mono">{h.id}</span>
                      </Tag>
                    ))
                  ) : (
                    <span className="text-fg-quaternary">None: employees can't match them in Slack, GitLab or Linear yet</span>
                  )}
                </dd>
                <dt className="text-fg-tertiary">Role</dt>
                <dd className="min-w-0 text-fg-secondary">
                  {c.role ?? <span className="text-fg-quaternary">None</span>}
                  {learnedField('role') && <Provenance fact={learnedField('role')!} />}
                </dd>
                <dt className="text-fg-tertiary">Team</dt>
                <dd className="min-w-0 text-fg-secondary">
                  {c.team ?? <span className="text-fg-quaternary">None</span>}
                  {learnedField('team') && <Provenance fact={learnedField('team')!} />}
                </dd>
                <dt className="text-fg-tertiary">Manager</dt>
                <dd className="text-fg-secondary">
                  {p.manager ? (
                    <Link
                      to={`/contacts/${p.manager.contactId}`}
                      className="inline-flex items-center gap-1.5 hover:text-foreground"
                    >
                      <PersonAvatar name={p.manager.name} className="size-4" />
                      {p.manager.name}
                    </Link>
                  ) : (
                    <span className="text-fg-quaternary">None</span>
                  )}
                  {learnedField('manager') && <Provenance fact={learnedField('manager')!} />}
                </dd>
                {p.reports.length > 0 && (
                  <>
                    <dt className="text-fg-tertiary">Reports</dt>
                    <dd className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-fg-secondary">
                      {p.reports.map((r) => (
                        <Link
                          key={r.contactId}
                          to={`/contacts/${r.contactId}`}
                          className="inline-flex items-center gap-1.5 hover:text-foreground"
                        >
                          <PersonAvatar name={r.name} className="size-4" />
                          {r.name}
                        </Link>
                      ))}
                    </dd>
                  </>
                )}
                {c.permissions && (
                  <>
                    <dt className="text-fg-tertiary">May ask for</dt>
                    <dd className="text-fg-secondary">{c.permissions}</dd>
                  </>
                )}
              </dl>
            </DetailSection>
            <Suggestions detail={p} onChanged={(next) => d.setData(next)} />
            <Bio detail={p} />
            <DetailSection title={`Projects${p.projects.length ? ` · ${p.projects.length}` : ''}`} id="person-projects">
              {p.projects.length === 0 ? (
                <p className="text-fg-tertiary">Not on any project.</p>
              ) : (
                <ul className="flex flex-col">
                  {p.projects.map((pr) => (
                    <li key={pr.id}>
                      <Link
                        to={`/projects/${pr.id}`}
                        className="-mx-2 flex min-h-9 items-center gap-2 rounded-md px-2 hover:bg-secondary"
                      >
                        <FolderKanban className="size-3.5 text-fg-tertiary" />
                        <span className="min-w-0 truncate text-fg-secondary">{pr.name}</span>
                        <span className="ml-auto text-micro text-fg-tertiary">{pr.roles.join(', ')}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </DetailSection>
            <DetailSection title="Memories about them" id="person-memories">
              {p.memoriesAbout === null ? (
                <p className="text-fg-tertiary">
                  Only {first} and admins see what the employees remember about {first}.
                </p>
              ) : (
                <p className="flex flex-wrap items-center gap-2 text-fg-secondary">
                  <Brain className="size-3.5 text-fg-tertiary" />
                  {p.memoriesAbout
                    ? `The employees remember ${pluralize(p.memoriesAbout, 'thing')} about ${first}.`
                    : `Nothing remembered about ${first} yet.`}
                  {p.memoriesAbout > 0 && (
                    <Link to={`/memory?about=${p.contact.id}`} className="text-[#828fff] hover:underline">
                      See them
                    </Link>
                  )}
                </p>
              )}
            </DetailSection>
            {p.type === 'person' && <RecentRequests id={p.contact.id} />}
            <Tokens detail={p} onChanged={d.reload} />
          </div>
        }
        side={
          <aside className="h-full overflow-auto bg-level-1" data-testid="person-side">
            <AccessPanel detail={p} onChanged={(next) => d.setData(next)} />
            <SidePanel title="Details">
              <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-y-1 text-micro">
                <dt className="text-fg-tertiary">Kind</dt>
                <dd className="text-fg-secondary">{PERSON_TYPES.find((t) => t.value === p.type)?.label}</dd>
                <dt className="text-fg-tertiary">Added</dt>
                <dd className="text-fg-secondary">{formatDateTime(p.contact.createdAt)}</dd>
                <dt className="text-fg-tertiary">Id</dt>
                <dd className="truncate font-mono text-fg-quaternary">{p.contact.id}</dd>
              </dl>
            </SidePanel>
          </aside>
        }
      />
      <EditPersonDialog open={editOpen} onOpenChange={setEditOpen} detail={p} onSaved={(next) => d.setData(next)} />
    </Page>
  )
}
