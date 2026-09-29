import type { DeploymentNetwork, EmployeeData } from '@mp/api'
import { CircleAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { useApi } from '@/lib/api.tsx'
import { useDeploymentNetwork } from '@/lib/auth.tsx'

type Mode = 'default' | 'project' | 'registries' | 'any' | 'own' | 'direct' | 'none'

type Network = EmployeeData['network']

/** Package registries, for `pip install` and `npm install` in the code sandbox and environments. */
export const REGISTRY_HOSTS = ['pypi.org', 'files.pythonhosted.org', 'registry.npmjs.org'] as const

/** What a deployment applies when `GET /api/me` hasn't said (the server's own defaults). */
export const DEPLOYMENT_FALLBACK: DeploymentNetwork = { defaultNetwork: 'direct', directNetwork: true }

const sameHosts = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((h, i) => h === [...b].sort()[i])

/** What an employee with a direct network is warned about. */
export const DIRECT_WARNING =
  'Unrestricted and not logged: it can reach your LAN, cloud metadata and any host. Only for employees you trust.'

/** What a direct network means in a deployment that turns direct networks off. */
export const DIRECT_OFF_NOTE =
  'Direct networks are off in this deployment (DOCKER_DIRECT_NETWORK=false): a direct network means no network here.'

const modeOf = (n: Network | null): Mode => {
  if (n === undefined || n === null) return 'default'
  if (n === 'none') return 'none'
  if (n === 'direct') return 'direct'
  if (n === 'project') return 'project'
  if (typeof n === 'object') {
    if (n.allow.length === 1 && n.allow[0] === '*') return 'any'
    if (sameHosts(n.allow, REGISTRY_HOSTS)) return 'registries'
    return 'own'
  }
  return 'project'
}

/** The setting that applies: the employee's own, else the deployment default. */
const effectiveOf = (n: Network, d: DeploymentNetwork): NonNullable<Network> => n ?? d.defaultNetwork

/** Whether the setting gives a real, direct network (a direct setting, with direct networks on). */
const isDirect = (n: Network, d: DeploymentNetwork) => effectiveOf(n, d) === 'direct' && d.directNetwork

/** Whether the setting is direct, in a deployment that turns direct networks off. */
const isDirectOff = (n: Network, d: DeploymentNetwork) => effectiveOf(n, d) === 'direct' && !d.directNetwork

/** What the deployment default is, in a few words. */
function defaultPhrase(d: DeploymentNetwork): string {
  switch (d.defaultNetwork) {
    case 'none':
      return 'no network'
    case 'project':
      return "the project's allowlist"
    default:
      return d.directNetwork ? 'direct network, no proxy' : 'no network: direct networks are off'
  }
}

/** One line describing an employee's network setting. */
export function describeNetwork(n: Network, deployment: DeploymentNetwork = DEPLOYMENT_FALLBACK): string {
  switch (modeOf(n)) {
    case 'default':
      return `deployment default (${defaultPhrase(deployment)})`
    case 'none':
      return 'none'
    case 'direct':
      return deployment.directNetwork ? 'direct network (no proxy)' : 'direct network (off here: no network)'
    case 'any':
      return 'any public host'
    case 'registries':
      return 'package registries (PyPI, npm)'
    case 'own': {
      const allow = (n as { allow: string[] }).allow
      return allow.length ? allow.join(', ') : 'none (empty list)'
    }
    default:
      return "the project's allowlist"
  }
}

/** What the employee's code sandbox (code.run) and its environments (env.up) can reach with this setting. */
export function networkEffect(
  n: Network,
  deployment: DeploymentNetwork = DEPLOYMENT_FALLBACK,
): { sandbox: string; environments: string } {
  const applied = effectiveOf(n, deployment)
  switch (modeOf(applied)) {
    case 'none':
      return { sandbox: 'no network', environments: 'no network' }
    case 'direct':
      return deployment.directNetwork
        ? { sandbox: 'direct network, unrestricted and not logged', environments: 'the same' }
        : { sandbox: 'no network (direct networks are off in this deployment)', environments: 'no network' }
    case 'project':
      return {
        sandbox: 'no network (code runs belong to no project), unless the deployment sets DEFAULT_EGRESS',
        environments: "the project's allowlist; no network without a project",
      }
    default: {
      const what = describeNetwork(applied, deployment)
      return { sandbox: what, environments: `${what}, narrowed to the project's allowlist when there is a project` }
    }
  }
}

const modeLabels = (d: DeploymentNetwork): Record<Mode, string> => ({
  default: `Deployment default (${defaultPhrase(d)})`,
  project: "Only the project's allowlist",
  registries: 'Package registries (PyPI, npm)',
  any: 'Any public host',
  own: 'These hosts…',
  direct: d.directNetwork ? 'Direct network (no proxy)' : 'Direct network (off here: no network)',
  none: 'No network',
})

/** The setting a mode stands for; `hosts` is the textarea's list, for `own`. */
function networkOf(mode: Mode, hosts: string): Network {
  switch (mode) {
    case 'default':
      return undefined
    case 'any':
      return { allow: ['*'] }
    case 'registries':
      return { allow: [...REGISTRY_HOSTS] }
    case 'own':
      return {
        allow: hosts
          .split(/[\s,]+/)
          .map((h) => h.trim())
          .filter(Boolean),
      }
    default:
      return mode
  }
}

/** The warning shown with a direct network, in the stylebook's warning colour. */
function DirectWarning() {
  return (
    <p className="flex items-start gap-1.5 text-micro text-[var(--orange)]" role="alert" data-testid="network-direct-warning">
      <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{DIRECT_WARNING}</span>
    </p>
  )
}

/** What a direct setting means where direct networks are off. */
function DirectOffNote() {
  return (
    <p className="text-micro text-fg-tertiary" data-testid="network-direct-off">
      {DIRECT_OFF_NOTE}
    </p>
  )
}

/** The warning or note for a setting that is, or falls back to, a direct network. */
function DirectNotice({ network, deployment }: { network: Network; deployment: DeploymentNetwork }) {
  if (isDirect(network, deployment)) return <DirectWarning />
  if (isDirectOff(network, deployment)) return <DirectOffNote />
  return null
}

/**
 * The employee's network: what its code sandbox and environments can reach, through the logging egress
 * proxy or, as an admin's choice, a direct network. With no setting of its own, the deployment default
 * applies (`deployment`, else what `GET /api/me` says). Admins change it, or clear it back to the default;
 * everyone sees what it means for the sandbox and for environments.
 */
export function NetworkSetting({
  employee,
  admin,
  onSaved,
  deployment: given,
}: {
  employee: { id: string; version: number; data: EmployeeData }
  admin: boolean
  onSaved: () => void
  deployment?: DeploymentNetwork
}) {
  const api = useApi()
  const loaded = useDeploymentNetwork()
  const deployment = given ?? loaded ?? DEPLOYMENT_FALLBACK
  const current = employee.data.network
  const [editing, setEditing] = useState(false)
  const [mode, setMode] = useState<Mode>(modeOf(current))
  const [hosts, setHosts] = useState(modeOf(current) === 'own' ? (current as { allow: string[] }).allow.join('\n') : '')
  const [busy, setBusy] = useState(false)
  const effect = networkEffect(current, deployment)

  if (!editing)
    return (
      <span className="flex flex-col gap-1" data-testid="network-setting">
        <span className="flex flex-wrap items-center gap-2">
          <span>{describeNetwork(current, deployment)}</span>
          {admin && (
            <Button
              size="xs"
              variant="ghost"
              className="text-fg-tertiary"
              onClick={() => {
                setMode(modeOf(current))
                setEditing(true)
              }}
            >
              Change
            </Button>
          )}
        </span>
        <span className="text-micro text-fg-tertiary" data-testid="network-effect">
          Code sandbox: {effect.sandbox}. Environments: {effect.environments}.
        </span>
        <DirectNotice network={current} deployment={deployment} />
      </span>
    )

  const picked = networkOf(mode, hosts)
  const save = async () => {
    // Deployment default clears the employee's own setting: the records API removes a field set to null.
    const network = mode === 'default' ? null : picked
    setBusy(true)
    try {
      await api.updateRecord('employee', employee.id, { network }, employee.version)
      toast('Network setting saved', { description: 'New environments use it; the code sandbox restarts at its next run.' })
      setEditing(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const preview = networkEffect(picked, deployment)
  const labels = modeLabels(deployment)
  return (
    <div className="flex flex-col gap-2" data-testid="network-setting">
      <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
        <SelectTrigger size="sm" aria-label="Network" className="w-72">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(labels) as Mode[]).map((m) => (
            <SelectItem key={m} value={m}>
              {labels[m]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {mode === 'own' && (
        <Textarea
          aria-label="Allowed hosts"
          className="font-mono text-micro"
          rows={3}
          placeholder={'pypi.org\n*.github.com:443'}
          value={hosts}
          onChange={(e) => setHosts(e.target.value)}
        />
      )}
      <p className="text-micro text-fg-tertiary" data-testid="network-preview">
        Code sandbox: {preview.sandbox}. Environments: {preview.environments}.
      </p>
      {isDirect(picked, deployment) ? (
        <DirectWarning />
      ) : isDirectOff(picked, deployment) ? (
        <DirectOffNote />
      ) : (
        effectiveOf(picked, deployment) !== 'none' && (
          <p className="text-micro text-fg-quaternary">
            Everything goes through the logging egress proxy. IP and private addresses stay blocked unless listed exactly.
          </p>
        )
      )}
      <div className="flex gap-2">
        <Button size="xs" onClick={save} disabled={busy}>
          Save
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
