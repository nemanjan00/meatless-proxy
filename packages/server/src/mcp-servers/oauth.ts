import { createHash, randomBytes } from 'node:crypto'
import { type Clock, ConflictError, DeniedError, type Logger, errorMessage } from '@mp/core'
import type { OAuthStorage, OAuthStorageKey } from '@mp/mcp-sdk'
import type { Records } from '@mp/records'
import type { SecretScope, SecretStore } from '@mp/secrets'
import { MCP_OAUTH_STATE_KIND, type McpOAuthStateData, mcpOAuthStateKind, secretNameFor } from './schema.ts'

/** How long an OAuth sign-in may take, from Connect to the callback. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000
/** The callback path on the harness origin. */
export const OAUTH_CALLBACK_PATH = '/oauth/mcp/callback'

export const OAUTH_STORAGE_KEYS: readonly OAuthStorageKey[] = ['client', 'tokens', 'verifier', 'discovery']

/** The secret scope of a server's secrets: its employee's, or global. */
export const scopeOf = (employeeId: string | undefined): SecretScope =>
  employeeId ? { type: 'employee', id: employeeId } : { type: 'global' }

/** `MCP_<NAME>_OAUTH_CLIENT`, `…_OAUTH_TOKENS`, `…_OAUTH_VERIFIER`, `…_OAUTH_DISCOVERY`. */
export const oauthSecretName = (serverName: string, key: OAuthStorageKey) =>
  secretNameFor(serverName, `OAUTH_${key.toUpperCase()}`)

/**
 * An `OAuthStorage` in the secret store: one secret per key, scoped like the
 * server (the employee's, or global), so OAuth credentials are encrypted and
 * never in a plain record.
 */
export function secretOAuthStorage(secrets: SecretStore, serverName: string, employeeId: string | undefined): OAuthStorage {
  const scope = scopeOf(employeeId)
  const ctx = employeeId ? { employeeId } : {}
  return {
    async get(key) {
      const name = oauthSecretName(serverName, key)
      return (await secrets.resolve([name], ctx))[name]
    },
    set: (key, value) => secrets.set(oauthSecretName(serverName, key), value, scope, 'system'),
    delete: (key) => secrets.delete(oauthSecretName(serverName, key), scope),
  }
}

const hashState = (state: string) => createHash('sha256').update(state).digest('hex')

/**
 * OAuth `state` values: random, single-use, valid for 10 minutes, and bound
 * to one server and to the person who started the sign-in. Stored as records
 * keyed by the state's sha256, so the value itself is never stored.
 */
export class OAuthStates {
  constructor(
    private readonly records: Records,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    if (!records.kinds.has(MCP_OAUTH_STATE_KIND)) records.kinds.define(mcpOAuthStateKind)
  }

  /** A new state for a sign-in. */
  async create(input: Pick<McpOAuthStateData, 'serverId' | 'contactId' | 'returnTo' | 'redirectUrl'>) {
    await this.sweep()
    const state = randomBytes(32).toString('base64url')
    const now = this.clock.now()
    const expiresAt = new Date(now + OAUTH_STATE_TTL_MS).toISOString()
    await this.records.create<McpOAuthStateData>(
      MCP_OAUTH_STATE_KIND,
      { ...input, createdAt: new Date(now).toISOString(), expiresAt },
      { key: hashState(state) },
    )
    return { state, expiresAt }
  }

  /**
   * Uses up a state. `DeniedError` when it is unknown, expired, already used,
   * or was started by someone else. Only one of two concurrent uses wins.
   */
  async consume(state: string, contactId: string): Promise<McpOAuthStateData> {
    if (!state) throw new DeniedError('the sign-in has no state')
    const r = await this.records.getByKey<McpOAuthStateData>(MCP_OAUTH_STATE_KIND, hashState(state))
    if (!r) throw new DeniedError('unknown sign-in: start it again from the harness')
    if (r.data.usedAt) throw new DeniedError('this sign-in was already used')
    if (Date.parse(r.data.expiresAt) <= this.clock.now()) throw new DeniedError('the sign-in expired: start it again')
    if (r.data.contactId !== contactId) throw new DeniedError('this sign-in was started by someone else')
    try {
      await this.records.update<McpOAuthStateData>(
        MCP_OAUTH_STATE_KIND,
        r.id,
        { usedAt: this.clock.iso() },
        { expectedVersion: r.version },
      )
    } catch (err) {
      if (err instanceof ConflictError) throw new DeniedError('this sign-in was already used')
      throw err
    }
    return r.data
  }

  /** Deletes states of a server (it was deleted), and expired ones. */
  async forget(serverId: string): Promise<void> {
    const page = await this.records.query<McpOAuthStateData>(MCP_OAUTH_STATE_KIND, { where: { serverId }, limit: 500 })
    for (const r of page.items) await this.records.delete(MCP_OAUTH_STATE_KIND, r.id).catch(() => {})
  }

  private async sweep() {
    try {
      const cutoff = new Date(this.clock.now() - OAUTH_STATE_TTL_MS).toISOString()
      const page = await this.records.query<McpOAuthStateData>(MCP_OAUTH_STATE_KIND, {
        where: [{ field: 'expiresAt', op: 'lt', value: cutoff }],
        limit: 100,
      })
      for (const r of page.items) await this.records.delete(MCP_OAUTH_STATE_KIND, r.id).catch(() => {})
    } catch (err) {
      this.logger.warn('could not sweep expired OAuth states', { err: errorMessage(err) })
    }
  }
}
