import { intersectEgress } from '@mp/containers'
import { invalidNetwork, type EmployeeNetwork } from '@mp/directory'

/** Where an environment or sandbox may connect, and why. `allow` empty means no network at all. */
export interface NetworkDecision {
  allow: string[]
  /** Which settings decided it. */
  source: 'employee-none' | 'employee' | 'employee+project' | 'project' | 'default' | 'none'
  /** For no network: why, and what to do about it. */
  reason?: string
}

/**
 * The egress allowlist from an employee's `network` setting, the session's project allowlist and the
 * deployment default (`DEFAULT_EGRESS`):
 *
 * - `none`: never any network, whatever the project allows.
 * - `project` (the default): the project's allowlist; without one, the deployment default.
 * - `{ allow }`: with a project allowlist, only what both allow; without one, the employee's list.
 */
export function networkFor(opts: {
  network?: EmployeeNetwork | undefined
  projectAllow?: string[] | undefined
  fallback?: string[]
}): NetworkDecision {
  if (invalidNetwork(opts.network))
    return {
      allow: [],
      source: 'employee-none',
      reason: "no network: this employee's network setting is malformed. Ask an admin to fix it on the employee's page",
    }
  const n = opts.network ?? 'project'
  const project = opts.projectAllow?.length ? opts.projectAllow : undefined
  if (n === 'none')
    return {
      allow: [],
      source: 'employee-none',
      reason: "no network: this employee's network setting is none. Ask an admin to change it on the employee's page",
    }
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
