import {
  ApiRequestError,
  MCP_OAUTH_QUERY,
  type McpEffect,
  type McpServerAuthInput,
  type McpServerInfo,
  type McpServerState,
  type McpServerTool,
} from '@mp/api'
import { ChevronDown, ChevronRight, Pencil, Plus, RefreshCw, Server, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { LoadingRows } from '@/components/empty.tsx'
import { SectionTitle } from '@/components/page.tsx'
import { StatusIcon } from '@/components/status-icon.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { useApi, useLoad } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'
import type { StatusKey } from '@/lib/status.ts'
import { cn } from '@/lib/utils.ts'

const STATE: Record<McpServerState, { label: string; icon: StatusKey; className: string }> = {
  connected: { label: 'Connected', icon: 'completed', className: 'text-fg-secondary' },
  connecting: { label: 'Connecting', icon: 'running', className: 'text-fg-tertiary' },
  needs_auth: { label: 'Needs sign-in', icon: 'paused', className: 'text-[var(--orange)]' },
  error: { label: 'Error', icon: 'failed', className: 'text-[var(--red)]' },
  disabled: { label: 'Disabled', icon: 'cancelled', className: 'text-fg-quaternary' },
}

const AUTH_LABEL = { none: 'No auth', token: 'Token', oauth: 'OAuth' } as const
const EFFECTS: McpEffect[] = ['read', 'idempotent', 'non_idempotent']

/** The message of an API error, with its validation issues. */
function errorText(e: unknown): { message: string; issues: string[] } {
  if (e instanceof ApiRequestError) {
    const issues = (e.details as { issues?: unknown } | undefined)?.issues
    return { message: e.message, issues: Array.isArray(issues) ? issues.map(String) : [] }
  }
  return { message: e instanceof Error ? e.message : String(e), issues: [] }
}

export interface McpServersProps {
  /** An employee's own servers; without it, the global ones (config servers included). */
  employeeId?: string
  /** Show the "MCP servers" heading (default true; Settings has its own). */
  heading?: boolean
  /** Opens an OAuth authorization URL. Default: same-origin paths navigate in the app, others load in the window. */
  openUrl?: (url: string) => void
}

/**
 * MCP servers the harness connects to, global or one employee's (admins only): status, tools,
 * OAuth connect, and a dialog to add or edit one. Token and client secret values are write-only.
 */
export function McpServers(props: McpServersProps) {
  const { can } = useAuth()
  if (!can('admin')) return null
  return <McpServersSection {...props} />
}

function McpServersSection({ employeeId, heading = true, openUrl }: McpServersProps) {
  const api = useApi()
  const navigate = useNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const list = useLoad((a) => a.mcpServers({ employeeId: employeeId ?? 'global' }), [employeeId])
  const [editing, setEditing] = useState<McpServerInfo | 'new' | null>(null)
  const [deleting, setDeleting] = useState<McpServerInfo | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})

  // Back from an OAuth sign-in: say how it went, and drop the query.
  const outcome = params.get(MCP_OAUTH_QUERY.status)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the outcome arrives
  useEffect(() => {
    if (!outcome) return
    const server = params.get(MCP_OAUTH_QUERY.server) ?? 'the server'
    if (outcome === 'connected') toast(`${server} connected`, { description: 'Its tools are available to new sessions.' })
    else toast.error(`Couldn't connect ${server}`, { description: params.get(MCP_OAUTH_QUERY.error) ?? 'The sign-in failed.' })
    const next = new URLSearchParams(params)
    for (const k of Object.values(MCP_OAUTH_QUERY)) next.delete(k)
    setParams(next, { replace: true })
    list.reload()
  }, [outcome])

  const run = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      list.reload()
    } catch (e) {
      toast.error(`${what} failed`, { description: errorText(e).message })
    }
  }

  const connect = (s: McpServerInfo) =>
    run(`Connecting ${s.name}`, async () => {
      const { authorizationUrl } = await api.startMcpOAuth(s.id, { returnTo: location.pathname })
      if (openUrl) openUrl(authorizationUrl)
      else if (authorizationUrl.startsWith('/') && !authorizationUrl.startsWith('//')) navigate(authorizationUrl)
      else window.location.assign(authorizationUrl)
    })

  const servers = list.data ?? []
  return (
    <section aria-label="MCP servers" className="max-w-[760px]" data-testid="mcp-servers">
      {heading && (
        <SectionTitle
          className="mb-2"
          actions={
            <Button size="xs" variant="ghost" onClick={() => setEditing('new')}>
              <Plus /> Add server
            </Button>
          }
        >
          MCP servers
        </SectionTitle>
      )}
      <p className="mb-4 text-fg-tertiary">
        {employeeId
          ? "This employee's own MCP servers: only its sessions see their tools."
          : 'MCP servers every employee can use. Tools appear as '}
        {!employeeId && <code className="font-mono text-micro">mcp.&lt;name&gt;.&lt;tool&gt;</code>}
        {!employeeId && '. Servers from MCP_SERVERS are read-only; stdio servers can only be set there.'} New tools reach new
        sessions; running ones keep their tool set.
      </p>
      {!list.data && !list.error && <LoadingRows rows={3} />}
      {list.error && <p className="mb-3 text-micro text-[var(--red)]">{errorText(list.error).message}</p>}
      {list.data && (
        <div className="rounded-xl border">
          {!servers.length && <div className="px-3 py-4 text-fg-tertiary">No MCP servers yet.</div>}
          {servers.map((s) => (
            <ServerRow
              key={s.id}
              server={s}
              expanded={!!open[s.id]}
              onToggle={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}
              onConnect={() => connect(s)}
              onReconnect={() =>
                run(`Reconnecting ${s.name}`, async () => {
                  const r = await api.reconnectMcpServer(s.id)
                  toast(`${s.name}: ${STATE[r.status.state].label.toLowerCase()}`)
                })
              }
              onDisconnect={() =>
                run(`Disconnecting ${s.name}`, async () => {
                  await api.disconnectMcpOAuth(s.id)
                  toast(`${s.name} disconnected`, { description: 'Its OAuth tokens were deleted.' })
                })
              }
              onEdit={() => setEditing(s)}
              onDelete={() => setDeleting(s)}
            />
          ))}
        </div>
      )}
      {!heading && (
        <div className="mt-3">
          <Button size="sm" variant="secondary" onClick={() => setEditing('new')}>
            <Plus /> Add server
          </Button>
        </div>
      )}
      {editing && (
        <ServerDialog
          server={editing === 'new' ? null : editing}
          employeeId={employeeId}
          onClose={() => setEditing(null)}
          onSaved={(s, created) => {
            setEditing(null)
            list.reload()
            toast(created ? `${s.name} added` : `${s.name} saved`)
            if (created && s.auth.type === 'oauth') void connect(s)
          }}
        />
      )}
      <Dialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleting?.name}?</DialogTitle>
            <DialogDescription>
              Its tools go away, and the secrets the harness generated for it (token, OAuth credentials) are deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const s = deleting!
                setDeleting(null)
                void run(`Deleting ${s.name}`, async () => {
                  await api.deleteMcpServer(s.id)
                  toast(`${s.name} deleted`)
                })
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function ServerRow({
  server: s,
  expanded,
  onToggle,
  onConnect,
  onReconnect,
  onDisconnect,
  onEdit,
  onDelete,
}: {
  server: McpServerInfo
  expanded: boolean
  onToggle(): void
  onConnect(): void
  onReconnect(): void
  onDisconnect(): void
  onEdit(): void
  onDelete(): void
}) {
  const st = STATE[s.status.state]
  const config = s.source === 'config'
  const oauth = s.auth.type === 'oauth' ? s.auth : null
  const needsConnect = !!oauth && (s.status.state === 'needs_auth' || !oauth.hasTokens)
  return (
    <div className="border-b last:border-0" data-testid={`mcp-server-${s.name}`}>
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Hide' : 'Show'} tools of ${s.name}`}
          className="flex items-center gap-2 text-left"
        >
          {expanded ? (
            <ChevronDown className="size-3.5 text-fg-quaternary" />
          ) : (
            <ChevronRight className="size-3.5 text-fg-quaternary" />
          )}
          <StatusIcon status={st.icon} tooltip={false} className="size-3.5" />
          <span className="font-mono text-micro text-foreground">{s.name}</span>
        </button>
        {config && <Badge variant="secondary">config</Badge>}
        <Badge variant="outline">{AUTH_LABEL[s.auth.type]}</Badge>
        <span className="hidden min-w-0 flex-1 truncate font-mono text-micro text-fg-quaternary sm:inline">
          {s.url ?? s.transport}
        </span>
        <span className={cn('ml-auto text-micro', st.className)} data-testid="mcp-status">
          {st.label}
        </span>
        <span className="w-14 text-right text-micro text-fg-tertiary">
          {s.status.toolCount} {s.status.toolCount === 1 ? 'tool' : 'tools'}
        </span>
        {!config && (
          <span className="flex items-center gap-0.5">
            {needsConnect && (
              <Button size="xs" onClick={onConnect}>
                Connect
              </Button>
            )}
            {oauth?.hasTokens && (
              <Button size="xs" variant="ghost" onClick={onDisconnect}>
                Disconnect
              </Button>
            )}
            <Button variant="ghost" size="icon-xs" aria-label={`Reconnect ${s.name}`} onClick={onReconnect}>
              <RefreshCw />
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label={`Edit ${s.name}`} onClick={onEdit}>
              <Pencil />
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label={`Delete ${s.name}`} onClick={onDelete}>
              <Trash2 />
            </Button>
          </span>
        )}
      </div>
      {s.status.error && (s.status.state === 'error' || s.status.state === 'needs_auth') && (
        <p className="px-3 pb-2 pl-[3.25rem] text-micro text-fg-tertiary">{s.status.error}</p>
      )}
      {expanded && <ToolList id={s.id} />}
    </div>
  )
}

function ToolList({ id }: { id: string }) {
  const tools = useLoad((a) => a.mcpServerTools(id), [id])
  if (!tools.data) return <div className="px-3 pb-2 pl-[3.25rem] text-micro text-fg-quaternary">Loading tools…</div>
  if (!tools.data.length)
    return <div className="px-3 pb-2 pl-[3.25rem] text-micro text-fg-quaternary">No tools while it isn't connected.</div>
  return (
    <ul className="px-3 pb-2 pl-[3.25rem]" aria-label="Tools">
      {tools.data.map((t: McpServerTool) => (
        <li key={t.toolName} className="flex h-6 items-center gap-3 text-micro">
          <span className="font-mono text-fg-secondary">{t.toolName}</span>
          <span className="min-w-0 truncate text-fg-quaternary">{t.description}</span>
          <span className="ml-auto text-fg-quaternary">{t.effect.replace('_', '-')}</span>
        </li>
      ))}
    </ul>
  )
}

function Row({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid items-start gap-1 sm:grid-cols-[130px_1fr] sm:gap-3">
      <label htmlFor={id} className="pt-1.5">
        <span className="block text-mini text-fg-secondary">{label}</span>
        {hint && <span className="block text-micro text-fg-quaternary">{hint}</span>}
      </label>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

const selectClass = 'h-8 rounded-md border bg-transparent px-2 text-mini'

/** Add or edit a server. Secret values start empty; on edit, leaving them empty keeps the current ones. */
function ServerDialog({
  server,
  employeeId,
  onClose,
  onSaved,
}: {
  server: McpServerInfo | null
  employeeId: string | undefined
  onClose(): void
  onSaved(s: McpServerInfo, created: boolean): void
}) {
  const api = useApi()
  const a = server?.auth
  const [name, setName] = useState(server?.name ?? '')
  const [url, setUrl] = useState(server?.url ?? '')
  const [enabled, setEnabled] = useState(server?.enabled ?? true)
  const [effect, setEffect] = useState<McpEffect | ''>(server?.effect ?? '')
  const [headers, setHeaders] = useState<{ k: string; v: string }[]>(
    Object.entries(server?.headers ?? {}).map(([k, v]) => ({ k, v })),
  )
  const [authType, setAuthType] = useState<McpServerAuthInput['type']>(a?.type ?? 'none')
  const [token, setToken] = useState('')
  const [header, setHeader] = useState(a?.type === 'token' ? a.header : 'Authorization')
  const [prefix, setPrefix] = useState(a?.type === 'token' ? a.prefix : 'Bearer ')
  const [secret, setSecret] = useState(a?.type === 'token' ? a.secret : '')
  const [scopes, setScopes] = useState(a?.type === 'oauth' ? (a.scopes ?? []).join(' ') : '')
  const [clientId, setClientId] = useState(a?.type === 'oauth' ? (a.clientId ?? '') : '')
  const [clientSecret, setClientSecret] = useState('')
  const [authServer, setAuthServer] = useState(a?.type === 'oauth' ? (a.authorizationServer ?? '') : '')
  const [error, setError] = useState<{ message: string; issues: string[] } | null>(null)
  const [saving, setSaving] = useState(false)
  const editing = !!server

  const auth = (): McpServerAuthInput => {
    if (authType === 'token')
      return {
        type: 'token',
        header: header.trim() || 'Authorization',
        prefix,
        ...(secret.trim() ? { secret: secret.trim() } : {}),
        ...(token ? { token } : {}),
      }
    if (authType === 'oauth') {
      const list = scopes
        .split(/[\s,]+/)
        .map((x) => x.trim())
        .filter(Boolean)
      return {
        type: 'oauth',
        ...(list.length ? { scopes: list } : {}),
        ...(clientId.trim() ? { clientId: clientId.trim() } : {}),
        ...(clientSecret ? { clientSecret } : {}),
        ...(authServer.trim() ? { authorizationServer: authServer.trim() } : {}),
      }
    }
    return { type: 'none' }
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    const hdrs = Object.fromEntries(headers.filter((h) => h.k.trim()).map((h) => [h.k.trim(), h.v]))
    try {
      const saved = editing
        ? await api.updateMcpServer(server.id, {
            url: url.trim(),
            headers: hdrs,
            enabled,
            effect: effect || null,
            auth: auth(),
            ...(server.version !== undefined ? { version: server.version } : {}),
          })
        : await api.createMcpServer({
            name: name.trim(),
            url: url.trim(),
            ...(Object.keys(hdrs).length ? { headers: hdrs } : {}),
            employeeId: employeeId ?? null,
            enabled,
            ...(effect ? { effect } : {}),
            auth: auth(),
          })
      onSaved(saved, !editing)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  const hadToken = a?.type === 'token' && a.hasToken
  const hadClientSecret = a?.type === 'oauth' && !!a.clientSecretSecret
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-auto sm:max-w-xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-title1">
            <Server className="size-4 text-fg-tertiary" />
            {editing ? `Edit ${server.name}` : 'Add an MCP server'}
          </DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Row id="mcp-name" label="Name" hint={editing ? "Can't change" : 'Tools are mcp.<name>.*'}>
            <Input
              id="mcp-name"
              value={name}
              disabled={editing}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              placeholder="docs"
              className="font-mono text-micro"
            />
          </Row>
          <Row id="mcp-url" label="URL" hint="Streamable HTTP">
            <Input
              id="mcp-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp.example.com/mcp"
              className="font-mono text-micro"
            />
          </Row>
          <Row id="mcp-enabled" label="Enabled">
            <Switch id="mcp-enabled" checked={enabled} onCheckedChange={setEnabled} className="mt-1.5" />
          </Row>
          <Row id="mcp-effect" label="Effect" hint="Of its tools, for crash recovery">
            <select
              id="mcp-effect"
              value={effect}
              onChange={(e) => setEffect(e.target.value as McpEffect | '')}
              className={selectClass}
            >
              <option value="">default (non-idempotent)</option>
              {EFFECTS.map((x) => (
                <option key={x} value={x}>
                  {x.replace('_', '-')}
                </option>
              ))}
            </select>
          </Row>
          <Row id="mcp-header-0" label="Headers" hint="Not secret">
            <div className="grid gap-1.5">
              {headers.map((h, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
                <div key={i} className="flex items-center gap-1.5">
                  <Input
                    id={`mcp-header-${i}`}
                    aria-label={`Header ${i + 1} name`}
                    value={h.k}
                    onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))}
                    placeholder="X-Team"
                    className="w-40 font-mono text-micro"
                  />
                  <Input
                    aria-label={`Header ${i + 1} value`}
                    value={h.v}
                    onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
                    className="font-mono text-micro"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove header ${i + 1}`}
                    onClick={() => setHeaders(headers.filter((_, j) => j !== i))}
                  >
                    <X />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="w-fit"
                onClick={() => setHeaders([...headers, { k: '', v: '' }])}
              >
                <Plus /> Add header
              </Button>
            </div>
          </Row>
          <Row id="mcp-auth" label="Authentication">
            <div className="flex gap-1" role="radiogroup" aria-label="Authentication" id="mcp-auth">
              {(['none', 'token', 'oauth'] as const).map((t) => (
                <Button
                  key={t}
                  type="button"
                  size="xs"
                  role="radio"
                  aria-checked={authType === t}
                  variant={authType === t ? 'secondary' : 'ghost'}
                  onClick={() => setAuthType(t)}
                >
                  {t === 'none' ? 'None' : AUTH_LABEL[t]}
                </Button>
              ))}
            </div>
          </Row>
          {authType === 'token' && (
            <>
              <Row
                id="mcp-token"
                label="Token"
                hint={hadToken ? 'Leave empty to keep the current token' : 'Stored as a secret, never shown again'}
              >
                <Input
                  id="mcp-token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={hadToken ? '••••••••' : ''}
                />
              </Row>
              <Row id="mcp-token-header" label="Header">
                <div className="flex gap-1.5">
                  <Input
                    id="mcp-token-header"
                    value={header}
                    onChange={(e) => setHeader(e.target.value)}
                    className="w-40 font-mono text-micro"
                  />
                  <Input
                    aria-label="Prefix"
                    value={prefix}
                    onChange={(e) => setPrefix(e.target.value)}
                    placeholder="no prefix"
                    className="w-28 font-mono text-micro"
                  />
                </div>
              </Row>
              <Row id="mcp-token-secret" label="Secret name" hint="Optional: an existing secret instead">
                <Input
                  id="mcp-token-secret"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value.toUpperCase())}
                  placeholder={name ? `MCP_${name.toUpperCase().replace(/-/g, '_')}_TOKEN` : 'MCP_<NAME>_TOKEN'}
                  className="font-mono text-micro"
                />
              </Row>
            </>
          )}
          {authType === 'oauth' && (
            <>
              <Row id="mcp-scopes" label="Scopes" hint="Space or comma separated; default: what the server offers">
                <Input
                  id="mcp-scopes"
                  value={scopes}
                  onChange={(e) => setScopes(e.target.value)}
                  className="font-mono text-micro"
                />
              </Row>
              <Row id="mcp-client-id" label="Client id" hint="Optional: registers itself without one">
                <Input
                  id="mcp-client-id"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  className="font-mono text-micro"
                />
              </Row>
              <Row
                id="mcp-client-secret"
                label="Client secret"
                hint={hadClientSecret ? 'Leave empty to keep the current one' : undefined}
              >
                <Input
                  id="mcp-client-secret"
                  type="password"
                  autoComplete="off"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={hadClientSecret ? '••••••••' : ''}
                />
              </Row>
              <Row id="mcp-auth-server" label="Authorization server" hint="Optional: normally discovered">
                <Input
                  id="mcp-auth-server"
                  value={authServer}
                  onChange={(e) => setAuthServer(e.target.value)}
                  placeholder="https://auth.example.com"
                  className="font-mono text-micro"
                />
              </Row>
              {!editing && <p className="text-micro text-fg-tertiary">After adding it, you sign in to the server once.</p>}
            </>
          )}
          {error && (
            <div role="alert" className="rounded-md border border-[var(--red)]/40 bg-[var(--red)]/10 px-3 py-2 text-micro">
              <div className="text-foreground">{error.message}</div>
              {error.issues.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-fg-secondary">
                  {error.issues.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim() || !url.trim()}>
              {editing ? 'Save' : authType === 'oauth' ? 'Add and connect' : 'Add server'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
