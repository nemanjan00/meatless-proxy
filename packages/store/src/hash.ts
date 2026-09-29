import { createHash } from 'node:crypto'
import { stableStringify } from '@mp/core'

export function contentHash(content: unknown): string {
  return createHash('sha256').update(stableStringify(content)).digest('hex')
}
