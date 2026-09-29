import type { ApiKindSchema, ApiRecord } from '@mp/api'
import { ApiRequestError } from '@mp/api'
import { Pencil } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Controller, type Resolver, useForm } from 'react-hook-form'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useApi, useLoad } from '@/lib/api.tsx'
import { hrefFor } from '@/lib/doclinks.ts'
import { kindOfId } from '@/lib/names.ts'
import { DOCUMENT_FIELDS, type FormField, type FormValues, formFields, fromFormValues, toFormValues } from '@/lib/schema-form.ts'
import { cn } from '@/lib/utils.ts'

/** A resolver for react-hook-form that parses values with the schema (see lib/schema-form.ts). */
export function schemaResolver(fields: FormField[]): Resolver<FormValues> {
  return async (values) => {
    const { errors } = fromFormValues(fields, values)
    if (!Object.keys(errors).length) return { values, errors: {} }
    return {
      values: {},
      errors: Object.fromEntries(Object.entries(errors).map(([k, message]) => [k, { type: 'validate', message }])),
    }
  }
}

function toLocalInput(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * The properties panel's form: every core and extension field of the kind,
 * generated from its schema, edited inline. Document fields are left to the
 * document editor.
 */
export function RecordPropertiesForm({
  schema,
  record,
  onSaved,
  exclude = [],
}: {
  schema: ApiKindSchema
  record: ApiRecord
  onSaved(r: ApiRecord): void
  exclude?: string[]
}) {
  const api = useApi()
  const fields = useMemo(
    () => formFields(schema).filter((f) => !DOCUMENT_FIELDS.has(f.name) && !exclude.includes(f.name)),
    [schema, exclude],
  )
  const defaults = useMemo(() => toFormValues(fields, record.data), [fields, record.data])
  const form = useForm<FormValues>({ defaultValues: defaults, resolver: schemaResolver(fields) })
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the record version changes
  useEffect(() => form.reset(defaults), [record.id, record.version])

  const submit = form.handleSubmit(async (values) => {
    const { data } = fromFormValues(fields, values)
    try {
      const next = await api.updateRecord(record.kind, record.id, data, record.version)
      toast('Saved', { description: `${schema.kind} updated (v${next.version})` })
      onSaved(next)
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'conflict')
        toast.error('Someone else changed this record', { description: 'Reload to see their changes.' })
      else toast.error('Could not save', { description: e instanceof Error ? e.message : String(e) })
    }
  })

  const groups: { key: FormField['group']; title: string }[] = [
    { key: 'core', title: 'Properties' },
    { key: 'extension', title: 'Extension fields' },
  ]
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="record-form">
      {groups.map((g) => {
        const list = fields.filter((f) => f.group === g.key)
        if (!list.length) return null
        return (
          <fieldset key={g.key} className="flex flex-col gap-1">
            <legend className="mb-1 text-micro font-medium text-fg-tertiary">{g.title}</legend>
            {list.map((f) => (
              <FieldRow key={f.name} field={f} error={form.formState.errors[f.name]?.message}>
                <FieldControl field={f} form={form} />
              </FieldRow>
            ))}
          </fieldset>
        )
      })}
      {form.formState.isDirty && (
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => form.reset(defaults)}>
            Discard
          </Button>
          <Button type="submit" size="sm" disabled={form.formState.isSubmitting}>
            Save
          </Button>
        </div>
      )}
    </form>
  )
}

function FieldRow({ field, error, children }: { field: FormField; error?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] items-start gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <label htmlFor={`f-${field.name}`} className="truncate pt-1.5 text-fg-tertiary">
            {field.label}
            {field.required && <span className="text-fg-quaternary"> *</span>}
          </label>
        </TooltipTrigger>
        <TooltipContent side="left">
          {field.name} · {field.def.type}
          {field.description ? ` — ${field.description}` : ''}
        </TooltipContent>
      </Tooltip>
      <div className="min-w-0">
        {children}
        {error && <p className="mt-0.5 text-micro text-[var(--red)]">{error}</p>}
      </div>
    </div>
  )
}

const inline =
  'h-7 border-transparent bg-transparent px-1.5 text-mini shadow-none hover:border-input focus-visible:border-input dark:bg-transparent'

/** The referenced record's title, as a link. */
function RefName({ kind, id, className }: { kind: string; id: string; className?: string }) {
  const rec = useLoad((a) => a.getRecord(kind, id).catch(() => null), [kind, id])
  const d = rec.data?.data as Record<string, unknown> | undefined
  const name = String(d?.name ?? d?.title ?? d?.summary ?? 'open')
  return (
    <Link
      to={hrefFor(kind, id)}
      className={cn('max-w-28 shrink-0 truncate text-micro text-[#828fff] hover:underline', className)}
      title={id}
    >
      {name}
    </Link>
  )
}

/** One value in a JSON summary: record ids become links, everything else text. */
function Token({ value }: { value: unknown }) {
  if (typeof value === 'string') {
    const kind = kindOfId(value)
    if (kind) return <RefName kind={kind} id={value} className="max-w-full text-mini" />
    return <span className={cn('break-words', /^[a-z]+:\/\//.test(value) && 'font-mono text-micro')}>{value}</span>
  }
  return <span>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
}

/** An object as one line: values joined by `·`, `true` flags by their name, lists as chips. */
function ObjectLine({ value }: { value: Record<string, unknown> }) {
  const parts: { key: string; node: ReactNode }[] = []
  for (const [k, v] of Object.entries(value)) {
    if (v === false || v === null || v === undefined || v === '') continue
    if (v === true) parts.push({ key: k, node: <span className="text-fg-tertiary">{k}</span> })
    else if (Array.isArray(v))
      parts.push({
        key: k,
        node: (
          <span className="inline-flex flex-wrap items-center gap-1">
            <span className="text-fg-tertiary">{k}</span>
            {v.map((x) => (
              <span key={`${k}-${JSON.stringify(x)}`} className="rounded-sm border bg-level-2 px-1 font-mono text-micro">
                <Token value={x} />
              </span>
            ))}
          </span>
        ),
      })
    else parts.push({ key: k, node: <Token value={v} /> })
  }
  return (
    <>
      {parts.map((p, i) => (
        <span key={p.key}>
          {i > 0 && <span className="text-fg-quaternary">{' · '}</span>}
          {p.node}
        </span>
      ))}
    </>
  )
}

/** A readable view of a JSON field (lists of objects, objects): one line per item. */
export function JsonSummary({ text }: { text: string }) {
  let value: unknown
  try {
    value = text.trim() ? JSON.parse(text) : null
  } catch {
    return <span className="font-mono text-micro text-fg-secondary">{text}</span>
  }
  if (value === null || (Array.isArray(value) && value.length === 0)) return <span className="text-fg-quaternary">—</span>
  const items = Array.isArray(value) ? value : [value]
  return (
    <ul className="flex flex-col gap-1" data-testid="json-summary">
      {items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: items have no identity
        <li key={i} className="min-w-0 text-mini text-fg-secondary">
          {it && typeof it === 'object' && !Array.isArray(it) ? (
            <ObjectLine value={it as Record<string, unknown>} />
          ) : (
            <Token value={it} />
          )}
        </li>
      ))}
    </ul>
  )
}

/** A reference: the record's name as a link, and the raw id on "Edit". */
function RefField({ field, form }: { field: FormField; form: ReturnType<typeof useForm<FormValues>> }) {
  const id = `f-${field.name}`
  const [editing, setEditing] = useState(false)
  const v = String(form.watch(field.name) ?? '')
  const kind = kindOfId(v) ?? field.refKinds?.[0]
  if (v && kind && !editing && !form.formState.errors[field.name])
    return (
      <div className="group/ref flex h-7 items-center gap-1 rounded-md px-1.5 hover:bg-secondary/60">
        <RefName kind={kind} id={v} className="max-w-full text-mini" />
        <button
          type="button"
          id={id}
          onClick={() => setEditing(true)}
          className="ml-auto shrink-0 rounded p-0.5 text-fg-quaternary opacity-0 group-hover/ref:opacity-100 hover:text-foreground focus-visible:opacity-100"
          aria-label={`Edit ${field.label}`}
        >
          <Pencil className="size-3" />
        </button>
      </div>
    )
  return (
    <Input
      id={id}
      {...form.register(field.name)}
      placeholder={field.refKinds?.map((k) => `${k} id`).join(' / ') ?? 'id'}
      className={cn(inline, 'font-mono text-micro')}
    />
  )
}

/** A list of references: one linked name per line, and the raw ids (one per line) on "Edit". */
function RefListField({ field, form }: { field: FormField; form: ReturnType<typeof useForm<FormValues>> }) {
  const id = `f-${field.name}`
  const [editing, setEditing] = useState(false)
  const ids = String(form.watch(field.name) ?? '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
  const refKind = Array.isArray(field.def.of?.ref) ? field.def.of.ref[0] : field.def.of?.ref
  if (ids.length && !editing && !form.formState.errors[field.name])
    return (
      <div className="group/refs flex items-start gap-1 rounded-md px-1.5 py-1 hover:bg-secondary/60">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {ids.map((v) => {
            const kind = kindOfId(v) ?? refKind
            return kind ? (
              <RefName key={v} kind={kind} id={v} className="max-w-full text-mini" />
            ) : (
              <span key={v} className="font-mono text-micro">
                {v}
              </span>
            )
          })}
        </div>
        <button
          type="button"
          id={id}
          onClick={() => setEditing(true)}
          className="shrink-0 rounded p-0.5 text-fg-quaternary opacity-0 group-hover/refs:opacity-100 hover:text-foreground focus-visible:opacity-100"
          aria-label={`Edit ${field.label}`}
        >
          <Pencil className="size-3" />
        </button>
      </div>
    )
  return (
    <Textarea
      id={id}
      {...form.register(field.name)}
      rows={2}
      placeholder="One id per line"
      className="min-h-0 border-transparent bg-transparent px-1.5 py-1 font-mono text-micro shadow-none hover:border-input dark:bg-transparent"
    />
  )
}

/** A JSON field: a readable summary, and the raw JSON on "Edit". */
function JsonField({ field, form }: { field: FormField; form: ReturnType<typeof useForm<FormValues>> }) {
  const id = `f-${field.name}`
  const [editing, setEditing] = useState(false)
  const text = String(form.watch(field.name) ?? '')
  const invalid = !!form.formState.errors[field.name]
  if (!editing && !invalid)
    return (
      <div className="group/json flex items-start gap-1 rounded-md px-1.5 py-1 hover:bg-secondary/60">
        <div className="min-w-0 flex-1">
          <JsonSummary text={text} />
        </div>
        <button
          type="button"
          id={id}
          onClick={() => setEditing(true)}
          className="shrink-0 rounded p-0.5 text-fg-quaternary opacity-0 group-hover/json:opacity-100 hover:text-foreground focus-visible:opacity-100"
          aria-label={`Edit ${field.label}`}
        >
          <Pencil className="size-3" />
        </button>
      </div>
    )
  return (
    <Textarea
      id={id}
      {...form.register(field.name)}
      rows={Math.min(12, Math.max(3, text.split('\n').length))}
      placeholder="—"
      className="min-h-0 border-transparent bg-transparent px-1.5 py-1 font-mono text-micro shadow-none hover:border-input dark:bg-transparent"
    />
  )
}

function FieldControl({ field, form }: { field: FormField; form: ReturnType<typeof useForm<FormValues>> }) {
  const id = `f-${field.name}`
  switch (field.input) {
    case 'switch':
      return (
        <Controller
          control={form.control}
          name={field.name}
          render={({ field: f }) => <Switch id={id} checked={f.value === true} onCheckedChange={f.onChange} className="mt-1" />}
        />
      )
    case 'select':
      return (
        <Controller
          control={form.control}
          name={field.name}
          render={({ field: f }) => (
            <Select value={String(f.value || '')} onValueChange={f.onChange}>
              <SelectTrigger id={id} size="sm" className={cn(inline, 'w-full justify-between')}>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {(field.options ?? []).map((o) => (
                  <SelectItem key={o} value={o}>
                    {o}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      )
    case 'json':
      return <JsonField field={field} form={form} />
    case 'list':
      if (field.def.of?.type === 'ref') return <RefListField field={field} form={form} />
      return (
        <Textarea
          id={id}
          {...form.register(field.name)}
          rows={2}
          placeholder="One per line"
          className="min-h-0 border-transparent bg-transparent px-1.5 py-1 text-mini shadow-none hover:border-input dark:bg-transparent"
        />
      )
    case 'textarea':
      return (
        <Textarea
          id={id}
          {...form.register(field.name)}
          rows={2}
          placeholder="—"
          className="min-h-0 border-transparent bg-transparent px-1.5 py-1 text-mini shadow-none hover:border-input dark:bg-transparent"
        />
      )
    case 'datetime':
      return (
        <Controller
          control={form.control}
          name={field.name}
          render={({ field: f }) => (
            <Input
              id={id}
              type="datetime-local"
              value={toLocalInput(String(f.value ?? ''))}
              onChange={(e) => f.onChange(e.target.value)}
              className={inline}
            />
          )}
        />
      )
    case 'ref':
      return <RefField field={field} form={form} />
    default:
      return (
        <Input
          id={id}
          type={field.input === 'number' ? 'number' : 'text'}
          {...form.register(field.name)}
          placeholder="—"
          className={inline}
        />
      )
  }
}
