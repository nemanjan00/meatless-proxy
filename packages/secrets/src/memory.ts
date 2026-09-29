import { ValidationError, systemClock, type Clock } from '@mp/core'
import { scopeKey, type SecretContext, type SecretMeta, type SecretScope, type SecretStore } from './types.ts'

export interface MemorySecretStoreOptions {
  clock?: Clock
}

/** Secret names look like environment variables: `LINEAR_TOKEN`, `staging_db_url`. */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** Throws `ValidationError` for a bad secret name or scope. Shared by every `SecretStore`. */
export function checkSecret(name: string, scope: SecretScope): void {
  if (!SECRET_NAME_RE.test(name)) throw new ValidationError(`bad secret name: ${JSON.stringify(name)}`)
  if (scope.type === 'tool' ? !scope.name : scope.type !== 'global' && !scope.id) {
    throw new ValidationError(`bad secret scope: ${JSON.stringify(scope)}`)
  }
}

/** The scopes that apply in a context, most specific first: tool, project, employee, global. */
export function scopesFor(ctx: SecretContext): SecretScope[] {
  const out: SecretScope[] = []
  if (ctx.tool) out.push({ type: 'tool', name: ctx.tool })
  if (ctx.projectId) out.push({ type: 'project', id: ctx.projectId })
  if (ctx.employeeId) out.push({ type: 'employee', id: ctx.employeeId })
  out.push({ type: 'global' })
  return out
}

/** Sorts metadata by name, then scope. */
export const compareMeta = (a: SecretMeta, b: SecretMeta) =>
  a.name === b.name ? scopeKey(a.scope).localeCompare(scopeKey(b.scope)) : a.name < b.name ? -1 : 1

/** An in-memory `SecretStore`, for tests and demos. Values are kept in plain memory. */
export function memorySecretStore(opts: MemorySecretStoreOptions = {}): SecretStore {
  const clock = opts.clock ?? systemClock
  const secrets = new Map<string, { value: string; meta: SecretMeta }>()
  const k = (name: string, scope: SecretScope) => `${scopeKey(scope)}:${name}`

  return {
    async set(name, value, scope, actor = 'system') {
      checkSecret(name, scope)
      if (typeof value !== 'string') throw new ValidationError('secret value must be a string')
      secrets.set(k(name, scope), { value, meta: { name, scope: { ...scope }, updatedAt: clock.iso(), updatedBy: actor } })
    },

    async delete(name, scope) {
      secrets.delete(k(name, scope))
    },

    async list() {
      return [...secrets.values()].map((s) => ({ ...s.meta, scope: { ...s.meta.scope } })).sort(compareMeta)
    },

    async resolve(names, ctx) {
      const scopes = scopesFor(ctx)
      const out: Record<string, string> = {}
      for (const name of new Set(names)) {
        if (!SECRET_NAME_RE.test(name)) continue
        for (const scope of scopes) {
          const s = secrets.get(k(name, scope))
          if (s) {
            out[name] = s.value
            break
          }
        }
      }
      return out
    },
  }
}
