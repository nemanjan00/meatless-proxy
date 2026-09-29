import {
  ApiRequestError,
  IDENTITY_LINK_STATUSES,
  type IdentityApi,
  type IdentityLinkStatus,
  type IdentityLinkView,
} from '@mp/api'
import { CON } from './data.ts'

/** A few external users the harness couldn't link by itself, for dev:mock (fake names and ids). */
function seed(now: number): IdentityLinkView[] {
  const ago = (min: number) => new Date(now - min * 60_000).toISOString()
  return [
    {
      system: 'slack',
      id: 'U0MOCK0001',
      name: 'Bob Smith',
      status: 'suggested',
      firstSeenAt: ago(600),
      lastSeenAt: ago(3),
      suggested: { id: CON.bob, name: 'Bob Smith' },
    },
    { system: 'slack', id: 'U0MOCK0002', status: 'unknown', firstSeenAt: ago(90), lastSeenAt: ago(12) },
    {
      system: 'slack',
      id: 'U0MOCK0003',
      name: 'Nika Example',
      email: 'nika@example.com',
      status: 'created',
      firstSeenAt: ago(300),
      lastSeenAt: ago(40),
      contact: { id: 'con_mock_nika', name: 'Nika Example' },
    },
    {
      system: 'gitlab',
      id: 'outside-contributor',
      name: 'Outside Contributor',
      status: 'unknown',
      firstSeenAt: ago(2000),
      lastSeenAt: ago(700),
    },
  ]
}

/** The identity links API in memory (./api.ts). */
export function createMockIdentityApi(ctx: { delay: <T>(v: T) => Promise<T> }): IdentityApi {
  const items = seed(Date.now())
  const find = (system: string, id: string) => {
    const hit = items.find((x) => x.system === system && x.id === id)
    if (!hit) throw new ApiRequestError(404, 'not_found', `${system} user ${id} not found`)
    return hit
  }
  return {
    identityLinks: (query) => {
      let statuses: readonly IdentityLinkStatus[] = ['unknown', 'suggested']
      if (query?.status === 'all') statuses = IDENTITY_LINK_STATUSES
      else if (query?.status) statuses = query.status.split(',') as IdentityLinkStatus[]
      const list = items
        .filter((x) => statuses.includes(x.status) && (!query?.system || x.system === query.system))
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      return ctx.delay({ items: structuredClone(list) })
    },
    linkIdentity: ({ system, id, contactId }) => {
      const hit = find(system, id)
      hit.status = 'linked'
      hit.contact = { id: contactId, name: hit.suggested?.id === contactId ? hit.suggested.name : contactId }
      delete hit.suggested
      return ctx.delay(structuredClone(hit))
    },
    ignoreIdentity: ({ system, id, ignored = true }) => {
      const hit = find(system, id)
      hit.status = ignored ? 'ignored' : 'unknown'
      return ctx.delay(structuredClone(hit))
    },
  }
}
