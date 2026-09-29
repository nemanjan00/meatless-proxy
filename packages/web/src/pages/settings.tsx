import type { Access, ApiRecord, ContactData, CreatedApiToken, EmployeeData, SecretScope, TriggerData } from '@mp/api'
import {
  CirclePause,
  CirclePlay,
  Copy,
  Gauge,
  KeyRound,
  Link2,
  Plug,
  Power,
  Server,
  Settings,
  Ticket,
  Trash2,
  UserCog,
  Users,
  Zap,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { EmptyState, LoadingRows } from '@/components/empty.tsx'
import { Page, SectionTitle } from '@/components/page.tsx'
import { StatusIcon } from '@/components/status-icon.tsx'
import { EmployeeAvatar, PersonAvatar } from '@/components/people.tsx'
import { NewEmployeeButton } from '@/components/new-employee-dialog.tsx'
import { RecordPropertiesForm } from '@/components/record-form.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { useApi, useLiveReload, useLoad } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'
import { useEmployees } from '@/lib/employees.tsx'
import { timeAgo } from '@/lib/format.ts'
import { cn } from '@/lib/utils.ts'
import { McpServers } from '@/components/mcp-servers.tsx'

/** Settings sections; `admin` ones are hidden from everyone else (the server refuses them anyway). */
const SECTIONS = [
  { key: 'employees', label: 'Employees', icon: Users, admin: true },
  { key: 'secrets', label: 'Secrets', icon: KeyRound, admin: true },
  { key: 'integrations', label: 'Integrations', icon: Plug, admin: true },
  { key: 'mcp', label: 'MCP servers', icon: Server, admin: true },
  { key: 'triggers', label: 'Triggers', icon: Zap, admin: true },
  { key: 'limits', label: 'Limits', icon: Gauge, admin: true },
  { key: 'control', label: 'Kill switch', icon: Power, admin: true },
  { key: 'people', label: 'People and access', icon: UserCog, admin: true },
  { key: 'tokens', label: 'API tokens', icon: Ticket, admin: false },
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
        <Button asChild size="sm" variant="outline" className="ml-auto">
          <NavLink to={`/employees/${employee.id}`}>Integrations and SSH key</NavLink>
        </Button>
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
  const [params] = useSearchParams()
  const [sel, setSel] = useState<string | null>(() => params.get('employee'))
  const current = employees.find((e) => e.id === sel) ?? employees[0]
  if (!current) return <LoadingRows />
  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <div className="flex shrink-0 flex-col md:w-48">
        <div className="mb-2">
          <NewEmployeeButton />
        </div>
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

/** The first-party integrations, in the order the employee page shows them (docs/spec.md#integrations). */
const INTEGRATIONS = [
  { name: 'slack', label: 'Slack' },
  { name: 'gitlab', label: 'GitLab' },
  { name: 'linear', label: 'Linear' },
] as const

/**
 * An overview: per employee, which integrations have a token and a webhook secret, and whether
 * the GitLab webhooks the harness registered work. Setting them up happens on the employee page.
 */
function Integrations() {
  const status = useLoad((a) => a.integrationsStatus(), [])
  useLiveReload(['records:gitlab_hook', 'records:secret'], status.reload)
  const d = status.data
  if (status.error && !d) return <EmptyState text={`Couldn't load the status: ${status.error.message}`} />
  if (!d) return <LoadingRows />
  return (
    <div className="max-w-[760px]" data-testid="integrations-overview">
      <p className="mb-4 text-fg-tertiary">
        Each employee connects Slack, GitLab and Linear as its own account, with a guided setup on its page that checks every
        step. GitLab webhooks register themselves{' '}
        {d.gitlabHooks.enabled ? (
          <>
            with {d.gitlabHooks.provisioningToken ? 'the provisioning token' : 'each employee’s own token'}
            {d.gitlabHooks.provisioningToken ? '' : ' (set GITLAB_HOOKS_TOKEN to keep service accounts at Developer)'}.
          </>
        ) : (
          <>once {d.gitlabHooks.reason ?? 'provisioning is on'}.</>
        )}
      </p>
      <div className="overflow-hidden rounded-xl border">
        <div className="grid h-8 grid-cols-[1fr_repeat(3,6.5rem)_5rem] items-center gap-2 border-b bg-level-1 px-3 text-micro text-fg-tertiary">
          <span>Employee</span>
          {INTEGRATIONS.map((i) => (
            <span key={i.name}>{i.label}</span>
          ))}
          <span />
        </div>
        {d.employees.map((e) => {
          const failed = e.gitlabHooks.filter((h) => h.status === 'error')
          return (
            <div key={e.id} className="border-b last:border-0" data-testid="integrations-row">
              <div className="grid h-9 grid-cols-[1fr_repeat(3,6.5rem)_5rem] items-center gap-2 px-3">
                <NavLink
                  to={`/employees/${e.id}`}
                  className="flex min-w-0 items-center gap-2 text-fg-secondary hover:text-foreground"
                >
                  <EmployeeAvatar name={e.name} className="size-4" />
                  <span className="truncate">{e.name}</span>
                </NavLink>
                {INTEGRATIONS.map((i) => {
                  const on = e.integrations[i.name]
                  const enabled = d.enabled.includes(i.name)
                  return (
                    <NavLink
                      key={i.name}
                      to={`/employees/${e.id}?setup=${i.name}`}
                      className="flex items-center gap-1.5 text-micro text-fg-tertiary hover:text-foreground"
                      title={
                        on
                          ? `token ${on.token ? 'set' : 'missing'} · webhook secret ${on.webhookSecret ? 'set' : 'missing'}`
                          : 'disabled'
                      }
                    >
                      <StatusIcon
                        status={!enabled || !on?.token ? 'queued' : on.webhookSecret ? 'completed' : 'paused'}
                        tooltip={false}
                        className="size-3.5"
                      />
                      {!enabled ? 'disabled' : !on?.token ? 'not set up' : on.webhookSecret ? 'connected' : 'no webhook'}
                    </NavLink>
                  )
                })}
                <NavLink to={`/employees/${e.id}`} className="justify-self-end text-micro text-[#828fff] hover:underline">
                  Set up
                </NavLink>
              </div>
              {failed.length > 0 && (
                <p className="px-3 pb-2 pl-9 text-micro text-[var(--status-failed)]">
                  {failed.length} GitLab webhook{failed.length === 1 ? '' : 's'} failed: {failed[0]!.gitlabProject}:{' '}
                  {failed[0]!.error}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

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

const copy = async (text: string, what: string) => {
  try {
    await navigator.clipboard.writeText(text)
    toast(`${what} copied`)
  } catch {
    toast(`Couldn't copy the ${what.toLowerCase()}`, { description: 'Select it and copy it by hand.' })
  }
}

/** Your API tokens: for scripts and agents, on `/api`, `/ws` and `/mcp`. A new token is shown once. */
function Tokens() {
  const api = useApi()
  const list = useLoad((a) => a.listTokens(), [])
  const [name, setName] = useState('')
  const [created, setCreated] = useState<CreatedApiToken | null>(null)
  const create = async () => {
    const t = await api.createToken(name.trim() ? { name: name.trim() } : {})
    setCreated(t)
    setName('')
    list.reload()
  }
  const tokens = list.data ?? []
  return (
    <div className="max-w-[760px]" data-testid="tokens">
      <p className="mb-4 text-fg-tertiary">
        A token acts as you, with your access, for scripts and other agents: send it as{' '}
        <code className="font-mono text-micro">Authorization: Bearer …</code>. The same token works for the API, the live socket
        and the MCP server at <code className="font-mono text-micro">/mcp</code>.
      </p>
      {created && (
        <div className="mb-4 rounded-xl border border-brand/50 bg-brand/10 p-3" role="status">
          <div className="mb-2 text-mini text-foreground">
            New token{created.name ? ` “${created.name}”` : ''}: copy it now, it won't be shown again.
          </div>
          <div className="flex items-center gap-2">
            <code
              className="min-w-0 flex-1 truncate rounded-md border bg-background px-2 py-1 font-mono text-micro"
              data-testid="new-token"
            >
              {created.token}
            </code>
            <Button size="sm" variant="secondary" onClick={() => copy(created.token, 'Token')}>
              <Copy /> Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        </div>
      )}
      <div className="rounded-xl border">
        {!tokens.length && <div className="px-3 py-4 text-fg-tertiary">No tokens yet.</div>}
        {tokens.map((t) => (
          <div key={t.id} className="flex h-10 items-center gap-3 border-b px-3 last:border-0">
            <Ticket className={cn('size-3.5', t.revoked ? 'text-fg-quaternary' : 'text-fg-tertiary')} />
            <span className={cn('min-w-0 truncate', t.revoked ? 'text-fg-quaternary line-through' : 'text-fg-secondary')}>
              {t.name ?? 'Unnamed token'}
            </span>
            <span className="font-mono text-micro text-fg-quaternary">{t.id}</span>
            <span className="ml-auto text-micro text-fg-quaternary">
              {t.revoked
                ? 'revoked'
                : timeAgo(t.createdAt) === 'now'
                  ? 'created just now'
                  : `created ${timeAgo(t.createdAt)} ago`}
            </span>
            {!t.revoked && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Revoke ${t.name ?? t.id}`}
                onClick={async () => {
                  await api.revokeToken(t.id)
                  toast(`${t.name ?? 'Token'} revoked`, { description: 'It stops working right away.' })
                  list.reload()
                }}
              >
                Revoke
              </Button>
            )}
          </div>
        ))}
      </div>
      <SectionTitle className="mt-6 mb-2">New token</SectionTitle>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="What it's for, e.g. laptop"
          className="w-64"
          aria-label="Token name"
          onKeyDown={(e) => {
            if (e.key === 'Enter') create()
          }}
        />
        <Button size="sm" onClick={create}>
          Create token
        </Button>
      </div>
    </div>
  )
}

const ACCESS: Access[] = ['viewer', 'member', 'admin']

/** People's access, and one-time sign-in links to hand out (admins). */
function People() {
  const api = useApi()
  const list = useLoad(
    (a) =>
      a.listRecords<ContactData & { access?: Access }>('contact', {
        where: { kind: 'person' },
        orderBy: 'name',
        dir: 'asc',
        limit: 500,
      }),
    [],
  )
  const [link, setLink] = useState<{ name: string; url: string } | null>(null)
  if (!list.data) return <LoadingRows />
  return (
    <div className="max-w-[760px]" data-testid="people">
      <p className="mb-4 text-fg-tertiary">
        Viewers read, members also chat, steer their own work and edit knowledge, admins manage everything here. A sign-in link
        works once, for 15 minutes. AI employees never sign in.
      </p>
      {link && (
        <div className="mb-4 rounded-xl border border-brand/50 bg-brand/10 p-3" role="status">
          <div className="mb-2 text-mini text-foreground">Sign-in link for {link.name}: send it to them privately.</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-background px-2 py-1 font-mono text-micro">
              {link.url}
            </code>
            <Button size="sm" variant="secondary" onClick={() => copy(link.url, 'Link')}>
              <Copy /> Copy
            </Button>
          </div>
        </div>
      )}
      <div className="rounded-xl border">
        {list.data.items.map((c) => (
          <div key={c.id} className="flex h-11 items-center gap-3 border-b px-3 last:border-0">
            <PersonAvatar name={c.data.name} className="size-5" />
            <span className="min-w-0 truncate text-fg-secondary">{c.data.name}</span>
            <span className="hidden truncate text-micro text-fg-quaternary sm:inline">{c.data.email}</span>
            <select
              value={c.data.access ?? 'viewer'}
              aria-label={`Access of ${c.data.name}`}
              className="ml-auto h-7 rounded-md border bg-transparent px-2 text-mini"
              onChange={async (e) => {
                await api.updateRecord('contact', c.id, { access: e.target.value }, c.version)
                toast(`${c.data.name} is now a ${e.target.value}`)
                list.reload()
              }}
            >
              {ACCESS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Sign-in link for ${c.data.name}`}
              onClick={async () => {
                const l = await api.createLoginLink({ contactId: c.id })
                setLink({ name: c.data.name, url: l.url })
              }}
            >
              <Link2 /> Sign-in link
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

export function SettingsPage() {
  const { can } = useAuth()
  const admin = can('admin')
  const sections = SECTIONS.filter((s) => admin || !s.admin)
  const { section = sections[0]!.key } = useParams()
  const current = SECTIONS.find((s) => s.key === section)
  const allowed = !!current && (admin || !current.admin)
  return (
    <Page title="Settings" icon={<Settings />} className="flex flex-col md:flex-row">
      <nav
        className="flex shrink-0 flex-wrap gap-0.5 border-b p-2 md:block md:w-52 md:border-r md:border-b-0"
        aria-label="Settings"
      >
        {sections.map((s) => (
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
        <h2 className="mb-5 text-title2 font-semibold">{current?.label}</h2>
        {!allowed && <EmptyState text="Only admins can see this." />}
        {allowed && section === 'employees' && <Employees />}
        {allowed && section === 'secrets' && <Secrets />}
        {allowed && section === 'integrations' && <Integrations />}
        {allowed && section === 'mcp' && <McpServers heading={false} />}
        {allowed && section === 'triggers' && <Triggers />}
        {allowed && section === 'limits' && <Limits />}
        {allowed && section === 'control' && <Control />}
        {allowed && section === 'people' && <People />}
        {allowed && section === 'tokens' && <Tokens />}
      </div>
    </Page>
  )
}
