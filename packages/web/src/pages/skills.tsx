import { ApiRequestError, type SkillDetail, type SkillListItem, type SkillScope, type SkillVersion, skillMarkdown } from '@mp/api'
import {
  BookOpen,
  ChevronRight,
  Copy,
  Download,
  FileUp,
  FolderKanban,
  History,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { ConfirmDialog, DetailSection, Field, SidePanel, Tag, errorText } from '@/components/knowledge-ui.tsx'
import { Markdown } from '@/components/markdown.tsx'
import { NewSkillDialog, ScopePicker } from '@/components/new-skill-dialog.tsx'
import { Page } from '@/components/page.tsx'
import { EmployeeAvatar } from '@/components/people.tsx'
import { SplitView } from '@/components/split-view.tsx'
import { StepsEditor } from '@/components/steps-editor.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useApi, useLiveReload, useLoad } from '@/lib/api.tsx'
import { Can, useAuth } from '@/lib/auth.tsx'
import { agoPhrase, formatDateTime, pluralize, timeAgo } from '@/lib/format.ts'
import { downloadText, fieldList } from '@/lib/knowledge.ts'
import { useNames } from '@/lib/names.ts'
import { cn } from '@/lib/utils.ts'

const LIVE = ['records:skill'] as const

function UsedBy({ item, max = 3 }: { item: SkillListItem; max?: number }) {
  if (!item.usedBy.length) return <span className="text-fg-quaternary">Not used lately</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1" data-testid="skill-used-by">
          <span className="flex -space-x-1">
            {item.usedBy.slice(0, max).map((u) => (
              <EmployeeAvatar key={u.employee.id} name={u.employee.name} className="size-4 ring-1 ring-background" />
            ))}
          </span>
          <span className="text-fg-tertiary">{timeAgo(item.usedBy[0]!.lastAt)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Used in the last 30 days by {item.usedBy.map((u) => `${u.employee.name} (${pluralize(u.count, 'time')})`).join(', ')}
      </TooltipContent>
    </Tooltip>
  )
}

function SkillRow({ item }: { item: SkillListItem }) {
  const k = item.skill
  const off = k.data.enabled === false
  return (
    <Link
      to={`/skills/${k.id}`}
      data-testid="skill-row"
      className={cn(
        'group grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 px-4 py-2 transition-quick hover:bg-secondary sm:px-6 lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,16rem)_7rem_4rem] lg:items-center',
        off && 'opacity-60',
      )}
    >
      <Sparkles className="mt-0.5 size-3.5 text-fg-tertiary lg:mt-0" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-medium text-fg-secondary group-hover:text-foreground">{k.data.name}</span>
          {off && <Tag>off</Tag>}
          {item.overrides && (
            <Tag title={`Replaces the company skill ${item.overrides.name} in this project's work`}>replaces company</Tag>
          )}
        </span>
        <span className="truncate text-mini text-fg-tertiary">{k.data.description}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 text-micro text-fg-quaternary lg:hidden">
          {k.data.whenToUse && <span className="truncate">When: {k.data.whenToUse}</span>}
          <UsedBy item={item} />
          <span>updated {agoPhrase(k.updatedAt)}</span>
        </span>
      </span>
      <span className="hidden truncate text-micro text-fg-tertiary lg:block" title={k.data.whenToUse}>
        {k.data.whenToUse ?? <span className="text-fg-quaternary">—</span>}
      </span>
      <span className="hidden text-micro lg:block">
        <UsedBy item={item} />
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <time className="hidden text-right text-micro text-fg-quaternary tabular-nums lg:block" dateTime={k.updatedAt}>
            {timeAgo(k.updatedAt)}
          </time>
        </TooltipTrigger>
        <TooltipContent>
          Updated {formatDateTime(k.updatedAt)}
          {item.updatedBy ? ` by ${item.updatedBy.name}` : ''}
        </TooltipContent>
      </Tooltip>
    </Link>
  )
}

/** `/skills`: company skills, then each project's, with who used them lately. */
export function SkillsPage() {
  const [text, setText] = useState('')
  const [newOpen, setNewOpen] = useState<false | 'new' | 'import'>(false)
  const list = useLoad((a) => a.skills(), [])
  useLiveReload([...LIVE], list.reload)
  const q = text.trim().toLowerCase()
  const shown = (list.data ?? []).filter(
    (i) =>
      !q ||
      `${i.skill.data.name} ${i.skill.data.description} ${i.skill.data.whenToUse ?? ''} ${i.project?.name ?? ''}`
        .toLowerCase()
        .includes(q),
  )
  const groups = useMemo(() => {
    const out = new Map<string, { key: string; label: string; projectId?: string; rows: SkillListItem[] }>()
    for (const i of shown) {
      const key = i.project?.id ?? 'company'
      const g = out.get(key) ?? {
        key,
        label: i.project ? i.project.name : 'Company-wide',
        ...(i.project ? { projectId: i.project.id } : {}),
        rows: [],
      }
      g.rows.push(i)
      out.set(key, g)
    }
    return [...out.values()]
  }, [shown])
  const buttons = (variant: 'outline' | 'default') => (
    <Can>
      <Button size="sm" variant="ghost" onClick={() => setNewOpen('import')} className="hidden sm:inline-flex">
        <FileUp /> Import
      </Button>
      <Button size="sm" variant={variant} onClick={() => setNewOpen('new')}>
        <Plus /> New skill
      </Button>
    </Can>
  )
  return (
    <Page
      title="Skills"
      icon={<Sparkles />}
      actions={buttons('outline')}
      filters={
        <>
          <div className="relative w-full min-w-0 sm:w-64">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-quaternary" />
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Search skills"
              aria-label="Search skills"
              className="h-7 pl-7 text-mini"
            />
          </div>
          <span className="ml-auto text-micro text-fg-quaternary tabular-nums">
            {list.data ? pluralize(shown.length, 'skill') : ''}
          </span>
        </>
      }
    >
      <p className="border-b px-4 py-3 text-mini text-fg-tertiary sm:px-6" data-testid="skills-explainer">
        A skill is reusable know-how for one kind of work, like cutting a release or writing a migration. Company skills apply
        everywhere; a project's skills only in work on that project. Employees see each skill's name and description, and load the
        full instructions when a task calls for them.
      </p>
      {list.error && !list.data ? (
        <ErrorState error={list.error} retry={list.reload} />
      ) : !list.data ? (
        <LoadingRows />
      ) : shown.length === 0 ? (
        <EmptyState
          text={q ? 'No skill matches.' : 'No skills yet. Write down how a kind of work is done well, and employees follow it.'}
          action={q ? undefined : buttons('default')}
        />
      ) : (
        <div className="pb-10">
          {groups.map((g) => (
            <section key={g.key} className="border-b last:border-b-0" data-testid="skill-group">
              <h2 className="sticky top-0 z-10 flex h-9 items-center gap-2 bg-level-1 px-4 text-micro font-medium text-fg-secondary sm:px-6">
                {g.projectId ? (
                  <FolderKanban className="size-3.5 text-fg-tertiary" />
                ) : (
                  <Sparkles className="size-3.5 text-fg-tertiary" />
                )}
                {g.projectId ? (
                  <Link to={`/projects/${g.projectId}`} className="min-w-0 truncate hover:text-foreground">
                    {g.label}
                  </Link>
                ) : (
                  <span>{g.label}</span>
                )}
                <span className="text-fg-quaternary tabular-nums">{g.rows.length}</span>
              </h2>
              {g.rows.map((i) => (
                <SkillRow key={i.skill.id} item={i} />
              ))}
            </section>
          ))}
        </div>
      )}
      <NewSkillDialog open={!!newOpen} importing={newOpen === 'import'} onOpenChange={(o) => setNewOpen(o ? 'new' : false)} />
    </Page>
  )
}

// ─── Skill page ─────────────────────────────────────────────────────────────

function EditSkillDialog({
  open,
  onOpenChange,
  detail,
  onSaved,
}: {
  open: boolean
  onOpenChange(o: boolean): void
  detail: SkillDetail
  onSaved(d: SkillDetail): void
}) {
  const api = useApi()
  const k = detail.skill
  const [name, setName] = useState(k.data.name)
  const [description, setDescription] = useState(k.data.description)
  const [whenToUse, setWhenToUse] = useState(k.data.whenToUse ?? '')
  const [scope, setScope] = useState<SkillScope>(k.data.scope)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (!name.trim() || !description.trim()) return setError('A name and what it helps with are both needed.')
    if (scope.type === 'project' && !scope.projectId) return setError('Pick the project.')
    setBusy(true)
    try {
      onSaved(
        await api.updateSkill(k.id, {
          name: name.trim(),
          description: description.trim(),
          whenToUse: whenToUse.trim(),
          scope,
          version: k.version,
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
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setName(k.data.name)
          setDescription(k.data.description)
          setWhenToUse(k.data.whenToUse ?? '')
          setScope(k.data.scope)
          setError(null)
        }
        onOpenChange(o)
      }}
    >
      <DialogContent className="gap-4 sm:max-w-[560px]" data-testid="edit-skill-dialog">
        <DialogHeader>
          <DialogTitle className="text-title1">Edit skill</DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">
            Its name, what it's for, when to use it and where it applies. The instructions are edited on the page.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-3">
          <Field id="es-name" label="Name">
            <Input id="es-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field id="es-description" label="What it helps with">
            <Input id="es-description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field id="es-when" label="When to use it" hint="Optional">
            <Input id="es-when" value={whenToUse} onChange={(e) => setWhenToUse(e.target.value)} />
          </Field>
          <Field label="Where it applies">
            <ScopePicker value={scope} onChange={setScope} id="es-project" />
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

function VersionsDialog({
  open,
  onOpenChange,
  detail,
  onRestored,
}: {
  open: boolean
  onOpenChange(o: boolean): void
  detail: SkillDetail
  onRestored(d: SkillDetail): void
}) {
  const api = useApi()
  const { can } = useAuth()
  const [picked, setPicked] = useState<number | null>(null)
  const list = detail.versions
  const shown: SkillVersion | undefined = list.find((v) => v.version === picked) ?? list[0]
  const k = detail.skill
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] gap-3 overflow-y-auto sm:max-w-[820px]" data-testid="skill-versions">
        <DialogHeader>
          <DialogTitle className="text-title1">Versions of {k.data.name}</DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">
            Every save is a version. Pick one to read it; restoring saves its text as a new version.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
          <div className="flex flex-col">
            {list.map((v) => (
              <button
                key={v.version}
                type="button"
                onClick={() => setPicked(v.version)}
                className={cn(
                  'flex flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-secondary',
                  shown?.version === v.version && 'bg-secondary',
                )}
              >
                <span className="text-mini text-fg-secondary">
                  v{v.version} · {v.op === 'create' ? 'Created' : `Changed ${fieldList(v.changed) || 'nothing'}`}
                </span>
                <span className="text-micro text-fg-quaternary">
                  {v.actor.name} · {formatDateTime(v.at)}
                </span>
              </button>
            ))}
          </div>
          <div className="min-w-0 rounded-md border bg-level-1 px-4 py-3">
            {shown?.data ? (
              <>
                <p className="mb-2 text-micro text-fg-tertiary">
                  <span className="font-medium text-fg-secondary">{shown.data.name}</span> · {shown.data.description}
                </p>
                <Markdown text={shown.data.body} />
              </>
            ) : (
              <p className="text-fg-tertiary">Nothing in this version.</p>
            )}
          </div>
        </div>
        {shown?.data && shown.version !== k.version && can('member') && (
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  onRestored(await api.restoreSkill(k.id, shown.version))
                  toast(`Restored v${shown.version}`, { description: 'Saved as a new version.' })
                  onOpenChange(false)
                } catch (e) {
                  toast(errorText(e))
                }
              }}
            >
              Restore this version
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

function InstructionsSection({ detail, onSaved }: { detail: SkillDetail; onSaved(d: SkillDetail): void }) {
  const api = useApi()
  const k = detail.skill
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const names = useNames([k.data.body])
  const save = async () => {
    if (busy) return
    if (!draft.trim()) return setError('A skill needs instructions.')
    setBusy(true)
    setError(null)
    try {
      const next = await api.updateSkill(k.id, { body: draft, version: k.version })
      onSaved(next)
      setEditing(false)
      toast(`Saved as version ${next.skill.version}`, { description: 'Employees load the new instructions from now on.' })
    } catch (e) {
      setError(
        e instanceof ApiRequestError && e.status === 409
          ? 'Someone else changed it meanwhile: copy your text, reload and try again.'
          : errorText(e),
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <DetailSection
      title="Instructions"
      id="skill-instructions"
      actions={
        <>
          <Button variant="ghost" size="xs" onClick={() => setHistoryOpen(true)}>
            <History /> Versions <span className="text-fg-quaternary">v{k.version}</span>
          </Button>
          <Can>
            {!editing && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setDraft(k.data.body)
                  setEditing(true)
                }}
              >
                <Pencil /> Edit
              </Button>
            )}
          </Can>
        </>
      }
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <StepsEditor
            value={draft}
            onChange={setDraft}
            onSubmit={save}
            onCancel={() => setEditing(false)}
            resolve={(_k, id) => names.get(id)}
            minHeight="min-h-80"
            label="Instructions (markdown)"
          />
          {error && (
            <p role="alert" className="text-micro text-[var(--red)]">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2 text-micro text-fg-tertiary">
            <span className="mr-auto hidden sm:inline">Saving makes a new version; older ones stay under Versions.</span>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save instructions'}
            </Button>
          </div>
        </div>
      ) : (
        <Markdown text={k.data.body} resolve={(_k, id) => names.get(id)} className="text-regular" />
      )}
      <VersionsDialog open={historyOpen} onOpenChange={setHistoryOpen} detail={detail} onRestored={onSaved} />
    </DetailSection>
  )
}

/** `/skills/:id`: a skill's instructions, versions, where it applies, whether it's on, and who used it. */
export function SkillPage() {
  const { id = '' } = useParams()
  const api = useApi()
  const navigate = useNavigate()
  const d = useLoad((a) => a.skill(id), [id])
  useLiveReload([...LIVE], d.reload)
  const [editOpen, setEditOpen] = useState(false)
  const [dupOpen, setDupOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const back = (
    <span className="flex min-w-0 items-center gap-1.5">
      <Link to="/skills" className="shrink-0 text-fg-tertiary hover:text-foreground">
        Skills
      </Link>
      <ChevronRight className="size-3.5 shrink-0 text-fg-quaternary" />
      <span className="truncate">{d.data?.skill.data.name ?? ''}</span>
    </span>
  )
  if (d.error && !d.data)
    return (
      <Page title={back} icon={<Sparkles />}>
        <ErrorState error={d.error} retry={d.reload} />
      </Page>
    )
  if (!d.data)
    return (
      <Page title={back} icon={<Sparkles />}>
        <LoadingRows />
      </Page>
    )
  const detail = d.data
  const k = detail.skill
  const on = k.data.enabled !== false
  const set = (next: SkillDetail) => d.setData(next)
  const md = skillMarkdown({
    name: k.data.name,
    description: k.data.description,
    ...(k.data.whenToUse ? { whenToUse: k.data.whenToUse } : {}),
    body: k.data.body,
  })
  const toggle = async (next: boolean) => {
    try {
      set(await api.updateSkill(k.id, { enabled: next }))
      toast(next ? 'Switched on' : 'Switched off', {
        description: next ? 'Employees see it again.' : "Employees don't see or load it until it's switched back on.",
      })
    } catch (e) {
      toast(errorText(e))
    }
  }
  return (
    <Page
      title={back}
      icon={<Sparkles />}
      className="overflow-hidden"
      actions={
        <>
          <Can>
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil /> Edit
            </Button>
          </Can>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => downloadText('SKILL.md', md)}>
                <Download /> Download SKILL.md
              </DropdownMenuItem>
              <Can>
                <DropdownMenuItem onSelect={() => setDupOpen(true)}>
                  <Copy /> Duplicate
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setDeleteOpen(true)} className="text-[var(--red)]">
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </Can>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <SplitView
        sideSize={320}
        sideMin={280}
        sideMax={420}
        main={
          <div className="mx-auto max-w-[720px] px-4 pt-8 pb-16 sm:px-6">
            {!on && (
              <p className="mb-4 rounded-md border px-3 py-2 text-mini text-fg-tertiary">
                Switched off: employees don't see or load it.
              </p>
            )}
            <h2 className="mb-1 font-mono text-title3 font-semibold break-words">{k.data.name}</h2>
            <p className="mb-2 text-regular text-fg-secondary">{k.data.description}</p>
            {k.data.whenToUse && (
              <p className="mb-3 text-mini text-fg-tertiary">
                <span className="font-medium text-fg-secondary">When to use it:</span> {k.data.whenToUse}
              </p>
            )}
            <div className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-1 text-mini text-fg-tertiary">
              <span>{detail.project ? `Project skill of ${detail.project.name}` : 'Company-wide'}</span>
              <span>
                Updated {agoPhrase(k.updatedAt)}
                {detail.updatedBy ? ` by ${detail.updatedBy.name}` : ''}
              </span>
            </div>
            <InstructionsSection detail={detail} onSaved={set} />
          </div>
        }
        side={
          <aside className="h-full overflow-auto bg-level-1" data-testid="skill-side">
            <SidePanel title="Status" testId="skill-status">
              <div className="flex items-center gap-2 text-mini text-fg-secondary">
                <Can fallback={<span>{on ? 'On: employees can load it' : 'Off: hidden from employees'}</span>}>
                  <Switch id="skill-on" checked={on} onCheckedChange={toggle} />
                  <label htmlFor="skill-on">{on ? 'On: employees can load it' : 'Off: hidden from employees'}</label>
                </Can>
              </div>
            </SidePanel>
            <SidePanel title="Where it applies">
              {detail.project ? (
                <Link
                  to={`/projects/${detail.project.id}`}
                  className="flex items-center gap-1.5 text-mini text-fg-secondary hover:text-foreground"
                >
                  <FolderKanban className="size-3.5 text-fg-tertiary" />
                  {detail.project.name}
                </Link>
              ) : (
                <p className="text-mini text-fg-secondary">Every employee's work</p>
              )}
              {detail.overrides && (
                <p className="mt-1 text-micro text-fg-tertiary">
                  Replaces the company skill{' '}
                  <Link to={`/skills/${detail.overrides.id}`} className="text-[#828fff] hover:underline">
                    {detail.overrides.name}
                  </Link>{' '}
                  in this project's work.
                </p>
              )}
            </SidePanel>
            <SidePanel title="Used in the last 30 days" testId="skill-usage">
              {detail.usedBy.length === 0 ? (
                <p className="text-micro text-fg-tertiary">No employee loaded it lately.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {detail.usedBy.map((u) => (
                    <li key={u.employee.id} className="flex min-w-0 items-center gap-2 text-mini">
                      <EmployeeAvatar name={u.employee.name} className="size-4" />
                      <Link
                        to={`/employees/${u.employee.id}`}
                        className="min-w-0 truncate text-fg-secondary hover:text-foreground"
                      >
                        {u.employee.name}
                      </Link>
                      <span className="ml-auto shrink-0 text-micro text-fg-tertiary">
                        {pluralize(u.count, 'time')} ·{' '}
                        {u.lastSessionId ? (
                          <Link to={`/sessions/${u.lastSessionId}`} className="hover:text-foreground">
                            {timeAgo(u.lastAt)}
                          </Link>
                        ) : (
                          timeAgo(u.lastAt)
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </SidePanel>
            <SidePanel title="Procedures that use it">
              {detail.procedures.length === 0 ? (
                <p className="text-micro text-fg-tertiary">None names it.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {detail.procedures.map((p) => (
                    <li key={p.id}>
                      <Link
                        to={`/procedures/${p.id}`}
                        className="flex items-center gap-1.5 text-mini text-fg-secondary hover:text-foreground"
                      >
                        <BookOpen className="size-3.5 text-fg-tertiary" />
                        {p.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </SidePanel>
            <SidePanel title="Details">
              <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-y-1 text-micro">
                <dt className="text-fg-tertiary">Version</dt>
                <dd className="text-fg-secondary">v{k.version}</dd>
                <dt className="text-fg-tertiary">Created</dt>
                <dd className="text-fg-secondary">{formatDateTime(k.createdAt)}</dd>
                <dt className="text-fg-tertiary">Id</dt>
                <dd className="truncate font-mono text-fg-quaternary">{k.id}</dd>
              </dl>
            </SidePanel>
          </aside>
        }
      />
      <EditSkillDialog open={editOpen} onOpenChange={setEditOpen} detail={detail} onSaved={set} />
      <NewSkillDialog
        open={dupOpen}
        onOpenChange={setDupOpen}
        initial={{
          name: k.data.name,
          description: k.data.description,
          ...(k.data.whenToUse ? { whenToUse: k.data.whenToUse } : {}),
          body: k.data.body,
          scope: k.data.scope,
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${k.data.name}?`}
        description="Employees can't load it any more, and its versions go with it. Switch it off instead to keep it for later."
        confirm="Delete skill"
        onConfirm={async () => {
          try {
            await api.deleteSkill(k.id)
            toast('Deleted')
            navigate('/skills')
          } catch (e) {
            toast(errorText(e))
          }
        }}
      />
    </Page>
  )
}
