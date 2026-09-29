import { errorMessage, silentLogger, type KindSchema, type Logger } from '@mp/core'
import type { RecordStore } from '@mp/store'
import { decodeContent, type Encoding } from './files.ts'
import { normalizePath } from './paths.ts'
import type { FileStorage } from './storage.ts'

/**
 * The `file` records employee files used to be, with their content in the database. Not registered
 * by `createFiles`; `migrateFileRecords` reads them straight from the store.
 */
export const legacyFileSchema: KindSchema = {
  kind: 'file',
  prefix: 'fil',
  description: 'Legacy: an employee file stored in the database. Moved to file storage by migrateFileRecords.',
  titleField: 'path',
  core: [
    { name: 'employeeId', type: 'ref', ref: 'employee' },
    { name: 'path', type: 'string' },
    { name: 'content', type: 'string' },
    { name: 'encoding', type: 'enum', values: ['utf8', 'base64'] },
    { name: 'size', type: 'number' },
    { name: 'mime', type: 'string' },
  ],
}

export interface MigrateFilesResult {
  /** Files written to storage. */
  written: number
  /** Records whose file was already in storage with the same content (an interrupted earlier run). */
  alreadyThere: number
  /** Records whose storage file differed: storage was newer, so it was kept. */
  keptNewer: number
  /** Records that couldn't be migrated (bad path or content); left in place and logged. */
  failed: number
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Moves employee files out of the database: writes each legacy `file` record's content to storage,
 * then deletes the record. Sharing grants (`fs_share`) are already separate records and stay as they
 * are. Idempotent and safe to interrupt: a record is deleted only once its content is in storage, so a
 * rerun finds either the record (and writes the same content again, or sees it's there) or nothing.
 */
export async function migrateFileRecords(opts: {
  /** The store's records (`store.records`): the kind needn't be registered. `Records` works too once it is. */
  records: Pick<RecordStore, 'query' | 'delete'>
  storage: FileStorage
  logger?: Logger
  /** Records per page. */
  batch?: number
}): Promise<MigrateFilesResult> {
  const { records, storage } = opts
  const log = opts.logger ?? silentLogger
  const result: MigrateFilesResult = { written: 0, alreadyThere: 0, keptNewer: 0, failed: 0 }
  const batch = opts.batch ?? 200
  let offset = 0
  for (;;) {
    const page = await records.query<Record<string, unknown>>('file', { limit: batch, offset, orderBy: { field: 'createdAt' } })
    if (!page.items.length) break
    for (const r of page.items) {
      const d = r.data
      try {
        const owner = String(d.employeeId ?? '')
        const path = normalizePath(String(d.path ?? ''))
        const bytes = decodeContent(String(d.content ?? ''), (d.encoding as Encoding | undefined) ?? 'utf8')
        const existing = await storage.stat(owner, path)
        if (existing?.type === 'file') {
          const onDisk = await storage.read(owner, path)
          if (same(onDisk, bytes)) result.alreadyThere++
          else {
            result.keptNewer++
            log.warn('files migration: storage already has a different file, keeping it', { owner, path, recordId: r.id })
          }
        } else {
          await storage.write(owner, path, bytes)
          result.written++
        }
        await records.delete('file', r.id, { cascade: true, actor: { type: 'system', id: 'files-migration' } })
      } catch (e) {
        result.failed++
        offset++ // leave it and move past it
        log.error('files migration: could not migrate a file record', { recordId: r.id, err: errorMessage(e) })
      }
    }
  }
  if (result.written || result.alreadyThere || result.keptNewer || result.failed)
    log.info('files migration: moved file contents from the database to storage', { ...result })
  return result
}
