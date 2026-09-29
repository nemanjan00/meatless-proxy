import type { ApiFieldDef, ApiKindSchema } from '@mp/api'

/**
 * Generates form fields from a record kind's schema (core and extension
 * fields), and converts between record data and form values. Forms edit
 * every value as a string or boolean; `fromFormValues` parses them back and
 * reports problems per field.
 */
export type FormInput = 'text' | 'textarea' | 'markdown' | 'number' | 'switch' | 'datetime' | 'select' | 'ref' | 'list' | 'json'

export interface FormField {
  name: string
  label: string
  input: FormInput
  required: boolean
  description?: string
  /** `core` fields come from the harness, `extension` fields from the deployment. */
  group: 'core' | 'extension'
  /** For selects. */
  options?: string[]
  /** For refs: the kinds it may point to. */
  refKinds?: string[]
  def: ApiFieldDef
}

export type FormValue = string | boolean
export type FormValues = Record<string, FormValue>

/** Fields shown in the document body, not in the properties panel. */
export const DOCUMENT_FIELDS = new Set(['document', 'body', 'content'])

export function labelFor(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

function inputFor(f: ApiFieldDef): FormInput {
  switch (f.type) {
    case 'string':
      return 'text'
    case 'text':
      return DOCUMENT_FIELDS.has(f.name) ? 'markdown' : 'textarea'
    case 'number':
      return 'number'
    case 'boolean':
      return 'switch'
    case 'timestamp':
      return 'datetime'
    case 'enum':
      return 'select'
    case 'ref':
      return 'ref'
    case 'list':
      return f.of && ['string', 'ref', 'enum'].includes(f.of.type) ? 'list' : 'json'
    default:
      return 'json'
  }
}

export function formFields(schema: ApiKindSchema): FormField[] {
  const mk = (f: ApiFieldDef, group: FormField['group']): FormField => ({
    name: f.name,
    label: labelFor(f.name),
    input: inputFor(f),
    required: !!f.required,
    ...(f.description ? { description: f.description } : {}),
    group,
    ...(f.type === 'enum' ? { options: f.values ?? [] } : {}),
    ...(f.type === 'ref' && f.ref ? { refKinds: Array.isArray(f.ref) ? f.ref : [f.ref] } : {}),
    def: f,
  })
  return [...schema.core.map((f) => mk(f, 'core')), ...(schema.extensions ?? []).map((f) => mk(f, 'extension'))]
}

/** Data → form values. Lists of strings become one item per line; objects become pretty JSON. */
export function toFormValues(fields: FormField[], data: Record<string, unknown>): FormValues {
  const out: FormValues = {}
  for (const f of fields) {
    const v = data[f.name]
    switch (f.input) {
      case 'switch':
        out[f.name] = v === true
        break
      case 'number':
        out[f.name] = typeof v === 'number' ? String(v) : ''
        break
      case 'list':
        out[f.name] = Array.isArray(v) ? v.map(String).join('\n') : ''
        break
      case 'json':
        out[f.name] = v === undefined || v === null ? '' : JSON.stringify(v, null, 2)
        break
      default:
        out[f.name] = typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
    }
  }
  return out
}

export interface ParsedForm {
  data: Record<string, unknown>
  errors: Record<string, string>
}

/**
 * Form values → data. Empty optional values become `null` (which removes the
 * field in a PATCH). Only fields listed are touched.
 */
export function fromFormValues(fields: FormField[], values: FormValues): ParsedForm {
  const data: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const f of fields) {
    const raw = values[f.name]
    if (f.input === 'switch') {
      data[f.name] = raw === true
      continue
    }
    const s = typeof raw === 'string' ? raw.trim() : ''
    if (!s) {
      if (f.required) errors[f.name] = `${f.label} is required`
      else data[f.name] = null
      continue
    }
    switch (f.input) {
      case 'number': {
        const n = Number(s)
        if (Number.isNaN(n)) errors[f.name] = `${f.label} must be a number`
        else data[f.name] = n
        break
      }
      case 'datetime':
        if (Number.isNaN(Date.parse(s))) errors[f.name] = `${f.label} must be a date and time`
        else data[f.name] = new Date(s).toISOString()
        break
      case 'select':
        if (!(f.options ?? []).includes(s)) errors[f.name] = `${f.label} must be one of ${(f.options ?? []).join(', ')}`
        else data[f.name] = s
        break
      case 'ref':
        if (!/^[a-z][a-z0-9]*_[0-9A-Za-z]+$/.test(s)) errors[f.name] = `${f.label} must be a record id`
        else data[f.name] = s
        break
      case 'list':
        data[f.name] = s
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean)
        break
      case 'json':
        try {
          data[f.name] = JSON.parse(s)
        } catch {
          errors[f.name] = `${f.label} must be valid JSON`
        }
        break
      default:
        data[f.name] = typeof raw === 'string' ? raw : s
    }
  }
  return { data, errors }
}

/** The fields whose value differs between two data objects (shallow, JSON-compared). */
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const norm = (v: unknown) => JSON.stringify(v ?? null)
  return Object.keys(after).filter((k) => norm(before[k]) !== norm(after[k]))
}

/** The record's title, from the schema's title field or common fallbacks. */
export function recordTitle(schema: ApiKindSchema | undefined, data: Record<string, unknown>, id: string): string {
  const keys = [schema?.titleField, 'title', 'name', 'summary'].filter(Boolean) as string[]
  for (const k of keys) {
    const v = data[k]
    if (typeof v === 'string' && v) return v
  }
  return id
}
