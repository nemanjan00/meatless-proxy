import { type ApiClient, ApiRequestError, type WebhookInfo } from '@mp/api'
import { type MockDb, mockId } from './data.ts'

type WebhooksApi = Pick<ApiClient, 'webhooks' | 'createWebhook' | 'updateWebhook' | 'deleteWebhook' | 'rotateWebhook'>

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const secret = () => Array.from({ length: 48 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')

/** Employees' webhooks in the mock: kept in memory, the rules as given. */
export function createMockWebhooksApi(o: { db: MockDb; iso(): string; delay<T>(v: T): Promise<T> }): WebhooksApi {
  const hooks: WebhookInfo[] = []
  let seq = 0
  const find = (id: string) => {
    const w = hooks.find((x) => x.id === id)
    if (!w) throw new ApiRequestError(404, 'not_found', `webhook ${id} not found`)
    return w
  }
  void o.db
  return {
    async webhooks(q = {}) {
      await o.delay(null)
      return hooks.filter((w) => !q.employeeId || w.employeeId === q.employeeId).map((w) => ({ ...w }))
    },
    async createWebhook(body) {
      await o.delay(null)
      if (!SLUG.test(body.name)) throw new ApiRequestError(422, 'validation', 'name must be a slug')
      if (hooks.some((w) => w.employeeId === body.employeeId && w.name === body.name))
        throw new ApiRequestError(409, 'conflict', `this employee already has a webhook named ${body.name}`)
      const id = mockId('whk', ++seq)
      const now = o.iso()
      const type = body.auth?.type ?? 'token'
      const w: WebhookInfo = {
        id,
        employeeId: body.employeeId,
        name: body.name,
        enabled: body.enabled ?? true,
        ...(body.about ? { about: body.about } : {}),
        auth: { type, header: body.auth?.header || (type === 'token' ? 'X-Webhook-Token' : 'X-Signature') },
        mapping: body.mapping ?? {},
        rules: body.rules ?? [],
        url: `${location.origin}/webhooks/custom/${id}`,
        received: 0,
        ignored: 0,
        createdAt: now,
        updatedAt: now,
      }
      hooks.push(w)
      return { webhook: { ...w }, secret: secret() }
    },
    async updateWebhook(id, patch) {
      await o.delay(null)
      const w = find(id)
      Object.assign(w, patch, patch.auth ? { auth: { ...w.auth, ...patch.auth } } : {}, { updatedAt: o.iso() })
      return { ...w }
    },
    async deleteWebhook(id) {
      await o.delay(null)
      hooks.splice(hooks.indexOf(find(id)), 1)
    },
    async rotateWebhook(id) {
      await o.delay(null)
      return { webhook: { ...find(id) }, secret: secret() }
    },
  }
}
