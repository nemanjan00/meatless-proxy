import { ValidationError } from './errors.ts'

/**
 * Extendable schemas. Every record kind has core fields, and a deployment can
 * add extension fields. Both are described the same way, so code, the model
 * and generated UI forms all see them alike.
 */
export type FieldType =
  | 'string'
  | 'text' // long text or markdown
  | 'number'
  | 'boolean'
  | 'timestamp' // ISO 8601 string
  | 'json'
  | 'ref' // id of another record, see `ref`
  | 'list' // list of `of`
  | 'object' // nested object with `fields`
  | 'enum' // one of `values`

export interface FieldDef {
  name: string
  type: FieldType
  description?: string
  required?: boolean
  /** For `ref`: the record kind(s) it may point to. */
  ref?: string | string[]
  /** For `list`. */
  of?: Omit<FieldDef, 'name'>
  /** For `object`. */
  fields?: FieldDef[]
  /** For `enum`. */
  values?: string[]
}

export interface KindSchema {
  /** e.g. `contact`. */
  kind: string
  /** Id prefix, e.g. `con`. */
  prefix: string
  description?: string
  /** Fields the harness relies on. Can't be removed or redefined. */
  core: FieldDef[]
  /** Fields added by the deployment. */
  extensions?: FieldDef[]
  /** The field shown as the record's title in lists. */
  titleField?: string
}

export function allFields(schema: KindSchema): FieldDef[] {
  return [...schema.core, ...(schema.extensions ?? [])]
}

/** Adds extension fields, refusing to touch core fields. */
export function extendSchema(schema: KindSchema, extensions: FieldDef[]): KindSchema {
  const core = new Set(schema.core.map((f) => f.name))
  const clash = extensions.filter((f) => core.has(f.name)).map((f) => f.name)
  if (clash.length) throw new ValidationError(`cannot redefine core fields of ${schema.kind}`, clash)
  const byName = new Map((schema.extensions ?? []).map((f) => [f.name, f]))
  for (const f of extensions) byName.set(f.name, f)
  return { ...schema, extensions: [...byName.values()] }
}

/** Returns a list of problems, empty when `data` fits the schema. Unknown fields are allowed. */
export function checkRecord(schema: KindSchema, data: Record<string, unknown>, opts: { partial?: boolean } = {}): string[] {
  const issues: string[] = []
  for (const f of allFields(schema)) checkField(f, data[f.name], f.name, issues, opts.partial ?? false)
  return issues
}

export function validateRecord(schema: KindSchema, data: Record<string, unknown>, opts: { partial?: boolean } = {}): void {
  const issues = checkRecord(schema, data, opts)
  if (issues.length) throw new ValidationError(`invalid ${schema.kind}`, issues)
}

function checkField(f: Omit<FieldDef, 'name'> & { name?: string }, v: unknown, path: string, issues: string[], partial: boolean) {
  if (v === undefined || v === null) {
    if (f.required && !partial) issues.push(`${path} is required`)
    return
  }
  const bad = (what: string) => issues.push(`${path} must be ${what}`)
  switch (f.type) {
    case 'string':
    case 'text':
      if (typeof v !== 'string') bad('a string')
      break
    case 'number':
      if (typeof v !== 'number' || Number.isNaN(v)) bad('a number')
      break
    case 'boolean':
      if (typeof v !== 'boolean') bad('a boolean')
      break
    case 'timestamp':
      if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) bad('an ISO timestamp')
      break
    case 'ref':
      if (typeof v !== 'string' || !v.includes('_')) bad('a record id')
      break
    case 'enum':
      if (typeof v !== 'string' || !(f.values ?? []).includes(v)) bad(`one of ${(f.values ?? []).join(', ')}`)
      break
    case 'list':
      if (!Array.isArray(v)) bad('a list')
      else if (f.of)
        v.forEach((item, i) => {
          checkField(f.of!, item, `${path}[${i}]`, issues, false)
        })
      break
    case 'object':
      if (typeof v !== 'object' || Array.isArray(v)) bad('an object')
      else
        for (const sub of f.fields ?? [])
          checkField(sub, (v as Record<string, unknown>)[sub.name], `${path}.${sub.name}`, issues, partial)
      break
    case 'json':
      break
  }
}
