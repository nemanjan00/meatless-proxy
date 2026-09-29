import type { EmployeeData } from '@mp/api'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { useApi } from '@/lib/api.tsx'

type Mode = 'project' | 'registries' | 'any' | 'own' | 'none'

/** Package registries, for `pip install` and `npm install` in the code sandbox and environments. */
export const REGISTRY_HOSTS = ['pypi.org', 'files.pythonhosted.org', 'registry.npmjs.org'] as const

const sameHosts = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((h, i) => h === [...b].sort()[i])

const modeOf = (n: EmployeeData['network']): Mode => {
  if (n === 'none') return 'none'
  if (n && typeof n === 'object') {
    if (n.allow.length === 1 && n.allow[0] === '*') return 'any'
    if (sameHosts(n.allow, REGISTRY_HOSTS)) return 'registries'
    return 'own'
  }
  return 'project'
}

/** One line describing an employee's network setting. */
export function describeNetwork(n: EmployeeData['network']): string {
  switch (modeOf(n)) {
    case 'none':
      return 'none'
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
export function networkEffect(n: EmployeeData['network']): { sandbox: string; environments: string } {
  switch (modeOf(n)) {
    case 'none':
      return { sandbox: 'no network', environments: 'no network' }
    case 'project':
      return {
        sandbox: 'no network (code runs belong to no project), unless the deployment sets DEFAULT_EGRESS',
        environments: "the project's allowlist; no network without a project",
      }
    default: {
      const what = describeNetwork(n)
      return { sandbox: what, environments: `${what}, narrowed to the project's allowlist when there is a project` }
    }
  }
}

const MODE_LABELS: Record<Mode, string> = {
  project: "Only the project's allowlist",
  registries: 'Package registries (PyPI, npm)',
  any: 'Any public host',
  own: 'These hosts…',
  none: 'No network',
}

/**
 * The employee's network: what its code sandbox and environments can reach, through the logging egress
 * proxy. Admins change it; everyone sees what it means for the sandbox and for environments.
 */
export function NetworkSetting({
  employee,
  admin,
  onSaved,
}: {
  employee: { id: string; version: number; data: EmployeeData }
  admin: boolean
  onSaved: () => void
}) {
  const api = useApi()
  const current = employee.data.network
  const [editing, setEditing] = useState(false)
  const [mode, setMode] = useState<Mode>(modeOf(current))
  const [hosts, setHosts] = useState(modeOf(current) === 'own' ? (current as { allow: string[] }).allow.join('\n') : '')
  const [busy, setBusy] = useState(false)
  const effect = networkEffect(current)

  if (!editing)
    return (
      <span className="flex flex-col gap-1" data-testid="network-setting">
        <span className="flex flex-wrap items-center gap-2">
          <span>{describeNetwork(current)}</span>
          {admin && (
            <Button size="xs" variant="ghost" className="text-fg-tertiary" onClick={() => setEditing(true)}>
              Change
            </Button>
          )}
        </span>
        <span className="text-micro text-fg-tertiary" data-testid="network-effect">
          Code sandbox: {effect.sandbox}. Environments: {effect.environments}.
        </span>
      </span>
    )

  const save = async () => {
    const own = hosts
      .split(/[\s,]+/)
      .map((h) => h.trim())
      .filter(Boolean)
    const network =
      mode === 'any'
        ? { allow: ['*'] }
        : mode === 'registries'
          ? { allow: [...REGISTRY_HOSTS] }
          : mode === 'own'
            ? { allow: own }
            : mode
    setBusy(true)
    try {
      await api.updateRecord<EmployeeData>('employee', employee.id, { network }, employee.version)
      toast('Network setting saved', { description: 'New environments use it; the code sandbox restarts at its next run.' })
      setEditing(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const preview = networkEffect(
    mode === 'any'
      ? { allow: ['*'] }
      : mode === 'registries'
        ? { allow: [...REGISTRY_HOSTS] }
        : mode === 'own'
          ? { allow: hosts.split(/[\s,]+/).filter(Boolean) }
          : mode,
  )
  return (
    <div className="flex flex-col gap-2" data-testid="network-setting">
      <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
        <SelectTrigger size="sm" aria-label="Network" className="w-72">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
            <SelectItem key={m} value={m}>
              {MODE_LABELS[m]}
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
      <p className="text-micro text-fg-quaternary">
        Everything goes through the logging egress proxy. IP and private addresses stay blocked unless listed exactly.
      </p>
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
