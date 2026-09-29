import type { Json } from '@mp/core'

export type SecretScope =
  | { type: 'global' }
  | { type: 'employee'; id: string }
  | { type: 'project'; id: string }
  | { type: 'tool'; name: string }

export interface SecretMeta {
  name: string
  scope: SecretScope
  updatedAt: string
  /** Who last set it. */
  updatedBy: string
}

/** Where a secret is being used: decides which scopes apply. */
export interface SecretContext {
  employeeId?: string
  projectId?: string
  tool?: string
}

export interface SecretStore {
  /** Values can be written but never listed. */
  set(name: string, value: string, scope: SecretScope, actor?: string): Promise<void>
  delete(name: string, scope: SecretScope): Promise<void>
  list(): Promise<SecretMeta[]>
  /**
   * Values for the given names in this context. The most specific scope wins:
   * tool, then project, then employee, then global. Missing names are left out.
   */
  resolve(names: string[], ctx: SecretContext): Promise<Record<string, string>>
}

/** Replaces every occurrence of the given values in strings (deeply, for JSON). */
export function createRedactor(values: string[], mask = '[secret]'): <T extends Json | string>(input: T) => T {
  const vs = [...new Set(values.filter((v) => v.length >= 4))].sort((a, b) => b.length - a.length)
  const redactString = (s: string) => vs.reduce((acc, v) => acc.split(v).join(mask), s)
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactString(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return (input) => (vs.length ? (walk(input) as any) : input)
}

export function scopeKey(scope: SecretScope): string {
  switch (scope.type) {
    case 'global':
      return 'global'
    case 'employee':
      return `employee:${scope.id}`
    case 'project':
      return `project:${scope.id}`
    case 'tool':
      return `tool:${scope.name}`
  }
}
