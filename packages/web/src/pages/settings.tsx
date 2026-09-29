import type { ApiRecord, EmployeeData, SecretScope, TriggerData } from '@mp/api'
import { CirclePause, CirclePlay, Gauge, KeyRound, Power, Settings, Trash2, Users, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, useParams } from 'react-router'
import { toast } from 'sonner'
import { EmptyState, LoadingRows } from '@/components/empty.tsx'
import { Page, SectionTitle } from '@/components/page.tsx'
import { EmployeeAvatar } from '@/components/people.tsx'
import { RecordPropertiesForm } from '@/components/record-form.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { useApi, useLoad } from '@/lib/api.tsx'
import { useEmployees } from '@/lib/employees.tsx'
import { timeAgo } from '@/lib/format.ts'
import { cn } from '@/lib/utils.ts'

const SECTIONS = [
  { key: 'employees', label: 'Employees', icon: Users },
  { key: 'secrets', label: 'Secrets', icon: KeyRound },
  { key: 'triggers', label: 'Triggers', icon: Zap },
  { key: 'limits', label: 'Limits', icon: Gauge },
  { key: 'control', label: 'Kill switch', icon: Power },
] as const

/** `mcp.tasks.*` style patterns (`**` too) → does the tool match? The deny list wins. */
export function toolAllowed(tool: string, allow: string[], deny: string[]): boolean {
  const match = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(tool)
  return allow.some(match) && !deny.some(match)
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid items-start gap-1 py-2 sm:grid-cols-[160px_1fr] sm:gap-4">
      <label htmlFor={id} className="pt-1.5">
        <span className="block text-fg-secondary">{label}</span>
        {hint && <span className="block text-micro text-fg-quaternary">{hint}</span>}
      </label>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** The employee's tool lists, from either shape (`toolAllow`/`toolDeny` or `tools`). */
export function toolLists(d: EmployeeData): { allow: string[]; deny: string[]; flat: boolean } {
  const flat = Array.isArray(d.toolAllow) || Array.isArray(d.toolDeny) || !d.tools
  return flat
    ? { allow: d.toolAllow ?? [], deny: d.toolDeny ?? [], flat }
    : { allow: d.tools.allow ?? [], deny: d.tools.deny ?? [], flat }
}

function EmployeeEditor({ employee, onSaved }: { employee: ApiRecord<EmployeeData>; onSaved(): void }) {
  const api = useApi()
  const d = employee.data
  const lists = toolLists(d)
  const [personality, setPersonality] = useState(d.personality ?? '')
  const [scope, setScope] = useState(d.scope ?? '')
  const [model, setModel] = useState(d.model ?? '')
  const [allow, setAllow] = useState(lists.allow.join('\n'))
  const [deny, setDeny] = useState(lists.deny.join('\n'))
  const [probe, setProbe] = useState('')
  useEffect(() => {
    setPersonality(d.personality ?? '')
    setScope(d.scope ?? '')
    setModel(d.model ?? '')
    const l = toolLists(d)
    setAllow(l.allow.join('\n'))
    setDeny(l.deny.join('\n'))
  }, [d])
  const lines = (s: string) =>
    s
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
  const save = async () => {
    await api.updateRecord<EmployeeData>(
      'employee',
      employee.id,
      {
        personality,
        scope,
        model,
        ...(lists.flat
          ? { toolAllow: lines(allow), toolDeny: lines(deny) }
          : { tools: { allow: lines(allow), deny: lines(deny) } }),
      },
      employee.version,
    )
    toast(`${d.name} saved`, { description: 'Tool changes apply to new sessions; running sessions keep their tool set.' })
    onSaved()
  }
  const allowed = probe.trim() ? toolAllowed(probe.trim(), lines(allow), lines(deny)) : null
  return (
    <div className="min-w-0 max-w-[720px] flex-1" data-testid="employee-editor">
      <div className="mb-4 flex items-center gap-3">
        <EmployeeAvatar name={d.name} className="size-8" />
        <div>
          <div className="text-title1 font-semibold">{d.name}</div>
          <div className="font-mono text-micro text-fg-quaternary">{employee.id}</div>
        </div>
      </div>
      <Field id="emp-personality" label="Personality" hint="Tone only; never overrides the rules">
        <Textarea id="emp-personality" value={personality} onChange={(e) => setPersonality(e.target.value)} rows={3} />
      </Field>
      <Field id="emp-scope" label="Scope" hint="The slice of the company it covers">
        <Textarea id="emp-scope" value={scope} onChange={(e) => setScope(e.target.value)} rows={2} />
      </Field>
      <Field id="emp-model" label="Model">
        <Input
          id="emp-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="The deployment default"
          className="font-mono text-micro"
        />
      </Field>
      <Field id="emp-allow" label="Allow list" hint="Names or patterns, one per line">
        <Textarea
          id="emp-allow"
          value={allow}
          onChange={(e) => setAllow(e.target.value)}
          rows={5}
          className="font-mono text-micro"
        />
      </Field>
      <Field id="emp-deny" label="Deny list" hint="Wins over the allow list">
        <Textarea
          id="emp-deny"
          value={deny}
          onChange={(e) => setDeny(e.target.value)}
          rows={3}
          className="font-mono text-micro"
        />
      </Field>
      <Field id="emp-probe" label="Check a tool">
        <span className="flex items-center gap-2">
          <Input
            value={probe}
            onChange={(e) => setProbe(e.target.value)}
            className="font-mono text-micro"
            aria-label="Tool name"
            placeholder="A tool name, e.g. fs.read"
          />
          {allowed !== null && (
            <span className={cn('shrink-0 text-micro', allowed ? 'text-[var(--green)]' : 'text-[var(--red)]')}>
              {allowed ? 'allowed' : 'not allowed'}
            </span>
          )}
        </span>
      </Field>
      <div className="flex justify-end pt-2">
        <Button size="sm" onClick={save}>
          Save
        </Button>
      </div>
    </div>
  )
}

function Employees() {
  const { employees, reload } = useEmployees()
  const [sel, setSel] = useState<string | null>(null)
  const current = employees.find((e) => e.id === sel) ?? employees[0]
  if (!current) return <LoadingRows />
  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <div className="flex shrink-0 flex-col md:w-48">
        {employees.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => setSel(e.id)}
            className={cn(
              'flex h-8 items-center gap-2 rounded-md px-2 text-left hover:bg-secondary',
              e.id === current.id && 'bg-secondary text-foreground',
            )}
          >
            <EmployeeAvatar name={e.data.name} className="size-4" />
            {e.data.name}
          </button>
        ))}
      </div>
      <EmployeeEditor employee={current} onSaved={reload} />
    </div>
  )
}

function Secrets() {
  const api = useApi()
  const { employees, name } = useEmployees()
  const list = useLoad((a) => a.secrets(), [])
  const [form, setForm] = useState({ name: '', value: '', scope: 'global' as SecretScope['type'], id: '' })
  const scopeLabel = (s: SecretScope) =>
    s.type === 'global' ? 'global' : s.type === 'employee' ? `employee · ${name(s.id ?? '')}` : `${s.type} · ${s.id}`
  const add = async () => {
    const scope: SecretScope = form.scope === 'global' ? { type: 'global' } : { type: form.scope, id: form.id }
    await api.putSecret(form.name.trim(), form.value, scope)
    toast(`${form.name} saved`, { description: 'The value is write-only and never shown again.' })
    setForm({ ...form, name: '', value: '' })
    list.reload()
  }
  return (
    <div className="max-w-[760px]">
      <p className="mb-4 text-fg-tertiary">
        Secret values are injected into tool calls like environment variables. The model only sees names. Values can be written,
        never read back.
      </p>
      <div className="rounded-xl border" data-testid="secrets">
        {(list.data ?? []).map((s) => (
          <div
            key={`${s.name}-${s.scope.type}-${s.scope.id}`}
            className="flex h-10 items-center gap-3 border-b px-3 last:border-0"
          >
            <KeyRound className="size-3.5 text-fg-tertiary" />
            <span className="font-mono text-micro text-foreground">{s.name}</span>
            <span className="text-micro text-fg-tertiary">{scopeLabel(s.scope)}</span>
            <span className="ml-auto font-mono text-micro text-fg-quaternary">••••••••</span>
            <span className="w-28 text-right text-micro text-fg-quaternary">
              {s.lastUsedAt ? `used ${timeAgo(s.lastUsedAt)} ago` : 'never used'}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Delete ${s.name}`}
              onClick={async () => {
                await api.deleteSecret(s.name, s.scope)
                list.reload()
              }}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
      <SectionTitle className="mt-6 mb-2">Add or replace a secret</SectionTitle>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value.toUpperCase() })}
          placeholder="NAME"
          className="w-44 font-mono text-micro"
          aria-label="Secret name"
        />
        <select
          value={form.scope}
          onChange={(e) => setForm({ ...form, scope: e.target.value as SecretScope['type'], id: '' })}
          className="h-8 rounded-md border bg-transparent px-2 text-mini"
          aria-label="Scope"
        >
          <option value="global">global</option>
          <option value="employee">employee</option>
          <option value="project">project</option>
          <option value="tool">tool</option>
        </select>
        {form.scope === 'employee' ? (
          <select
            value={form.id}
            onChange={(e) => setForm({ ...form, id: e.target.value })}
            className="h-8 rounded-md border bg-transparent px-2 text-mini"
            aria-label="Employee"
          >
            <option value="">—</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.data.name}
              </option>
            ))}
          </select>
        ) : form.scope !== 'global' ? (
          <Input
            value={form.id}
            onChange={(e) => setForm({ ...form, id: e.target.value })}
            placeholder={form.scope === 'tool' ? 'tool name' : 'project id'}
            className="w-44 font-mono text-micro"
            aria-label="Scope id"
          />
        ) : null}
        <Input
          type="password"
          autoComplete="off"
          value={form.value}
          onChange={(e) => setForm({ ...form, value: e.target.value })}
          placeholder="Value"
          className="w-48"
          aria-label="Secret value"
        />
        <Button size="sm" onClick={add} disabled={!form.name.trim() || !form.value || (form.scope !== 'global' && !form.id)}>
          Save secret
        </Button>
      </div>
    </div>
  )
}

/** `source · type` of a trigger, from the API shape or the stored `match`. */
function triggerMatch(d: TriggerData): string {
  const m = (d as { match?: { source?: string; type?: string } }).match
  return `${d.source ?? m?.source ?? '*'} · ${d.type ?? m?.type ?? '*'}`
}

function Triggers() {
  const api = useApi()
  const list = useLoad((a) => a.listRecords<TriggerData>('trigger', { orderBy: 'name', dir: 'asc' }), [])
  const { name } = useEmployees()
  if (!list.data) return <LoadingRows />
  return (
    <div className="max-w-[760px] rounded-xl border">
      {list.data.items.map((t) => (
        <div key={t.id} className="flex h-11 items-center gap-3 border-b px-3 last:border-0">
          <Zap className={cn('size-3.5', t.data.enabled ? 'text-[var(--yellow)]' : 'text-fg-quaternary')} />
          <span className="min-w-0 truncate text-fg-secondary">{t.data.name}</span>
          <span className="hidden truncate font-mono text-micro text-fg-quaternary sm:inline">{triggerMatch(t.data)}</span>
          <span className="ml-auto text-micro text-fg-tertiary">{name(t.data.employeeId)}</span>
          <Switch
            checked={t.data.enabled}
            aria-label={`Enable ${t.data.name}`}
            onCheckedChange={async (v) => {
              await api.updateRecord('trigger', t.id, { enabled: v }, t.version)
              toast(`${t.data.name} ${v ? 'enabled' : 'disabled'}`)
              list.reload()
            }}
          />
        </div>
      ))}
    </div>
  )
}

function Limits() {
  const kinds = useLoad((a) => a.kinds(), [])
  const list = useLoad((a) => a.listRecords('limit'), [])
  const schema = kinds.data?.find((k) => k.kind === 'limit')
  if (!schema || !list.data) return <LoadingRows />
  if (!list.data.items.length) return <EmptyState text="No limits configured." />
  return (
    <div className="grid max-w-[900px] gap-4 lg:grid-cols-2">
      {list.data.items.map((l) => (
        <div key={l.id} className="rounded-xl border bg-card p-4">
          <div className="mb-3 font-medium">{String(l.data.name ?? l.id)}</div>
          <RecordPropertiesForm schema={schema} record={l} onSaved={list.reload} exclude={['name', 'scope']} />
        </div>
      ))}
      <p className="text-micro text-fg-quaternary lg:col-span-2">
        Reaching a limit pauses the work and asks the owner or requester whether to continue. It's never silently dropped.
      </p>
    </div>
  )
}

function Control() {
  const api = useApi()
  const state = useLoad((a) => a.control(), [])
  const paused = state.data?.paused ?? false
  return (
    <div className="max-w-[560px] rounded-xl border bg-card p-5" data-testid="kill-switch">
      <div className="flex items-center gap-2 text-title1 font-semibold">
        <Power className="size-4" /> Kill switch
      </div>
      <p className="mt-1 mb-4 text-fg-tertiary">
        Pauses every employee at once. Runs stop at their next step boundary; in-progress model calls and container jobs are
        aborted. Nothing is lost: resuming queues the runs again.
      </p>
      <div className="flex items-center gap-3">
        <Button
          variant={paused ? 'default' : 'destructive'}
          onClick={async () => {
            if (paused) await api.resumeAll()
            else await api.pauseAll()
            state.reload()
            toast(paused ? 'All employees resumed' : 'All employees paused')
          }}
        >
          {paused ? <CirclePlay /> : <CirclePause />}
          {paused ? 'Resume all employees' : 'Pause all employees'}
        </Button>
        <span className="text-micro text-fg-tertiary">
          {paused ? `Paused ${state.data?.pausedAt ? `${timeAgo(state.data.pausedAt)} ago` : ''}` : 'Everything is running'}
        </span>
      </div>
    </div>
  )
}

export function SettingsPage() {
  const { section = 'employees' } = useParams()
  return (
    <Page title="Settings" icon={<Settings />} className="flex flex-col md:flex-row">
      <nav
        className="flex shrink-0 flex-wrap gap-0.5 border-b p-2 md:block md:w-52 md:border-r md:border-b-0"
        aria-label="Settings"
      >
        {SECTIONS.map((s) => (
          <NavLink
            key={s.key}
            to={`/settings/${s.key}`}
            className={cn(
              'flex h-7 items-center gap-2 rounded-md px-2 text-fg-secondary hover:bg-secondary',
              section === s.key && 'bg-secondary text-foreground',
            )}
          >
            <s.icon className="size-4 text-fg-tertiary" />
            {s.label}
          </NavLink>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-auto px-4 py-6 md:px-8">
        <h2 className="mb-5 text-title2 font-semibold">{SECTIONS.find((s) => s.key === section)?.label}</h2>
        {section === 'employees' && <Employees />}
        {section === 'secrets' && <Secrets />}
        {section === 'triggers' && <Triggers />}
        {section === 'limits' && <Limits />}
        {section === 'control' && <Control />}
      </div>
    </Page>
  )
}
