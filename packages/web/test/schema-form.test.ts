import type { ApiKindSchema } from '@mp/api'
import { describe, expect, it } from 'vitest'
import { changedFields, formFields, fromFormValues, labelFor, recordTitle, toFormValues } from '../src/lib/schema-form.ts'

const schema: ApiKindSchema = {
  kind: 'contact',
  prefix: 'con',
  titleField: 'name',
  core: [
    { name: 'name', type: 'string', required: true },
    { name: 'manager', type: 'ref', ref: 'contact' },
    { name: 'permissions', type: 'text' },
    { name: 'handles', type: 'json' },
    { name: 'document', type: 'text' },
  ],
  extensions: [
    { name: 'timezone', type: 'enum', values: ['Europe/Berlin', 'Asia/Tokyo'] },
    { name: 'expertise', type: 'list', of: { type: 'string' } },
    { name: 'headcount', type: 'number' },
    { name: 'ai', type: 'boolean' },
    { name: 'since', type: 'timestamp' },
  ],
}

describe('formFields', () => {
  it('generates one field per core and extension field, with inputs by type', () => {
    const f = formFields(schema)
    expect(f.map((x) => [x.name, x.input, x.group])).toEqual([
      ['name', 'text', 'core'],
      ['manager', 'ref', 'core'],
      ['permissions', 'textarea', 'core'],
      ['handles', 'json', 'core'],
      ['document', 'markdown', 'core'],
      ['timezone', 'select', 'extension'],
      ['expertise', 'list', 'extension'],
      ['headcount', 'number', 'extension'],
      ['ai', 'switch', 'extension'],
      ['since', 'datetime', 'extension'],
    ])
    expect(f[0]!.required).toBe(true)
    expect(f[1]!.refKinds).toEqual(['contact'])
    expect(f[5]!.options).toEqual(['Europe/Berlin', 'Asia/Tokyo'])
  })
  it('labels camelCase and snake_case names', () => {
    expect(labelFor('workingHours')).toBe('Working hours')
    expect(labelFor('oncall_rotation')).toBe('Oncall rotation')
  })
  it('handles a schema without extensions', () => {
    expect(formFields({ kind: 'x', prefix: 'x', core: [] })).toEqual([])
  })
})

describe('toFormValues / fromFormValues', () => {
  const fields = formFields(schema)
  const data = {
    name: 'Ana Novak',
    manager: 'con_01JB0000000000000000000004',
    handles: [{ system: 'slack', id: 'U0ANA' }],
    timezone: 'Europe/Berlin',
    expertise: ['refunds', 'Stripe'],
    headcount: 4,
    ai: false,
    since: '2026-09-01T08:00:00.000Z',
  }
  it('round-trips data', () => {
    const values = toFormValues(fields, data)
    expect(values.expertise).toBe('refunds\nStripe')
    expect(values.headcount).toBe('4')
    expect(values.ai).toBe(false)
    expect(JSON.parse(values.handles as string)).toEqual(data.handles)
    const { data: back, errors } = fromFormValues(fields, values)
    expect(errors).toEqual({})
    expect(back).toMatchObject(data)
    expect(back.permissions).toBeNull() // empty optional → removed
  })
  it('reports problems per field', () => {
    const values = {
      ...toFormValues(fields, data),
      name: '  ',
      headcount: 'many',
      timezone: 'Mars',
      handles: '{nope',
      manager: 'Ana',
      since: 'yesterday-ish',
    }
    const { errors } = fromFormValues(fields, values)
    expect(Object.keys(errors).sort()).toEqual(['handles', 'headcount', 'manager', 'name', 'since', 'timezone'])
    expect(errors.name).toMatch(/required/)
  })
})

describe('helpers', () => {
  it('finds changed fields', () => {
    expect(changedFields({ a: 1, b: [1] }, { a: 1, b: [2], c: null })).toEqual(['b'])
  })
  it('picks the title', () => {
    expect(recordTitle(schema, { name: 'Ana' }, 'con_1')).toBe('Ana')
    expect(recordTitle(undefined, { summary: 'A fact' }, 'mem_1')).toBe('A fact')
    expect(recordTitle(undefined, {}, 'mem_1')).toBe('mem_1')
  })
})
