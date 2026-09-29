import type { Json, KindSchema } from '@mp/core'
import type { Records } from '@mp/records'
import type { Actor } from '@mp/store'

/** Deployment-wide settings kept in the database (default router, global pause, …), one record per name. */
export const settingSchema: KindSchema = {
  kind: 'setting',
  prefix: 'set',
  description: 'A deployment-wide setting of the harness, keyed by name.',
  titleField: 'name',
  core: [
    { name: 'name', type: 'string', required: true },
    { name: 'value', type: 'json' },
  ],
}

export interface SettingData extends Record<string, unknown> {
  name: string
  value: Json
}

export const SettingNames = {
  defaultRouter: 'router.default',
  control: 'control',
  webContact: 'web.contact',
  bootstrap: 'bootstrap',
} as const

export interface Settings {
  get<T extends Json = Json>(name: string): Promise<T | undefined>
  set(name: string, value: Json, actor?: Actor): Promise<void>
}

export function createSettings(records: Records): Settings {
  if (!records.kinds.has('setting')) records.kinds.define(settingSchema)
  return {
    async get<T extends Json = Json>(name: string) {
      const r = await records.getByKey<SettingData>('setting', name)
      return r ? (r.data.value as T) : undefined
    },
    async set(name, value, actor) {
      for (let i = 0; ; i++) {
        const r = await records.getByKey<SettingData>('setting', name)
        try {
          if (r)
            await records.update<SettingData>(
              'setting',
              r.id,
              { value },
              { expectedVersion: r.version, ...(actor ? { actor } : {}) },
            )
          else await records.create<SettingData>('setting', { name, value }, { key: name, ...(actor ? { actor } : {}) })
          return
        } catch (e) {
          if (i < 5 && (e as { code?: string }).code === 'conflict') continue
          throw e
        }
      }
    },
  }
}
