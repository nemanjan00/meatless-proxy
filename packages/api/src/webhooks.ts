/** How a delivery proves it's from the sender: a token header, or an HMAC-SHA256 signature of the body. */
export type WebhookAuthType = 'token' | 'hmac'
export interface WebhookAuth {
  type: WebhookAuthType
  /** The header it comes in (default `X-Webhook-Token` for a token, `X-Signature` for HMAC). */
  header: string
}

/** Paths into the JSON body (`action`, `issue.id`), and a text template with `{path}` placeholders. */
export interface WebhookMapping {
  type?: string
  subject?: string
  text?: string
}

export type WebhookAction = { type: 'ignore' } | { type: 'router' } | { type: 'session'; sessionId: string }

/** The first rule that matches decides; an event no rule matches goes to the router. */
export interface WebhookRule {
  /** A glob on the event type, e.g. `charge.*`. */
  type?: string
  /** A body path compared as text with `equals` or `contains`. */
  field?: string
  equals?: string
  contains?: string
  action: WebhookAction
}

/** An employee's own webhook. Its secret is shown only when it's made or rotated. */
export interface WebhookInfo {
  id: string
  employeeId: string
  name: string
  enabled: boolean
  about?: string
  auth: WebhookAuth
  mapping: WebhookMapping
  rules: WebhookRule[]
  /** Where other systems post. */
  url: string
  received: number
  ignored: number
  lastReceivedAt?: string
  createdAt: string
  updatedAt: string
}

export interface WebhookCreate {
  employeeId: string
  /** A slug, unique per employee: events come from source `webhook:<name>`. */
  name: string
  about?: string
  enabled?: boolean
  auth?: Partial<WebhookAuth> & { type: WebhookAuthType }
  mapping?: WebhookMapping
  rules?: WebhookRule[]
}

export type WebhookPatch = Partial<Omit<WebhookCreate, 'employeeId' | 'name'>>

/** A webhook just made or given a new secret: the secret, this once. */
export interface WebhookWithSecret {
  webhook: WebhookInfo
  secret: string
}
