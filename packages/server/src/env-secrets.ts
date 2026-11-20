import type { SecretStore } from '@mp/secrets'
import { HOOKS_TOKEN_SECRET } from './integrations/provisioning.ts'
import { INTEGRATION_SPECS, secretNamesOf } from './integrations/specs.ts'
import { SSH_KEY_SECRET } from './ssh.ts'

/**
 * Secrets the harness keeps for itself: never put into an environment, even when an admin allows the
 * name for an employee. With an integration's token in a container the model could do what its tools
 * refuse (e.g. merge with the GitLab token); with the SSH key, push past the git tools' rules.
 */
export function reservedSecret(name: string): boolean {
  const own = new Set([SSH_KEY_SECRET, HOOKS_TOKEN_SECRET, ...Object.values(INTEGRATION_SPECS).flatMap(secretNamesOf)])
  return own.has(name) || name.startsWith('MCP_')
}

/** The values of the secrets an environment asks for, in the employee's and project's scope, without the reserved ones. */
export function envSecretValues(
  secrets: Pick<SecretStore, 'resolve'>,
  names: string[],
  ctx: { employeeId: string; projectId?: string },
): Promise<Record<string, string>> {
  const wanted = names.filter((n) => !reservedSecret(n))
  return wanted.length ? secrets.resolve(wanted, { ...ctx, tool: 'env.up' }) : Promise.resolve({})
}
