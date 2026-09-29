import type { ApiKindSchema, ApiRecord, ApiRevision } from '@mp/api'
import { BookOpen, Brain, ChevronRight, FolderKanban, History, Plus, Search, Sparkles, Undo2, Users } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { DocumentEditor } from '@/components/doc-editor.tsx'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { LinksGraph } from '@/components/links-graph.tsx'
import { Page, SectionTitle } from '@/components/page.tsx'
import { PersonAvatar } from '@/components/people.tsx'
import { RecordPropertiesForm } from '@/components/record-form.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import { useApi, useLiveReload, useLoad } from '@/lib/api.tsx'
import { hrefFor } from '@/lib/doclinks.ts'
import { formatDateTime, timeAgo } from '@/lib/format.ts'
import { DOCUMENT_FIELDS, changedFields, formFields, fromFormValues, recordTitle } from '@/lib/schema-form.ts'

const ICONS: Record<string, ReactNode> = {
  project: <FolderKanban />,
  contact: <Users />,
  procedure: <BookOpen />,
  skill: <Sparkles />,
  memory: <Brain />,
}

/** The line under a record's title in lists. */
export function recordSubtitle(kind: string, data: Record<string, unknown>): string {
  const pick = (...keys: string[]) => keys.map((k) => data[k]).find((v) => typeof v === 'string' && v) as string | undefined
  switch (kind) {
    case 'contact':
      return [data.role, data.team].filter(Boolean).join(' · ')
    case 'procedure':
      return pick('applies') ?? ''
    case 'memory':
      return pick('content') ?? ''
    default:
      return pick('description', 'applies', 'role') ?? ''
  }
}

function badgeFor(kind: string, data: Record<string, unknown>): string | undefined {
  const v =
    kind === 'memory'
      ? data.kind
      : kind === 'skill'
        ? data.scope === 'company'
          ? 'company'
          : 'project'
        : kind === 'contact'
          ? data.ai
            ? 'AI'
            : undefined
          : data.status
  return typeof v === 'string' ? v : undefined
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
  return (
    <Page
      title={title}
      icon={ICONS[kind]}
      actions={
        schema && (
          <Button size="sm" variant="outline" onClick={() => setNewOpen(true)}>
            <Plus /> New {kind}
          </Button>
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
              <Button size="sm" onClick={() => setNewOpen(true)}>
                New {kind}
              </Button>
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
                <span className="min-w-0 flex-1 truncate text-fg-tertiary">{recordSubtitle(kind, r.data)}</span>
                {badge && <span className="shrink-0 rounded-sm border px-1 text-tiny text-fg-tertiary">{badge}</span>}
                <span className="w-8 shrink-0 text-right text-micro text-fg-quaternary">{timeAgo(r.updatedAt)}</span>
              </Link>
            )
          })}
        </div>
      )}
      {schema && (
        <NewRecord schema={schema} open={newOpen} onOpenChange={setNewOpen} onCreated={(r) => navigate(`${basePath}/${r.id}`)} />
      )}
    </Page>
  )
}

function Revisions({ revisions, onRevert }: { revisions: ApiRevision[]; onRevert(r: ApiRevision): void }) {
  const list = [...revisions].reverse()
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
                by {r.actor.type} <span className="font-mono text-micro">{r.actor.id}</span>
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
  useLiveReload([`records:${kind}`], rec.reload)
  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of links.data ?? []) m.set(l.record.id, recordTitle(undefined, l.record.data, l.record.id))
    return m
  }, [links.data])

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
  const back = props.basePath ?? '/'
  return (
    <Page
      title={
        <span className="flex items-center gap-1.5">
          <Link to={back} className="text-fg-tertiary hover:text-foreground">
            {props.title ?? kind}
          </Link>
          <ChevronRight className="size-3.5 text-fg-quaternary" />
          <span className="truncate">{title}</span>
        </span>
      }
      icon={ICONS[kind]}
      className="overflow-hidden"
    >
      <ResizablePanelGroup orientation="horizontal" className="h-full">
        <ResizablePanel minSize={420}>
          <div className="h-full overflow-auto">
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
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={320} minSize={260} maxSize={460}>
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
                  <span className="ml-auto shrink-0 text-micro text-fg-quaternary">{l.link.role.replace(/_/g, ' ')}</span>
                </Link>
              )
            })}
            <div className="mt-6 text-micro text-fg-quaternary">
              v{r.version} · updated {timeAgo(r.updatedAt)} ago
            </div>
          </aside>
        </ResizablePanel>
      </ResizablePanelGroup>
    </Page>
  )
}
