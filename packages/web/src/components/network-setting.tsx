import type { EmployeeData } from '@mp/api'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { useApi } from '@/lib/api.tsx'

type Mode = 'project' | 'none' | 'own'

const modeOf = (n: EmployeeData['network']): Mode => (n === 'none' ? 'none' : n && typeof n === 'object' ? 'own' : 'project')

/** One line describing an employee's network setting. */
export function describeNetwork(n: EmployeeData['network']): string {
  if (n === 'none') return 'none'
  if (n && typeof n === 'object') return n.allow.length ? n.allow.join(', ') : 'none (empty list)'
  return "the project's allowlist"
}

/**
 * The employee's network (its environments and code sandbox): the project's allowlist (default), none, or
 * hosts of its own, which with a project are narrowed to what the project allows too. Admins change it.
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
  const [hosts, setHosts] = useState(current && typeof current === 'object' ? current.allow.join('\n') : '')
  const [busy, setBusy] = useState(false)
  if (!editing)
    return (
      <span className="flex flex-wrap items-center gap-2" data-testid="network-setting">
        <span className="font-mono text-micro">{describeNetwork(current)}</span>
        {admin && (
          <Button size="xs" variant="ghost" className="text-fg-tertiary" onClick={() => setEditing(true)}>
            Change
          </Button>
        )}
      </span>
    )
  const save = async () => {
    const allow = hosts
      .split(/[\s,]+/)
      .map((h) => h.trim())
      .filter(Boolean)
    const network = mode === 'own' ? { allow } : mode
    setBusy(true)
    try {
      await api.updateRecord<EmployeeData>('employee', employee.id, { network }, employee.version)
      toast('Network setting saved', { description: 'New environments use it; a running sandbox restarts at its next run.' })
      setEditing(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2" data-testid="network-setting">
      <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
        <SelectTrigger size="sm" aria-label="Network" className="w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="project">The project's allowlist</SelectItem>
          <SelectItem value="own">Hosts of its own</SelectItem>
          <SelectItem value="none">No network</SelectItem>
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
      <p className="text-micro text-fg-tertiary">
        Through the logging egress proxy. With a project, only hosts both allow. IP and private addresses stay blocked unless
        listed exactly; * allows any public host.
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
