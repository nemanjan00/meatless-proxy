import type { ApiKindSchema, ApiRecord } from '@mp/api'
import { ApiRequestError } from '@mp/api'
import { useEffect, useMemo } from 'react'
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
function RefName({ kind, id }: { kind: string; id: string }) {
  const rec = useLoad((a) => a.getRecord(kind, id).catch(() => null), [kind, id])
  const d = rec.data?.data as Record<string, unknown> | undefined
  const name = String(d?.name ?? d?.title ?? 'open')
  return (
    <Link to={hrefFor(kind, id)} className="max-w-28 shrink-0 truncate text-micro text-[#828fff] hover:underline" title={id}>
      {name}
    </Link>
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
    case 'textarea':
    case 'json':
    case 'list':
      return (
        <Textarea
          id={id}
          {...form.register(field.name)}
          rows={field.input === 'json' ? 3 : 2}
          placeholder={field.input === 'list' ? 'One per line' : '—'}
          className={cn(
            'min-h-0 border-transparent bg-transparent px-1.5 py-1 text-mini shadow-none hover:border-input dark:bg-transparent',
            field.input === 'json' && 'font-mono text-micro',
          )}
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
    case 'ref': {
      const v = String(form.watch(field.name) ?? '')
      return (
        <div className="flex items-center gap-1">
          <Input
            id={id}
            {...form.register(field.name)}
            placeholder={field.refKinds?.join(' / ') ?? 'id'}
            className={cn(inline, 'font-mono text-micro')}
          />
          {v && field.refKinds?.[0] && <RefName kind={field.refKinds[0]} id={v} />}
        </div>
      )
    }
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
