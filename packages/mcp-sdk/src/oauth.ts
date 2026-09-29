import { randomBytes } from 'node:crypto'
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

/** What an OAuth client keeps between requests and restarts. Every value is a secret. */
export type OAuthStorageKey = 'client' | 'tokens' | 'verifier' | 'discovery'

/**
 * Where a provider keeps its client registration, tokens, PKCE verifier and
 * discovery results, as strings (JSON). Back it with a secret store: these
 * are credentials, never plain records.
 */
export interface OAuthStorage {
  get(key: OAuthStorageKey): Promise<string | undefined>
  set(key: OAuthStorageKey, value: string): Promise<void>
  delete(key: OAuthStorageKey): Promise<void>
}

export interface StoredOAuthOptions {
  storage: OAuthStorage
  /** Where the authorization server sends the person back, e.g. `https://harness.example.com/oauth/mcp/callback`. */
  redirectUrl: string
  /** Shown to the person on the consent screen. Default `meatless-proxy`. */
  clientName?: string
  /** Scopes to ask for. Default: what the server advertises. */
  scopes?: string[]
  /** A pre-registered client. Without one, the client registers itself (dynamic client registration). */
  clientId?: string
  /** The pre-registered client's secret, or a function that reads it (from a secret store) when it is needed. */
  clientSecret?: string | (() => Promise<string | undefined>)
  /** The authorization server, when discovery from the MCP server doesn't find it. */
  authorizationServer?: string
}

const parse = <T>(text: string | undefined): T | undefined => {
  if (!text) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/**
 * An `OAuthClientProvider` whose state lives in an `OAuthStorage`. Values are
 * cached in memory after the first read; `forget()` drops the cache.
 *
 * - Without `onAuthorizationUrl` it is **non-interactive**, the kind a hub
 *   connects with: it sends the access token and lets the SDK refresh it, and
 *   when a new sign-in is needed the connection fails with `UnauthorizedError`
 *   (the hub reports `needs_auth`). It never writes a code verifier.
 * - With `onAuthorizationUrl` (and a `state`) it starts a sign-in: the SDK
 *   calls it with the authorization URL after saving the PKCE verifier. It
 *   ignores stored tokens, so a sign-in is always asked for.
 */
export class StoredOAuthProvider implements OAuthClientProvider {
  private cache = new Map<OAuthStorageKey, string | undefined>()

  constructor(
    private readonly opts: StoredOAuthOptions,
    private readonly interactive?: { state: string; onAuthorizationUrl: (url: URL) => void },
  ) {}

  get redirectUrl(): string {
    return this.opts.redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName ?? 'meatless-proxy',
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Only used to register a client of our own, which is public (PKCE, no secret).
      token_endpoint_auth_method: 'none',
      ...(this.opts.scopes?.length ? { scope: this.opts.scopes.join(' ') } : {}),
    }
  }

  /** Drops the in-memory cache, so the next use reads the storage again. */
  forget(): void {
    this.cache.clear()
  }

  private async read(key: OAuthStorageKey): Promise<string | undefined> {
    if (!this.cache.has(key)) this.cache.set(key, await this.opts.storage.get(key))
    return this.cache.get(key)
  }

  private async write(key: OAuthStorageKey, value: unknown): Promise<void> {
    const text = JSON.stringify(value)
    await this.opts.storage.set(key, text)
    this.cache.set(key, text)
  }

  private async remove(key: OAuthStorageKey): Promise<void> {
    await this.opts.storage.delete(key)
    this.cache.set(key, undefined)
  }

  state(): string {
    return this.interactive?.state ?? randomBytes(16).toString('base64url')
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const stored = parse<OAuthClientInformationMixed>(await this.read('client'))
    if (!this.opts.clientId) return stored
    // A configured client wins over an earlier registration; the stored copy only adds the issuer it was bound to.
    if (stored?.client_id === this.opts.clientId) return stored
    const secret = typeof this.opts.clientSecret === 'function' ? await this.opts.clientSecret() : this.opts.clientSecret
    return { client_id: this.opts.clientId, ...(secret ? { client_secret: secret } : {}) }
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.write('client', info)
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // A sign-in always asks the person: the stored tokens stay in use until new ones replace them.
    if (this.interactive) return undefined
    return parse<OAuthTokens>(await this.read('tokens'))
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.write('tokens', tokens)
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.interactive?.onAuthorizationUrl(url)
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    if (this.interactive) await this.write('verifier', verifier)
  }

  async codeVerifier(): Promise<string> {
    const v = parse<string>(await this.read('verifier'))
    if (!v) throw new Error('no OAuth sign-in in progress (no code verifier)')
    return v
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.write('discovery', state)
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const stored = parse<OAuthDiscoveryState>(await this.read('discovery'))
    const override = this.opts.authorizationServer
    if (!override) return stored
    if (stored && stored.authorizationServerUrl === override) return stored
    return { authorizationServerUrl: override }
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const keys: OAuthStorageKey[] = scope === 'all' ? ['client', 'tokens', 'verifier', 'discovery'] : [scope]
    for (const k of keys) await this.remove(k)
  }
}

export interface BeginAuthorizationOptions extends StoredOAuthOptions {
  /** The MCP server's URL. */
  serverUrl: string
  /** A random, single-use value that the callback must bring back. */
  state: string
  fetchFn?: FetchLike
}

/**
 * Starts an OAuth sign-in for an MCP server: discovers the authorization
 * server (protected-resource metadata, then authorization-server metadata),
 * registers a client when none is configured or stored, saves a PKCE
 * verifier, and returns the URL to send the person to. It always asks for
 * a new sign-in; the stored tokens stay in use until the new ones arrive.
 */
export async function beginAuthorization(opts: BeginAuthorizationOptions): Promise<URL> {
  let url: URL | undefined
  const provider = new StoredOAuthProvider(opts, { state: opts.state, onAuthorizationUrl: (u) => (url = u) })
  await provider.invalidateCredentials('verifier')
  const result = await auth(provider, {
    serverUrl: opts.serverUrl,
    ...(opts.scopes?.length ? { scope: opts.scopes.join(' ') } : {}),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  })
  if (result !== 'REDIRECT' || !url) throw new Error('the authorization server did not ask for a sign-in')
  return url
}

export interface CompleteAuthorizationOptions extends StoredOAuthOptions {
  serverUrl: string
  /** The `code` from the callback. */
  code: string
  fetchFn?: FetchLike
}

/** Completes a sign-in: exchanges the code (with the saved PKCE verifier) and stores the tokens. */
export async function completeAuthorization(opts: CompleteAuthorizationOptions): Promise<void> {
  const provider = new StoredOAuthProvider(opts, { state: '', onAuthorizationUrl: () => {} })
  let result: Awaited<ReturnType<typeof auth>>
  try {
    result = await auth(provider, {
      serverUrl: opts.serverUrl,
      authorizationCode: opts.code,
      ...(opts.scopes?.length ? { scope: opts.scopes.join(' ') } : {}),
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    })
  } finally {
    // A verifier is good for one exchange only.
    await provider.invalidateCredentials('verifier')
  }
  if (result !== 'AUTHORIZED') throw new Error('the authorization code was not accepted')
}
