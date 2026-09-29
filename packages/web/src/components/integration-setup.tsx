import type { EmployeeIntegrations, IntegrationSetupStatus, SetupStep, SetupStepStatus } from '@mp/api'
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  GitMerge,
  type LucideIcon,
  MessagesSquare,
  RefreshCw,
  SquareKanban,
} from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { CopyButton, CopyField } from '@/components/copy.tsx'
import { ErrorState, LoadingRows } from '@/components/empty.tsx'
import { GitlabProjects } from '@/components/gitlab-projects.tsx'
import { SectionTitle } from '@/components/page.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet.tsx'
import { useApi, useLoad } from '@/lib/api.tsx'
import { agoPhrase } from '@/lib/format.ts'
import { HOW_INTEGRATIONS_WORK, INTEGRATION_DOCS } from '@/lib/setup-docs.ts'
import { cn } from '@/lib/utils.ts'

const ICON: Record<string, LucideIcon> = { slack: MessagesSquare, gitlab: GitMerge, linear: SquareKanban }

const STEP_ICON: Record<SetupStepStatus, { icon: LucideIcon; color: string; label: string }> = {
  done: { icon: CircleCheck, color: 'var(--green)', label: 'Done' },
  todo: { icon: CircleDashed, color: 'var(--fg-quaternary)', label: 'To do' },
  warning: { icon: CircleAlert, color: 'var(--orange)', label: 'Needs attention' },
  error: { icon: CircleX, color: 'var(--red)', label: 'Failed' },
}

const STATE: Record<IntegrationSetupStatus['state'], { label: string; color: string }> = {
  not_set_up: { label: 'Not set up', color: 'var(--fg-quaternary)' },
  needs_attention: { label: 'Needs attention', color: 'var(--orange)' },
  connected: { label: 'Connected', color: 'var(--green)' },
}

/** A setup step's status icon (checks from the server, never self-reported). */
export function StepIcon({ status, className }: { status: SetupStepStatus; className?: string }) {
  const s = STEP_ICON[status]
  return (
    <s.icon
      role="img"
      aria-label={s.label}
      data-status={status}
      className={cn('size-4 shrink-0', className)}
      style={{ color: s.color }}
      strokeWidth={1.75}
    />
  )
}

/** "Connected", "Needs attention" or "Not set up", with a coloured dot. */
export function StateLabel({ state }: { state: IntegrationSetupStatus['state'] }) {
  const s = STATE[state]
  return (
    <span className="inline-flex items-center gap-1.5 text-micro text-fg-secondary" data-state={state}>
      <span className="size-1.5 rounded-full" style={{ background: s.color }} />
      {s.label}
    </span>
  )
}

/** Paragraph text with `code` spans. */
function Prose({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g)
  return (
    <p className="text-fg-tertiary">
      {parts.map((p, i) =>
        p.startsWith('`') && p.endsWith('`') ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static text parts
          <code key={i} className="rounded bg-level-3 px-1 py-px font-mono text-micro text-fg-secondary">
            {p.slice(1, -1)}
          </code>
        ) : (
          p
        ),
      )}
    </p>
  )
}

function ExternalButton({ href, children, primary = false }: { href: string; children: ReactNode; primary?: boolean }) {
  return (
    <Button asChild size="sm" variant={primary ? 'default' : 'outline'}>
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
        <ExternalLink className="size-3.5" />
      </a>
    </Button>
  )
}

const str = (v: unknown) => (typeof v === 'string' ? v : null)

/** A step's extra content: what to copy, lists, links. Keyed by integration and step id. */
function StepExtras({ integration, step, all }: { integration: string; step: SetupStep; all: SetupStep[] }) {
  const d = (step.data ?? {}) as Record<string, any>
  const key = `${integration}.${step.id}`
  switch (key) {
    case 'slack.app':
      return (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            {str(d.createUrl) && (
              <ExternalButton href={d.createUrl} primary={step.status !== 'done'}>
                Create Slack app
              </ExternalButton>
            )}
          </div>
          {str(d.requestUrl) && (
            <Labeled label="Request URL">{<CopyField value={d.requestUrl} label="Copy request URL" />}</Labeled>
          )}
        </div>
      )
    case 'slack.tokens':
      return d.botUser ? (
        <Facts
          rows={[
            ['Bot', `@${d.botUser}`],
            [
              'Workspace',
              d.teamUrl ? (
                <Link key="team" href={d.teamUrl}>
                  {d.team}
                </Link>
              ) : (
                d.team
              ),
            ],
            ...(d.missingScopes?.length ? ([['Missing scopes', d.missingScopes.join(', ')]] as [string, ReactNode][]) : []),
          ]}
        />
      ) : null
    case 'slack.events':
      return (
        <div className="flex flex-col gap-2">
          {str(d.lastAt) && <Facts rows={[['Last request', agoPhrase(d.lastAt)]]} />}
          {str(d.requestUrl) && step.status !== 'done' && <CopyField value={d.requestUrl} label="Copy request URL" />}
        </div>
      )
    case 'slack.interactivity':
      return (
        <div className="flex flex-col gap-2">
          {str(d.lastAt) && <Facts rows={[['Last request', agoPhrase(d.lastAt)]]} />}
          {str(d.interactivityUrl) && step.status !== 'done' && (
            <Labeled label="Interactivity Request URL">
              <CopyField value={d.interactivityUrl} label="Copy interactivity request URL" />
            </Labeled>
          )}
        </div>
      )
    case 'slack.channels':
      return (
        <div className="flex flex-col gap-2">
          {Array.isArray(d.channels) && d.channels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {d.channels.map((c: { id: string; name: string; private: boolean }) => (
                <span key={c.id} className="rounded bg-level-3 px-1.5 py-0.5 text-micro text-fg-secondary">
                  {c.private ? '🔒 ' : '#'}
                  {c.name}
                </span>
              ))}
            </div>
          )}
          {str(d.invite) && <CopyField value={d.invite} label="Copy invite command" />}
        </div>
      )
    case 'gitlab.instance':
      return str(d.baseUrl) ? (
        <Facts
          rows={[
            [
              'URL',
              <Link key="u" href={d.baseUrl}>
                {d.baseUrl}
              </Link>,
            ],
          ]}
        />
      ) : null
    case 'gitlab.account': {
      const inst = (all.find((x) => x.id === 'instance')?.data ?? {}) as Record<string, any>
      return (
        <div className="flex flex-col gap-2">
          {d.username && (
            <div className="flex items-center gap-2">
              {d.avatarUrl && <img src={d.avatarUrl} alt="" className="size-5 rounded-full" />}
              <span className="text-fg-secondary">
                {d.webUrl ? <Link href={d.webUrl}>@{d.username}</Link> : `@${d.username}`}
              </span>
              {d.name && <span className="text-fg-tertiary">{d.name}</span>}
            </div>
          )}
          {step.status !== 'done' && (
            <div className="flex flex-wrap gap-2">
              {str(inst.adminUsersUrl) && <ExternalButton href={inst.adminUsersUrl}>New user</ExternalButton>}
              {str(inst.serviceAccountsDocs) && <ExternalButton href={inst.serviceAccountsDocs}>Service accounts</ExternalButton>}
            </div>
          )}
          <p className="text-micro text-fg-quaternary">
            Service accounts need GitLab Premium or Ultimate; otherwise use a dedicated user.
          </p>
        </div>
      )
    }
    case 'gitlab.token': {
      const base = str(all.find((x) => x.id === 'instance')?.data?.baseUrl) ?? 'https://gitlab.com'
      return (
        <div className="flex flex-col gap-2">
          {Array.isArray(d.scopes) && (
            <Facts
              rows={[
                ['Scopes', d.scopes.join(', ') || 'none'],
                ...(d.expiresAt ? ([['Expires', d.expiresAt]] as [string, ReactNode][]) : []),
              ]}
            />
          )}
          {step.status === 'todo' && (
            <div>
              <ExternalButton href={`${base}/-/user_settings/personal_access_tokens`}>Access tokens</ExternalButton>
            </div>
          )}
        </div>
      )
    }
    case 'gitlab.ssh-key':
      return str(d.publicKey) ? (
        <div className="flex flex-col gap-2">
          <CopyField value={d.publicKey} label="Copy public key" multiline />
          <Facts
            rows={[
              [
                'Fingerprint',
                <code key="f" className="font-mono text-micro">
                  {d.fingerprint}
                </code>,
              ],
              ['Title', d.title],
            ]}
          />
        </div>
      ) : null
    case 'gitlab.projects':
      // With its "Add as project" buttons: rendered by StepItem (GitlabProjects), which can act.
      return null
    case 'gitlab.webhooks':
      return (
        <div className="flex flex-col gap-2">
          {Array.isArray(d.hooks) && d.hooks.length > 0 && (
            <div className="overflow-hidden rounded-md border">
              {d.hooks.map((h: { project: string; status: string; error: string | null; lastReceivedAt: string | null }) => (
                <div key={h.project} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-b-0">
                  <StepIcon status={h.status === 'ok' ? 'done' : 'error'} className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate font-mono text-micro text-fg-secondary" title={h.error ?? undefined}>
                    {h.project}
                  </span>
                  <span className="shrink-0 text-micro text-fg-quaternary">
                    {h.error ? 'failed' : h.lastReceivedAt ? `last event ${agoPhrase(h.lastReceivedAt)}` : 'no events yet'}
                  </span>
                </div>
              ))}
            </div>
          )}
          {str(d.url) && <Labeled label="Webhook URL">{<CopyField value={d.url} label="Copy webhook URL" />}</Labeled>}
        </div>
      )
    case 'linear.api-key':
      return d.viewerId ? (
        <Facts
          rows={[
            ['Member', d.name ?? d.viewerId],
            ...(d.organization ? ([['Workspace', d.organization]] as [string, ReactNode][]) : []),
          ]}
        />
      ) : null
    case 'linear.webhook':
      return str(d.url) ? (
        <div className="flex flex-col gap-2">
          <Labeled label="Webhook URL">
            <CopyField value={d.url} label="Copy webhook URL" />
          </Labeled>
          {Array.isArray(d.resourceTypes) && <Facts rows={[['Resource types', d.resourceTypes.join(', ')]]} />}
        </div>
      ) : null
  }
  if (step.id === 'routing' && Array.isArray(d.triggers))
    return <Facts rows={d.triggers.map((t: { id: string; name: string }) => ['Trigger', t.name] as [string, ReactNode])} />
  return null
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-[#828fff] hover:underline">
      {children}
    </a>
  )
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-micro text-fg-quaternary">{label}</span>
      {children}
    </div>
  )
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-micro">
      {rows.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows may repeat a label
        <div key={i} className="contents">
          <dt className="text-fg-quaternary">{k}</dt>
          <dd className="min-w-0 truncate text-fg-secondary">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Paste secrets for a step: stored scoped to the employee after the server checked them. Values are never shown again. */
function SecretForm({
  employeeId,
  integration,
  fields,
  onSaved,
}: {
  employeeId: string
  integration: IntegrationSetupStatus
  fields: string[]
  onSaved(next: IntegrationSetupStatus): void
}) {
  const api = useApi()
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const defs = integration.secrets.filter((s) => fields.includes(s.name))
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const given = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()))
    if (!Object.keys(given).length) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.setIntegrationSecrets(employeeId, integration.name, given)
      setValues({})
      toast(r.message)
      onSaved(r.integration)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" data-testid={`secrets-${integration.name}`}>
      {defs.map((f) => (
        <div key={f.name} className="flex flex-col gap-1">
          <label htmlFor={`secret-${f.name}`} className="flex items-center gap-2 text-micro">
            <span className="text-fg-secondary">{f.label}</span>
            <span className="font-mono text-fg-quaternary">{f.name}</span>
            <span className="ml-auto text-fg-quaternary">{f.set ? 'set' : f.global ? 'using the global value' : 'not set'}</span>
          </label>
          <Input
            id={`secret-${f.name}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={values[f.name] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            placeholder={f.set ? 'Paste a new value to replace it' : (f.placeholder ?? '')}
            className="h-8 font-mono text-micro"
          />
        </div>
      ))}
      {error && (
        <p role="alert" className="text-micro text-[var(--red)]">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" size="sm" disabled={busy || !Object.values(values).some((v) => v.trim())}>
          {busy ? 'Checking…' : 'Save and check'}
        </Button>
      </div>
    </form>
  )
}

function ActionButton({
  employeeId,
  integration,
  action,
  label,
  primary,
  onDone,
}: {
  employeeId: string
  integration: string
  action: string
  label: string
  primary: boolean
  onDone(next: IntegrationSetupStatus): void
}) {
  const api = useApi()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="sm"
      variant={primary ? 'default' : 'outline'}
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          const r = await api.integrationAction(employeeId, integration, action)
          toast(r.message)
          onDone(r.integration)
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? 'Working…' : label}
    </Button>
  )
}

/** Copies the Slack manifest (admins: the manifest endpoint is theirs). */
function CopyManifest({ employeeId }: { employeeId: string }) {
  const { data } = useLoad((api) => api.slackManifest(employeeId), [employeeId])
  if (!data) return null
  return (
    <span className="inline-flex items-center gap-1 text-micro text-fg-tertiary">
      Or copy the manifest
      <CopyButton value={JSON.stringify(data.manifest, null, 2)} label="Copy manifest (JSON)" />
    </span>
  )
}

function StepItem({
  n,
  employeeId,
  integration,
  step,
  admin,
  onChange,
}: {
  n: number
  employeeId: string
  integration: IntegrationSetupStatus
  step: SetupStep
  admin: boolean
  onChange(next: IntegrationSetupStatus): void
}) {
  const doc = INTEGRATION_DOCS[integration.name]?.steps[step.id]
  const [open, setOpen] = useState(step.status !== 'done')
  const action = doc?.action && integration.actions.includes(doc.action.name) ? doc.action : null
  return (
    <li className="border-b last:border-b-0" data-testid="setup-step" data-step={step.id} data-status={step.status}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-level-2"
      >
        <StepIcon status={step.status} />
        <span className="w-4 shrink-0 text-micro text-fg-quaternary tabular-nums">{n}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{step.title}</span>
        <ChevronRight className={cn('size-3.5 shrink-0 text-fg-quaternary transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="flex flex-col gap-3 pr-4 pb-4 pl-[3.25rem]">
          {step.detail && (
            <p
              className={cn(
                'text-fg-secondary',
                step.status === 'warning' && 'text-[var(--orange)]',
                step.status === 'error' && 'text-[var(--red)]',
              )}
            >
              {step.detail}
            </p>
          )}
          {doc?.text.map((t) => (
            <Prose key={t} text={t} />
          ))}
          <StepExtras integration={integration.name} step={step} all={integration.steps} />
          {integration.name === 'slack' && step.id === 'app' && admin && <CopyManifest employeeId={employeeId} />}
          {integration.name === 'gitlab' && step.id === 'projects' && (
            <GitlabProjects
              employeeId={employeeId}
              step={step}
              admin={admin}
              canAdd={integration.actions.includes('add-projects')}
              onChange={onChange}
            />
          )}
          {doc?.links && (
            <div className="flex flex-wrap gap-3 text-micro">
              {doc.links.map((l) => (
                <Link key={l.href} href={l.href}>
                  {l.label}
                </Link>
              ))}
            </div>
          )}
          {admin && doc?.fields && (
            <SecretForm employeeId={employeeId} integration={integration} fields={doc.fields} onSaved={onChange} />
          )}
          {admin && action && (
            <div>
              <ActionButton
                employeeId={employeeId}
                integration={integration.name}
                action={action.name}
                label={action.label}
                primary={step.status !== 'done'}
                onDone={onChange}
              />
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/** The step-by-step panel of one integration. */
export function SetupPanel({
  employeeId,
  employeeName,
  integration,
  admin,
  open,
  onOpenChange,
  onChange,
  onRecheck,
  rechecking,
}: {
  employeeId: string
  employeeName: string
  integration: IntegrationSetupStatus | null
  admin: boolean
  open: boolean
  onOpenChange(open: boolean): void
  onChange(next: IntegrationSetupStatus): void
  onRecheck(): void
  rechecking: boolean
}) {
  const Icon = integration ? (ICON[integration.name] ?? MessagesSquare) : MessagesSquare
  const done = integration?.steps.filter((s) => s.status === 'done').length ?? 0
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-[560px]" data-testid="setup-panel">
        {integration && (
          <>
            <SheetHeader className="gap-1 border-b px-4 py-3.5">
              <SheetTitle className="flex items-center gap-2 text-title1">
                <Icon className="size-4 text-fg-tertiary" />
                {integration.label} for {employeeName}
              </SheetTitle>
              <SheetDescription className="text-mini text-fg-tertiary">
                {INTEGRATION_DOCS[integration.name]?.summary}
              </SheetDescription>
              <div className="flex items-center gap-3 pt-1.5">
                <StateLabel state={integration.state} />
                <span className="text-micro text-fg-quaternary">
                  {done} of {integration.steps.length} done · checked {agoPhrase(integration.checkedAt)}
                </span>
                <Button size="xs" variant="ghost" className="ml-auto text-fg-tertiary" onClick={onRecheck} disabled={rechecking}>
                  <RefreshCw className={cn(rechecking && 'animate-spin')} />
                  Re-check
                </Button>
              </div>
            </SheetHeader>
            {!admin && (
              <p className="border-b bg-level-1 px-4 py-2 text-micro text-fg-tertiary">
                You can see how it’s set up. Only admins can change it.
              </p>
            )}
            <ol>
              {integration.steps.map((s, i) => (
                <StepItem
                  key={`${integration.name}.${s.id}`}
                  n={i + 1}
                  employeeId={employeeId}
                  integration={integration}
                  step={s}
                  admin={admin}
                  onChange={onChange}
                />
              ))}
            </ol>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function IntegrationCard({
  integration,
  onOpen,
  admin,
}: {
  integration: IntegrationSetupStatus
  onOpen(): void
  admin: boolean
}) {
  const Icon = ICON[integration.name] ?? MessagesSquare
  const doc = INTEGRATION_DOCS[integration.name]
  const done = integration.steps.filter((s) => s.status === 'done').length
  const next = integration.steps.find((s) => s.status !== 'done')
  const verb = !admin
    ? 'View'
    : integration.state === 'not_set_up'
      ? 'Set up'
      : integration.state === 'connected'
        ? 'View'
        : 'Continue'
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="integration-card"
      data-integration={integration.name}
      className="group flex flex-col gap-2.5 rounded-xl border bg-level-1 p-4 text-left transition-colors duration-100 hover:border-input hover:bg-level-2"
    >
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-md border bg-level-2 text-fg-secondary">
          <Icon className="size-4" />
        </span>
        <span className="font-medium text-foreground">{integration.label}</span>
        <span className="ml-auto">
          <StateLabel state={integration.state} />
        </span>
      </div>
      <p className="flex-1 text-micro text-fg-tertiary">
        {integration.enabled ? doc?.summary : 'Disabled on this deployment (INTEGRATIONS).'}
      </p>
      <div className="flex gap-0.5" aria-hidden>
        {integration.steps.map((s) => (
          <span
            key={s.id}
            className="h-1 flex-1 rounded-full"
            style={{
              background:
                s.status === 'done' ? 'var(--green)' : s.status === 'todo' ? 'var(--bg-level-3)' : STEP_ICON[s.status].color,
            }}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 text-micro">
        <span className="min-w-0 flex-1 truncate text-fg-quaternary">
          {next ? `Next: ${next.title}` : `${done} of ${integration.steps.length} steps done`}
        </span>
        <span className="flex items-center gap-0.5 text-fg-secondary group-hover:text-foreground">
          {verb}
          <ChevronRight className="size-3.5" />
        </span>
      </div>
    </button>
  )
}

/**
 * The employee page's Integrations section: how integrations work, a card per integration
 * with its status, and the guided step-by-step panel. `initial` opens one panel right away.
 */
export function EmployeeIntegrationsSection({
  employeeId,
  employeeName,
  admin,
  initial,
}: {
  employeeId: string
  employeeName: string
  admin: boolean
  initial?: string | null
}) {
  const [refresh, setRefresh] = useState(0)
  const loaded = useLoad((api) => api.employeeIntegrations(employeeId, { refresh: refresh > 0 }), [employeeId, refresh])
  const [openName, setOpenName] = useState<string | null>(initial ?? null)
  const data = loaded.data
  const replace = (next: IntegrationSetupStatus) =>
    loaded.setData((prev: EmployeeIntegrations | undefined) =>
      prev ? { ...prev, integrations: prev.integrations.map((i) => (i.name === next.name ? next : i)) } : prev,
    )
  const current = data?.integrations.find((i) => i.name === openName) ?? null
  return (
    <section className="flex flex-col gap-3" aria-labelledby="integrations-title" data-testid="integrations">
      <SectionTitle
        actions={
          <Button
            size="xs"
            variant="ghost"
            className="text-fg-tertiary"
            onClick={() => setRefresh((n) => n + 1)}
            disabled={loaded.loading}
          >
            <RefreshCw className={cn(loaded.loading && data && 'animate-spin')} />
            Re-check
          </Button>
        }
      >
        <span id="integrations-title">Integrations</span>
      </SectionTitle>
      <details
        className="group rounded-lg border bg-level-1 px-4 py-2.5"
        open={!data || data.integrations.every((i) => i.state === 'not_set_up')}
      >
        <summary className="cursor-pointer list-none text-fg-secondary marker:hidden">
          <span className="inline-flex items-center gap-1.5">
            <ChevronRight className="size-3.5 text-fg-quaternary transition-transform group-open:rotate-90" />
            How integrations work
          </span>
        </summary>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-9 text-fg-tertiary">
          {HOW_INTEGRATIONS_WORK.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </details>
      {loaded.error && !data ? (
        <ErrorState error={loaded.error} retry={loaded.reload} />
      ) : !data ? (
        <LoadingRows rows={3} />
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          {data.integrations.map((i) => (
            <IntegrationCard key={i.name} integration={i} admin={admin} onOpen={() => setOpenName(i.name)} />
          ))}
        </div>
      )}
      <SetupPanel
        employeeId={employeeId}
        employeeName={employeeName}
        integration={current}
        admin={admin}
        open={!!current}
        onOpenChange={(o) => !o && setOpenName(null)}
        onChange={replace}
        onRecheck={() => setRefresh((n) => n + 1)}
        rechecking={loaded.loading}
      />
    </section>
  )
}
