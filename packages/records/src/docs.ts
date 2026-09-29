import type { KindSchema } from '@mp/core'
import type { Actor, Ref, StoredRecord } from '@mp/store'
import { findChapter, upsertChapter } from './doclinks.ts'
import type { Records } from './records.ts'

/**
 * Markdown documents. Every project, session, procedure or memory can own
 * documents; a document can link to anything with `[[kind:id]]`.
 */
export const docSchema: KindSchema = {
  kind: 'doc',
  prefix: 'doc',
  description: 'A markdown document owned by a project, session, procedure or other record.',
  titleField: 'title',
  core: [
    { name: 'title', type: 'string', required: true },
    { name: 'body', type: 'text', required: true, description: 'Markdown. Link records with [[kind:id]].' },
    {
      name: 'owner',
      type: 'object',
      fields: [
        { name: 'kind', type: 'string', required: true },
        { name: 'id', type: 'ref', required: true },
      ],
    },
    {
      name: 'path',
      type: 'string',
      description: 'Optional path-like name within the owner, e.g. `architecture` or `runbooks/deploy`.',
    },
  ],
}

export interface DocData extends Record<string, unknown> {
  title: string
  body: string
  owner?: Ref
  path?: string
}

export interface Docs {
  create(data: DocData, actor?: Actor): Promise<StoredRecord<DocData>>
  get(id: string): Promise<StoredRecord<DocData> | null>
  /** Documents owned by a record, optionally the one at `path`. */
  forOwner(owner: Ref, path?: string): Promise<StoredRecord<DocData>[]>
  update(id: string, patch: Partial<DocData>, opts?: { actor?: Actor; expectedVersion?: number }): Promise<StoredRecord<DocData>>
  /** The text of one chapter (by heading), or null. */
  chapter(id: string, heading: string): Promise<string | null>
  /** Writes a chapter, creating it if needed. */
  writeChapter(id: string, heading: string, body: string, actor?: Actor): Promise<StoredRecord<DocData>>
}

export function createDocs(records: Records): Docs {
  if (!records.kinds.has('doc')) records.kinds.define(docSchema)
  const docs: Docs = {
    create: (data, actor) => records.create('doc', data, actor ? { actor } : {}),
    get: (id) => records.get<DocData>('doc', id),
    async forOwner(owner, path) {
      const where: Record<string, any> = { 'owner.id': owner.id }
      if (path !== undefined) where.path = path
      return (await records.query<DocData>('doc', { where, orderBy: { field: 'createdAt' } })).items
    },
    update: (id, patch, o = {}) => records.update<DocData>('doc', id, patch, o),
    async chapter(id, heading) {
      const d = await records.require<DocData>('doc', id)
      return findChapter(d.data.body, heading)?.body ?? null
    },
    async writeChapter(id, heading, body, actor) {
      const d = await records.require<DocData>('doc', id)
      return records.update<DocData>(
        'doc',
        id,
        { body: upsertChapter(d.data.body, heading, body) },
        {
          expectedVersion: d.version,
          ...(actor ? { actor } : {}),
        },
      )
    },
  }
  return docs
}
