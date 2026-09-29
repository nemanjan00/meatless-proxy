import { createHash, randomBytes } from 'node:crypto'
import type { KindSchema } from '@mp/core'
import type { Records } from '@mp/records'
import type { StoredRecord } from '@mp/store'
import type { Services } from './services.ts'

/** A per-contact token for the harness's MCP server. Only its sha256 is stored (as the record key). */
export const mcpTokenSchema: KindSchema = {
  kind: 'mcp_token',
  prefix: 'mtk',
  description: 'A bearer token for the MCP server at /mcp, mapped to a contact. The record key is the sha256 of the token.',
  titleField: 'name',
  core: [
    { name: 'contactId', type: 'ref', ref: 'contact', required: true },
    { name: 'name', type: 'string' },
    { name: 'createdAt', type: 'timestamp', required: true },
    { name: 'revoked', type: 'boolean' },
  ],
}

export interface McpTokenData extends Record<string, unknown> {
  contactId: string
  name?: string
  createdAt: string
  revoked?: boolean
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

function ensureKind(records: Records) {
  if (!records.kinds.has('mcp_token')) records.kinds.define(mcpTokenSchema)
}

/** Creates a token for a contact. The token itself is returned once and never stored. */
export async function createMcpToken(
  s: Pick<Services, 'records' | 'directory' | 'clock'>,
  contactId: string,
  name?: string,
): Promise<{ id: string; token: string; contactId: string; name?: string }> {
  ensureKind(s.records)
  await s.directory.contacts.require(contactId)
  const token = `mpt_${randomBytes(24).toString('base64url')}`
  const rec = await s.records.create<McpTokenData>(
    'mcp_token',
    { contactId, ...(name ? { name } : {}), createdAt: s.clock.iso() },
    { key: hashToken(token) },
  )
  return { id: rec.id, token, contactId, ...(name ? { name } : {}) }
}

/** The contact a bearer token belongs to, or null. */
export async function contactForToken(records: Records, token: string): Promise<string | null> {
  ensureKind(records)
  if (!token) return null
  const rec = (await records.getByKey<McpTokenData>('mcp_token', hashToken(token))) as StoredRecord<McpTokenData> | null
  if (!rec || rec.data.revoked) return null
  return rec.data.contactId
}
