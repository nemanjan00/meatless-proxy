// ─── Identity from integrations: which Slack, GitLab and Linear users are which contacts ─────
//
// Served by packages/server/src/integrations/identity-routes.ts. Admins only (reading included:
// it shows names and emails of people who have no contact yet). The harness links most users by
// itself (by email, or by creating a contact that can't sign in); these routes show what it
// couldn't decide, and let an admin link or ignore a handle.

/**
 * Where an external user stands:
 * - `unknown`: the system's directory didn't say who they are (or the lookup failed);
 * - `suggested`: a person with exactly the same name and no handle in that system exists, so an admin decides;
 * - `created`: a contact was created for them (it can't sign in until an admin gives it access);
 * - `linked`: the handle is on a contact, matched by email or linked by an admin;
 * - `ignored`: an admin said to leave them anonymous.
 */
export type IdentityLinkStatus = 'unknown' | 'suggested' | 'created' | 'linked' | 'ignored'

export const IDENTITY_LINK_STATUSES: readonly IdentityLinkStatus[] = ['unknown', 'suggested', 'created', 'linked', 'ignored']

/** One external user the harness has seen. */
export interface IdentityLinkView {
  /** `slack`, `gitlab`, `linear`. */
  system: string
  /** Their id in that system (Slack `U…`, GitLab username, Linear user id). */
  id: string
  /** From the system's directory, when it said. */
  name?: string
  email?: string
  status: IdentityLinkStatus
  firstSeenAt: string
  lastSeenAt: string
  /** For `suggested`: the person with the same name. */
  suggested?: { id: string; name: string }
  /** For `created` and `linked`: the contact that has the handle. */
  contact?: { id: string; name: string }
}

/** `GET /api/identity/unlinked` query. */
export interface IdentityLinksQuery {
  /** Comma-separated statuses, or `all`. Default `unknown,suggested`. */
  status?: string
  system?: string
  /** Default 100, at most 500. */
  limit?: number
}

/** `POST /api/identity/link` body. */
export interface LinkIdentityInput {
  system: string
  id: string
  contactId: string
}

/** `POST /api/identity/ignore` body. `ignored: false` undoes it (the user is looked up again). */
export interface IgnoreIdentityInput {
  system: string
  id: string
  ignored?: boolean
}

/** The routes of this section (merged into `ROUTES`). */
export const IDENTITY_ROUTES = {
  identityLinks: ['GET', '/api/identity/unlinked'],
  linkIdentity: ['POST', '/api/identity/link'],
  ignoreIdentity: ['POST', '/api/identity/ignore'],
} as const

/** The client methods of this section (part of `ApiClient`). */
export interface IdentityApi {
  /** `GET /api/identity/unlinked` → external users the harness couldn't link by itself, most recently seen first. Admins. */
  identityLinks(query?: IdentityLinksQuery): Promise<{ items: IdentityLinkView[] }>
  /**
   * `POST /api/identity/link` → puts the handle on the contact (a person). A handle that sits on a
   * contact the harness created for that user moves; one on any other contact is a 409. Admins.
   */
  linkIdentity(input: LinkIdentityInput): Promise<IdentityLinkView>
  /** `POST /api/identity/ignore` → the user stays anonymous and isn't looked up again. Admins. */
  ignoreIdentity(input: IgnoreIdentityInput): Promise<IdentityLinkView>
}

type Call = <T>(
  route: keyof typeof IDENTITY_ROUTES,
  params?: Record<string, string>,
  query?: Record<string, string | number | boolean | undefined | null>,
  body?: unknown,
) => Promise<T>

/** The `IdentityApi` half of `createApiClient`. */
export function identityMethods(call: Call): IdentityApi {
  return {
    identityLinks: (query) => call('identityLinks', undefined, query ? { ...query } : undefined),
    linkIdentity: (input) => call('linkIdentity', undefined, undefined, input),
    ignoreIdentity: (input) => call('ignoreIdentity', undefined, undefined, input),
  }
}
