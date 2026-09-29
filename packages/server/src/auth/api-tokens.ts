import { NotFoundError } from '@mp/core'
import type { StoredRecord } from '@mp/store'
import type { Services } from '../services.ts'
import { mcpTokenSchema, type McpTokenData } from '../tokens.ts'

/**
 * API tokens are the MCP tokens of tokens.ts: one per-contact bearer token,
 * stored hashed, works for `/api`, `/ws` and `/mcp`.
 */
export interface ApiTokenInfo {
  id: string
  contactId: string
  name?: string
  createdAt: string
  revoked: boolean
}

type Deps = Pick<Services, 'records'>

function ensureKind(s: Deps) {
  if (!s.records.kinds.has('mcp_token')) s.records.kinds.define(mcpTokenSchema)
}

const info = (r: StoredRecord<McpTokenData>): ApiTokenInfo => ({
  id: r.id,
  contactId: r.data.contactId,
  ...(r.data.name ? { name: r.data.name } : {}),
  createdAt: r.data.createdAt,
  revoked: r.data.revoked === true,
})

/** A contact's tokens (never the tokens themselves), newest first. */
export async function listApiTokens(s: Deps, contactId?: string): Promise<ApiTokenInfo[]> {
  ensureKind(s)
  const page = await s.records.query<McpTokenData>('mcp_token', {
    ...(contactId ? { where: { contactId } } : {}),
    orderBy: { field: 'createdAt', dir: 'desc' },
    limit: 500,
  })
  return (page.items as StoredRecord<McpTokenData>[]).map(info)
}

export async function getApiToken(s: Deps, id: string): Promise<ApiTokenInfo> {
  ensureKind(s)
  const r = await s.records.get<McpTokenData>('mcp_token', id)
  if (!r) throw new NotFoundError('token', id)
  return info(r as StoredRecord<McpTokenData>)
}

/** Revokes a token (idempotent). It stops working at once. */
export async function revokeApiToken(s: Deps, id: string): Promise<ApiTokenInfo> {
  const t = await getApiToken(s, id)
  if (t.revoked) return t
  const r = await s.records.update<McpTokenData>('mcp_token', id, { revoked: true })
  return info(r as StoredRecord<McpTokenData>)
}
