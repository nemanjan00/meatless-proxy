import { createHash } from 'node:crypto'
import { intersectEgress } from '@mp/containers'
import { invalidNetwork, type EmployeeNetwork } from '@mp/directory'

/**
 * Where an environment or sandbox may connect, and why. `direct`: a real network, no proxy and no
 * allowlist. Otherwise `allow` is the proxy's allowlist, and empty means no network at all.
 */
export interface NetworkDecision {
  allow: string[]
  /** A direct network (`EnvSpec.direct`): `allow` is empty and doesn't apply. */
  direct?: true
  /** Which settings decided it. */
  source:
    | 'employee-none'
    | 'employee-direct'
    | 'direct-disabled'
    | 'employee'
    | 'employee+project'
    | 'project'
    | 'default'
    | 'none'
  /** For no network: why, and what to do about it. */
  reason?: string
}

/**
 * The network from an employee's `network` setting, the session's project allowlist and the
 * deployment default (`DEFAULT_EGRESS`):
 *
 * - `none`: never any network, whatever the project allows.
 * - `direct`: a direct network, whatever the project allows (its allowlist only applies to the proxy).
 *   With `direct: false` (the deployment's `DOCKER_DIRECT_NETWORK=false`), no network instead.
 * - `project`: the project's allowlist; without one, the deployment default (`DEFAULT_EGRESS`).
 * - No setting of its own: the deployment's `DEFAULT_NETWORK` (`direct` unless set), else `project`.
 * - `{ allow }`: with a project allowlist, only what both allow; without one, the employee's list.
 */
export function networkFor(opts: {
  network?: EmployeeNetwork | undefined
  projectAllow?: string[] | undefined
  fallback?: string[]
  /** Whether the deployment allows direct networks. Default true. */
  direct?: boolean | undefined
  /** The setting of an employee that has none of its own (`DEFAULT_NETWORK`). Default `project`. */
  defaultNetwork?: EmployeeNetwork | undefined
}): NetworkDecision {
  if (invalidNetwork(opts.network))
    return {
      allow: [],
      source: 'employee-none',
      reason: "no network: this employee's network setting is malformed. Ask an admin to fix it on the employee's page",
    }
  const n = opts.network ?? opts.defaultNetwork ?? 'project'
  const project = opts.projectAllow?.length ? opts.projectAllow : undefined
  if (n === 'none')
    return {
      allow: [],
      source: 'employee-none',
      reason: "no network: this employee's network setting is none. Ask an admin to change it on the employee's page",
    }
  if (n === 'direct')
    return opts.direct === false
      ? {
          allow: [],
          source: 'direct-disabled',
          reason:
            "no network: this employee's network setting is direct, and this deployment turns direct networks off (DOCKER_DIRECT_NETWORK=false). Ask an admin to pick another network setting on the employee's page",
        }
      : { allow: [], direct: true, source: 'employee-direct' }
  if (typeof n === 'object') {
    if (!project) return { allow: [...n.allow], source: 'employee' }
    const both = intersectEgress(n.allow, project)
    return both.length
      ? { allow: both, source: 'employee+project' }
      : {
          allow: [],
          source: 'employee+project',
          reason:
            "no network: none of the project's allowed hosts are on the employee's network allowlist. Ask an admin to add them to one or the other",
        }
  }
  if (project) return { allow: [...project], source: 'project' }
  if (opts.fallback?.length) return { allow: [...opts.fallback], source: 'default' }
  return {
    allow: [],
    source: 'none',
    reason:
      "no network: this session has no project with an egress allowlist and the employee has none. Ask an admin to add hosts to the project's egress allowlist or the employee's network setting",
  }
}

/** What env.up says about a proxied network. */
export const PROXY_NOTE =
  'curl, wget, npm, pip and git over HTTPS work through HTTP_PROXY/HTTPS_PROXY as they are; any other host gets a 403 that names it'

/** What env.up says about a direct network. */
export const DIRECT_NOTE = 'unrestricted network, not logged'

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

/**
 * The name of an employee's direct network (`EnvSpec.direct.network`), `<handle>-direct`: one per
 * employee, shared by its sandbox and environments. A long handle is cut and gets a short hash of it.
 */
export function directNetworkName(handle: string): string {
  const base = slug(handle) || 'employee'
  if (base.length <= 40) return `${base}-direct`
  const hash = createHash('sha256').update(handle).digest('hex').slice(0, 6)
  return `${base.slice(0, 33).replace(/-+$/, '')}-${hash}-direct`
}
