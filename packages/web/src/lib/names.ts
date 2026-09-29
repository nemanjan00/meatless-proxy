import type { ApiClient } from '@mp/api'
import { useLoad } from '@/lib/api.tsx'
import { parseDocLinks } from '@/lib/doclinks.ts'
import { recordTitle } from '@/lib/schema-form.ts'

/** Record kinds by id prefix, for ids found without a kind (e.g. `con_…` in a JSON field). */
export const KIND_BY_PREFIX: Record<string, string> = {
  con: 'contact',
  pro: 'project',
  prc: 'procedure',
  ses: 'session',
  emp: 'employee',
  skl: 'skill',
  mem: 'memory',
  doc: 'doc',
  trg: 'trigger',
  chn: 'channel',
}

export const ID_RE = /^([a-z][a-z0-9]*)_[0-9A-Za-z]{10,}$/

/** The kind of a prefixed id, if known. */
export function kindOfId(id: string): string | undefined {
  const m = ID_RE.exec(id)
  return m ? KIND_BY_PREFIX[m[1]!] : undefined
}

/** Loads the titles of records, by id. Missing records are left out. */
export async function loadNames(api: ApiClient, refs: { kind: string; id: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Map(refs.map((r) => [r.id, r])).values()].slice(0, 100)
  await Promise.all(
    unique.map((r) =>
      api.getRecord(r.kind, r.id).then(
        (rec) => out.set(r.id, recordTitle(undefined, rec.data, r.id)),
        () => undefined,
      ),
    ),
  )
  return out
}

/** Titles of the records referenced by `[[kind:id]]` links in some texts, and of extra refs. */
export function useNames(texts: string[], refs: { kind: string; id: string }[] = []) {
  const all = [...texts.flatMap((t) => parseDocLinks(t)), ...refs]
  const key = [...new Set(all.map((r) => `${r.kind}:${r.id}`))].sort().join(',')
  const names = useLoad((api) => (key ? loadNames(api, all) : Promise.resolve(new Map<string, string>())), [key])
  return names.data ?? new Map<string, string>()
}
