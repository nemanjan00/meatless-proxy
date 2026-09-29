import type { ExternalUser, Integration } from '@mp/mcp'

/**
 * How the harness finds out who an integration's user is (docs/spec.md#identity-from-integrations).
 * One per integration, set on its `IntegrationSpec`; replace one to use another directory.
 */
export interface IdentityLookup {
  /** The handle system, e.g. `slack`. */
  readonly system: string
  /** The user, looked up with the instance's own credentials; null when the system has no such user. */
  lookup(integration: Integration, id: string): Promise<ExternalUser | null>
  /** Ids of the users mentioned in an event's text (e.g. Slack's `<@U123>`), in order, without duplicates. */
  mentions?(text: string): string[]
  /**
   * The event text with users' names in: each mention of a user in `names` as `@Name (slack U123)`, and
   * the actor's id (where the text names them) as `Name (slack U123)`. Unknown ids stay as they are.
   */
  render?(text: string, names: ReadonlyMap<string, string>, actorId?: string): string
}

/** Looks users up through the integration's own `resolveUser`. */
const viaResolveUser = (integration: Integration, id: string) =>
  integration.resolveUser ? integration.resolveUser(id) : Promise.resolve(null)

/** Slack user ids: `U…` or `W…` (Enterprise Grid). */
const SLACK_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const slackIdentity: IdentityLookup = {
  system: 'slack',
  lookup: viaResolveUser,
  mentions(text) {
    return [...new Set([...text.matchAll(SLACK_MENTION)].map((m) => m[1]!))]
  },
  render(text, names, actorId) {
    let out = text
    const actorName = actorId ? names.get(actorId) : undefined
    // The mapped text names the actor by id once ("Slack #general U123: …"); `<@U123>` mentions are left to the next step.
    if (actorId && actorName)
      out = out.replace(new RegExp(`(?<![@\\w])${escapeRe(actorId)}(?!\\w)`), () => `${actorName} (slack ${actorId})`)
    return out.replace(SLACK_MENTION, (whole, id: string) => {
      const name = names.get(id)
      return name ? `@${name} (slack ${id})` : whole
    })
  },
}

export const gitlabIdentity: IdentityLookup = { system: 'gitlab', lookup: viaResolveUser }

export const linearIdentity: IdentityLookup = { system: 'linear', lookup: viaResolveUser }
