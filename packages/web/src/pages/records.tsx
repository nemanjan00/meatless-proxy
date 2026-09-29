import type { ApiKindSchema, ApiRecord, ApiRevision } from '@mp/api'
import {
  BookOpen,
  Brain,
  ChevronRight,
  FileText,
  FolderKanban,
  History,
  Plus,
  Search,
  Sparkles,
  Undo2,
  Users,
} from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { DocumentEditor } from '@/components/doc-editor.tsx'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { LinksGraph } from '@/components/links-graph.tsx'
import { Page, SectionTitle } from '@/components/page.tsx'
import { SplitView } from '@/components/split-view.tsx'
import { NewProjectDialog } from '@/components/new-project-dialog.tsx'
import { PersonAvatar } from '@/components/people.tsx'
import { ProjectPeopleSection } from '@/components/project-people.tsx'
import { LocalRepositorySection, hasLocalRepository } from '@/components/local-repository.tsx'
import { RecordPropertiesForm } from '@/components/record-form.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import { useApi, useLiveReload, useLoad } from '@/lib/api.tsx'
import { Can } from '@/lib/auth.tsx'
import { hrefFor, linkRole, plainDoc } from '@/lib/doclinks.ts'
import { useNames } from '@/lib/names.ts'
import { formatDateTime, timeAgo } from '@/lib/format.ts'
import { DOCUMENT_FIELDS, changedFields, formFields, fromFormValues, recordTitle } from '@/lib/schema-form.ts'

const ICONS: Record<string, ReactNode> = {
  project: <FolderKanban />,
  contact: <Users />,
  procedure: <BookOpen />,
  skill: <Sparkles />,
  memory: <Brain />,
  doc: <FileText />,
}

/** The line under a record's title in lists. `resolve` names `[[kind:id]]` links in text. */
export function recordSubtitle(
  kind: string,
  data: Record<string, unknown>,
  resolve?: (kind: string, id: string) => string | undefined,
): string {
  const pick = (...keys: string[]) => keys.map((k) => data[k]).find((v) => typeof v === 'string' && v) as string | undefined
  switch (kind) {
    case 'contact':
      return [data.role, data.team].filter(Boolean).join(' · ')
    case 'procedure':
      return pick('applies') ?? ''
    case 'memory':
      return plainDoc(pick('content') ?? '', resolve)
    case 'doc':
      return pick('path') ?? ''
    default:
      return plainDoc(pick('description', 'applies', 'role') ?? '', resolve)
  }
}

/** A skill's scope: `company`, or `project` (as a string or `{ type }`). */
function scopeType(scope: unknown): string | undefined {
  if (typeof scope === 'string') return scope === 'company' ? 'company' : 'project'
  if (scope && typeof scope === 'object' && typeof (scope as { type?: unknown }).type === 'string')
    return (scope as { type: string }).type
  return undefined
}

function badgeFor(kind: string, data: Record<string, unknown>): string | undefined {
  switch (kind) {
    case 'memory':
      return typeof data.kind === 'string' ? data.kind : undefined
    case 'skill':
      return scopeType(data.scope)
    case 'contact':
      return data.ai === true || data.kind === 'ai' ? 'AI' : data.status === 'left' ? 'left' : undefined
    default:
      return typeof data.status === 'string' ? data.status : undefined
  }
}

function useSchema(kind: string) {
  const kinds = useLoad((api) => api.kinds(), [])
  return { schema: kinds.data?.find((k) => k.kind === kind), loading: !kinds.data }
}

function NewRecord({
  schema,
  open,
  onOpenChange,
  onCreated,
}: {
  schema: ApiKindSchema
  open: boolean
  onOpenChange(o: boolean): void
  onCreated(r: ApiRecord): void
}) {
  const api = useApi()
  const fields = formFields(schema).filter((f) => f.required && f.input !== 'switch')
  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const create = async () => {
    const parsed = fromFormValues(fields, values)
    setErrors(parsed.errors)
    if (Object.keys(parsed.errors).length) return
    const r = await api.createRecord(schema.kind, parsed.data)
    toast(`${schema.kind} created`)
    onOpenChange(false)
    setValues({})
    onCreated(r)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-title1">New {schema.kind}</DialogTitle>
          <DialogDescription>Required fields now; everything else in the properties panel.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {fields.map((f) => (
            <div key={f.name} className="flex flex-col gap-1">
              <label htmlFor={`new-${f.name}`} className="text-micro text-fg-tertiary">
                {f.label}
              </label>
              {f.options ? (
                <select
                  id={`new-${f.name}`}
                  value={values[f.name] ?? ''}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                  className="h-8 rounded-md border bg-transparent px-2 text-small"
                >
                  <option value="">—</option>
                  {f.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <Input
                  id={`new-${f.name}`}
                  value={values[f.name] ?? ''}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                />
              )}
              {errors[f.name] && <span className="text-micro text-[var(--red)]">{errors[f.name]}</span>}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={create}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A knowledge list (projects, contacts, procedures, skills, memory): dense rows, search, create. */
export function RecordListPage({ kind, title, basePath }: { kind: string; title: string; basePath: string }) {
  const [text, setText] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  const navigate = useNavigate()
  const { schema } = useSchema(kind)
  const list = useLoad(
    (api) =>
      api.listRecords(kind, { text: text || undefined, orderBy: schema?.titleField ?? 'updatedAt', dir: 'asc', limit: 200 }),
    [kind, text, schema?.titleField],
  )
  useLiveReload([`records:${kind}`], list.reload)
  const texts = (list.data?.items ?? []).map((r) => String(r.data.content ?? r.data.description ?? ''))
  const names = useNames(texts)
  return (
    <Page
      title={title}
      icon={ICONS[kind]}
      actions={
        schema && (
          <Can>
            <Button size="sm" variant="outline" onClick={() => setNewOpen(true)}>
              <Plus /> New {kind}
            </Button>
          </Can>
        )
      }
      filters={
        <>
          <div className="relative w-64">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-quaternary" />
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`Search ${title.toLowerCase()}`}
              className="h-7 pl-7 text-mini"
            />
          </div>
          <span className="ml-auto text-micro text-fg-tertiary">{list.data?.total ?? 0}</span>
        </>
      }
    >
      {list.error && !list.data ? (
        <ErrorState error={list.error} retry={list.reload} />
      ) : !list.data ? (
        <LoadingRows />
      ) : list.data.items.length === 0 ? (
        <EmptyState
          text={text ? `No ${title.toLowerCase()} match “${text}”.` : `No ${title.toLowerCase()} yet.`}
          action={
            schema && (
              <Can>
                <Button size="sm" onClick={() => setNewOpen(true)}>
                  New {kind}
                </Button>
              </Can>
            )
          }
        />
      ) : (
        <div className="py-1">
          {list.data.items.map((r) => {
            const t = recordTitle(schema, r.data, r.id)
            const badge = badgeFor(kind, r.data)
            return (
              <Link
                key={r.id}
                to={`${basePath}/${r.id}`}
                className="group flex h-9 items-center gap-3 px-6 hover:bg-secondary"
                data-testid="record-row"
              >
                {kind === 'contact' ? (
                  <PersonAvatar name={t} className="size-5" />
                ) : (
                  <span className="text-fg-tertiary [&_svg]:size-4">{ICONS[kind]}</span>
                )}
                <span className="shrink-0 truncate text-fg-secondary group-hover:text-foreground">{t}</span>
                <span className="min-w-0 flex-1 truncate text-fg-tertiary">
                  {recordSubtitle(kind, r.data, (_k, rid) => names.get(rid))}
                </span>
                {badge && <span className="shrink-0 rounded-sm border px-1 text-tiny text-fg-tertiary">{badge}</span>}
                <span className="w-8 shrink-0 text-right text-micro text-fg-quaternary">{timeAgo(r.updatedAt)}</span>
              </Link>
            )
          })}
        </div>
      )}
      {kind === 'project' ? (
        // Projects get their own dialog: repositories, docs and an owner, linked in one step.
        <NewProjectDialog open={newOpen} onOpenChange={setNewOpen} onCreated={(r) => navigate(`${basePath}/${r.project.id}`)} />
      ) : (
        schema && (
          <NewRecord
            schema={schema}
            open={newOpen}
            onOpenChange={setNewOpen}
            onCreated={(r) => navigate(`${basePath}/${r.id}`)}
          />
        )
      )}
    </Page>
  )
}

function Revisions({ revisions, onRevert }: { revisions: ApiRevision[]; onRevert(r: ApiRevision): void }) {
  const list = [...revisions].reverse()
  const actors = useNames(
    [],
    revisions.filter((r) => r.actor.type !== 'system').map((r) => ({ kind: r.actor.type, id: r.actor.id })),
  )
  const who = (a: ApiRevision['actor']) =>
    a.type === 'system' ? `the harness (${a.id})` : (actors.get(a.id) ?? `${a.type} ${a.id}`)
  return (
    <div className="flex flex-col" data-testid="revisions">
      {list.map((r, i) => {
        const prev = list[i + 1]
        const changed = prev?.data && r.data ? changedFields(prev.data, r.data) : []
        return (
          <div key={r.version} className="flex min-h-9 items-center gap-3 border-b py-1.5 last:border-0">
            <History className="size-3.5 shrink-0 text-fg-tertiary" />
            <span className="w-8 shrink-0 font-mono text-micro text-fg-tertiary">v{r.version}</span>
            <span className="min-w-0 flex-1 truncate text-fg-secondary">
              {r.op === 'create' ? 'Created' : r.op === 'delete' ? 'Deleted' : `Changed ${changed.join(', ') || 'nothing'}`}
              <span className="text-fg-quaternary">
                {' '}
                by{' '}
                {r.actor.type === 'system' ? (
                  who(r.actor)
                ) : (
                  <Link to={hrefFor(r.actor.type, r.actor.id)} className="hover:text-fg-secondary">
                    {who(r.actor)}
                  </Link>
                )}
              </span>
            </span>
            <span className="shrink-0 text-micro text-fg-quaternary">{formatDateTime(r.at)}</span>
            {i > 0 && r.data && (
              <Button variant="ghost" size="xs" onClick={() => onRevert(r)}>
                <Undo2 /> Revert
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** A record: its document in the main column, properties (from the schema) on the right, links, backlinks and edit history. */
export function RecordDetailPage(props: { kind?: string; title?: string; basePath?: string }) {
  const params = useParams()
  const kind = props.kind ?? params.kind ?? ''
  const id = params.id ?? ''
  const api = useApi()
  const { schema } = useSchema(kind)
  const rec = useLoad((a) => a.getRecord(kind, id), [kind, id])
  const links = useLoad((a) => a.recordLinks(kind, id), [kind, id])
  const backlinks = useLoad((a) => a.recordBacklinks(kind, id), [kind, id])
  const revisions = useLoad((a) => a.recordRevisions(kind, id), [kind, id, rec.data?.version])
  // Docs owned by this record (a project's overview, runbooks, …).
  const docs = useLoad(
    (a) =>
      kind === 'doc'
        ? Promise.resolve(null)
        : a
            .listRecords<{ title: string; path?: string; body: string }>('doc', {
              where: { 'owner.id': id },
              orderBy: 'path',
              dir: 'asc',
            })
            .catch(() => null),
    [kind, id],
  )
  useLiveReload([`records:${kind}`], rec.reload)
  // Names for `[[kind:id]]` links: linked records first, then any other record the texts mention.
  const mentioned = useNames([
    ...Object.values(rec.data?.data ?? {}).filter((v): v is string => typeof v === 'string'),
    ...(docs.data?.items ?? []).map((doc) => doc.data.body),
  ])
  const names = useMemo(() => {
    const m = new Map<string, string>(mentioned)
    for (const l of links.data ?? []) m.set(l.record.id, recordTitle(undefined, l.record.data, l.record.id))
    return m
  }, [links.data, mentioned])

  if (rec.error && !rec.data)
    return (
      <Page title={props.title ?? kind}>
        <ErrorState error={rec.error} retry={rec.reload} />
      </Page>
    )
  if (!rec.data || !schema)
    return (
      <Page title={props.title ?? kind}>
        <LoadingRows />
      </Page>
    )
  const r = rec.data
  const title = recordTitle(schema, r.data, r.id)
  const docField = [...schema.core, ...(schema.extensions ?? [])].find((f) => DOCUMENT_FIELDS.has(f.name))
  const saveDoc = async (text: string) => {
    if (!docField) return
    const next = await api.updateRecord(kind, id, { [docField.name]: text }, r.version)
    rec.setData(next)
    toast('Saved')
  }
  const revert = async (rev: ApiRevision) => {
    const patch: Record<string, unknown> = { ...(rev.data ?? {}) }
    for (const k of Object.keys(r.data)) if (!(k in patch)) patch[k] = null
    const next = await api.updateRecord(kind, id, patch, r.version)
    rec.setData(next)
    toast(`Reverted to v${rev.version}`)
  }
  const owner = kind === 'doc' ? (r.data.owner as { kind?: string; id?: string } | undefined) : undefined
  const back = props.basePath ?? (owner?.kind && owner.id ? hrefFor(owner.kind, owner.id) : '/')
  const backLabel = props.title ?? (owner?.kind ? `${owner.kind.charAt(0).toUpperCase()}${owner.kind.slice(1)}` : kind)
  return (
    <Page
      title={
        <span className="flex items-center gap-1.5">
          <Link to={back} className="text-fg-tertiary hover:text-foreground">
            {backLabel}
          </Link>
          <ChevronRight className="size-3.5 text-fg-quaternary" />
          <span className="truncate">{title}</span>
        </span>
      }
      icon={ICONS[kind]}
      className="overflow-hidden"
    >
      <SplitView
        sideSize={320}
        sideMin={260}
        sideMax={460}
        main={
          <div className="mx-auto max-w-[720px] px-6 pt-8 pb-16">
            <div className="mb-1 font-mono text-micro text-fg-quaternary">{r.id}</div>
            <h2 className="mb-2 text-title3 font-semibold">{title}</h2>
            {recordSubtitle(kind, r.data) && kind !== 'memory' && (
              <p className="mb-6 text-regular text-fg-tertiary">{recordSubtitle(kind, r.data)}</p>
            )}
            {docField ? (
              <DocumentEditor
                value={String(r.data[docField.name] ?? '')}
                title={title}
                onSave={saveDoc}
                resolve={(_k, rid) => names.get(rid)}
                className="mb-8"
              />
            ) : (
              <div className="mb-8" />
            )}
            {docs.data && docs.data.items.length > 0 && (
              <section className="mb-8" data-testid="record-docs">
                <SectionTitle className="mb-1">Docs</SectionTitle>
                {docs.data.items.map((doc) => (
                  <Link
                    key={doc.id}
                    to={hrefFor('doc', doc.id)}
                    className="group flex h-9 min-w-0 items-center gap-2 border-b last:border-0"
                  >
                    <FileText className="size-4 shrink-0 text-fg-tertiary" />
                    <span className="shrink-0 truncate text-fg-secondary group-hover:text-foreground">{doc.data.title}</span>
                    <span className="min-w-0 flex-1 truncate text-fg-quaternary">
                      {plainDoc(doc.data.body.replace(/^#.*$/m, ''), (_k, rid) => names.get(rid)).slice(0, 160)}
                    </span>
                    {doc.data.path && (
                      <span className="hidden shrink-0 font-mono text-micro text-fg-quaternary sm:inline">{doc.data.path}</span>
                    )}
                  </Link>
                ))}
              </section>
            )}
            {kind === 'project' && <ProjectPeopleSection projectId={r.id} className="mb-8" />}
            {kind === 'project' && hasLocalRepository(r.data) && (
              <LocalRepositorySection projectId={r.id} className="mb-8" onRemoteAttached={rec.reload} />
            )}
            <Tabs defaultValue="links">
              <TabsList variant="line" className="h-8 w-full justify-start gap-3 border-b pb-0">
                <TabsTrigger value="links" className="flex-none px-0">
                  Links <span className="text-fg-quaternary">{links.data?.length ?? 0}</span>
                </TabsTrigger>
                <TabsTrigger value="backlinks" className="flex-none px-0">
                  Mentioned in <span className="text-fg-quaternary">{backlinks.data?.length ?? 0}</span>
                </TabsTrigger>
                <TabsTrigger value="history" className="flex-none px-0">
                  History <span className="text-fg-quaternary">{revisions.data?.length ?? 0}</span>
                </TabsTrigger>
              </TabsList>
              <TabsContent value="links" className="pt-3">
                {links.data && links.data.length > 0 ? (
                  <div className="rounded-xl border bg-level-1">
                    <LinksGraph center={{ id: r.id, kind, label: title }} links={links.data} />
                  </div>
                ) : (
                  <EmptyState text="Not linked to anything yet." />
                )}
              </TabsContent>
              <TabsContent value="backlinks" className="pt-3">
                {(backlinks.data ?? []).length === 0 ? (
                  <EmptyState text="No document mentions this yet." />
                ) : (
                  backlinks.data!.map((b) => (
                    <Link
                      key={b.id}
                      to={hrefFor(b.kind, b.id)}
                      className="flex h-9 items-center gap-2 border-b text-fg-secondary last:border-0 hover:text-foreground"
                    >
                      <span className="w-20 shrink-0 text-micro text-fg-tertiary">{b.kind}</span>
                      <span className="truncate">{recordTitle(undefined, b.data, b.id)}</span>
                    </Link>
                  ))
                )}
              </TabsContent>
              <TabsContent value="history" className="pt-3">
                {revisions.data ? <Revisions revisions={revisions.data} onRevert={revert} /> : <LoadingRows rows={3} />}
              </TabsContent>
            </Tabs>
          </div>
        }
        side={
          <aside className="h-full overflow-auto bg-level-1 px-4 py-4" data-testid="properties">
            <RecordPropertiesForm schema={schema} record={r} onSaved={(n) => rec.setData(n)} />
            <SectionTitle className="mt-6 mb-1">Linked</SectionTitle>
            {(links.data ?? []).map((l) => {
              const name = recordTitle(undefined, l.record.data, l.record.id)
              return (
                <Link
                  key={l.link.id}
                  to={hrefFor(l.record.kind, l.record.id)}
                  className="flex h-7 items-center gap-2 rounded-md px-1 hover:bg-secondary"
                >
                  {l.record.kind === 'contact' ? (
                    <PersonAvatar name={name} className="size-4" />
                  ) : (
                    <span className="size-1.5 shrink-0 rounded-full bg-[var(--indigo)]" />
                  )}
                  <span className="min-w-0 truncate text-fg-secondary">{name}</span>
                  <span className="ml-auto shrink-0 text-micro text-fg-quaternary">{linkRole(l.link, id)}</span>
                </Link>
              )
            })}
            <div className="mt-6 text-micro text-fg-quaternary">
              v{r.version} · updated {timeAgo(r.updatedAt)} ago
            </div>
          </aside>
        }
      />
    </Page>
  )
}
