import {
  ApiRequestError,
  type WebhookAction,
  type WebhookAuthType,
  type WebhookInfo,
  type WebhookRule,
  type WebhookWithSecret,
} from '@mp/api'
import { Pencil, Plus, RefreshCw, Trash2, Webhook, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { CopyField } from '@/components/copy.tsx'
import { LoadingRows } from '@/components/empty.tsx'
import { SectionTitle } from '@/components/page.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { useApi, useLoad } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'
import { timeAgo } from '@/lib/format.ts'

const selectClass = 'h-8 rounded-md border bg-transparent px-2 text-mini'

const actionLabel = (a: WebhookAction) =>
  a.type === 'ignore' ? 'ignore' : a.type === 'router' ? 'to the router' : `to session ${a.sessionId}`

/** A rule in one line: `charge.* where data.status = failed → to session ses_…`. */
export function ruleSummary(r: WebhookRule): string {
  const when = [
    r.type ? `type ${r.type}` : '',
    r.field ? `${r.field} ${r.equals !== undefined ? `= ${r.equals}` : `contains ${r.contains}`}` : '',
  ].filter(Boolean)
  return `${when.length ? when.join(' and ') : 'anything'} → ${actionLabel(r.action)}`
}

/**
 * An employee's own webhooks (admins only): URLs other systems post JSON to, with a token or HMAC
 * secret, how the body maps to an event, and rules for where events go: ignored, the router, or a session.
 */
export function Webhooks({ employeeId }: { employeeId: string }) {
  const { can } = useAuth()
  if (!can('admin')) return null
  return <WebhooksSection employeeId={employeeId} />
}

function WebhooksSection({ employeeId }: { employeeId: string }) {
  const api = useApi()
  const list = useLoad((a) => a.webhooks({ employeeId }), [employeeId])
  const [editing, setEditing] = useState<WebhookInfo | 'new' | null>(null)
  const [secret, setSecret] = useState<WebhookWithSecret | null>(null)
  const hooks = list.data ?? []
  return (
    <section data-testid="webhooks">
      <div className="mb-2 flex items-center gap-2">
        <SectionTitle>Webhooks</SectionTitle>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditing('new')}>
          <Plus /> Add webhook
        </Button>
      </div>
      <p className="mb-3 text-micro text-fg-tertiary">
        URLs other systems post JSON to (Sentry, Stripe, CI…). Each event goes where its first matching rule says: ignored, to the
        router, or to a session; with no rule matching, the router decides. Events are treated as untrusted input.
      </p>
      {secret && (
        <div className="mb-3 rounded-xl border border-brand/50 bg-brand/10 p-3" role="status">
          <div className="mb-2 text-mini text-foreground">
            Secret of {secret.webhook.name}: copy it now, it won't be shown again. Send it{' '}
            {secret.webhook.auth.type === 'token'
              ? `as the ${secret.webhook.auth.header} header`
              : `as the key of an HMAC-SHA256 signature of the body, in the ${secret.webhook.auth.header} header (hex, sha256= allowed)`}
            .
          </div>
          <CopyField value={secret.secret} label="Copy secret" />
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setSecret(null)}>
            Done
          </Button>
        </div>
      )}
      <div className="rounded-xl border">
        {list.loading && !list.data && <LoadingRows rows={2} />}
        {list.data && !hooks.length && <div className="px-3 py-4 text-fg-tertiary">No webhooks yet.</div>}
        {hooks.map((w) => (
          <div key={w.id} className="border-b px-3 py-2 last:border-0" data-testid={`webhook-${w.name}`}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Webhook className="size-3.5 text-fg-tertiary" />
              <span className="font-mono text-fg-secondary">{w.name}</span>
              {w.about && <span className="min-w-0 truncate text-micro text-fg-tertiary">{w.about}</span>}
              <span className="ml-auto text-micro text-fg-quaternary">
                {w.received} received · {w.ignored} ignored
                {w.lastReceivedAt ? ` · last ${timeAgo(w.lastReceivedAt)} ago` : ''}
              </span>
              <Switch
                checked={w.enabled}
                aria-label={`${w.enabled ? 'Turn off' : 'Turn on'} ${w.name}`}
                onCheckedChange={async (on) => {
                  await api.updateWebhook(w.id, { enabled: on })
                  list.reload()
                }}
              />
              <Button variant="ghost" size="icon-xs" aria-label={`Edit ${w.name}`} onClick={() => setEditing(w)}>
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`New secret for ${w.name}`}
                onClick={async () => {
                  if (!confirm(`Give ${w.name} a new secret? The current one stops working at once.`)) return
                  setSecret(await api.rotateWebhook(w.id))
                }}
              >
                <RefreshCw />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Delete ${w.name}`}
                onClick={async () => {
                  if (!confirm(`Delete the webhook ${w.name}? Deliveries to its URL will be refused.`)) return
                  await api.deleteWebhook(w.id)
                  toast(`${w.name} deleted`)
                  list.reload()
                }}
              >
                <Trash2 />
              </Button>
            </div>
            <CopyField value={w.url} label="Copy URL" className="mt-1.5" />
            {w.rules.length > 0 && (
              <ol className="mt-1.5 list-decimal pl-5 text-micro text-fg-tertiary">
                {w.rules.map((r) => (
                  // Two identical rules would do the same: the second never matches.
                  <li key={JSON.stringify(r)}>{ruleSummary(r)}</li>
                ))}
              </ol>
            )}
          </div>
        ))}
      </div>
      {editing && (
        <WebhookDialog
          employeeId={employeeId}
          editing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            setEditing(null)
            if (created) setSecret(created)
            list.reload()
          }}
        />
      )}
    </section>
  )
}

interface DraftRule {
  /** For React only. */
  key: string
  type: string
  field: string
  op: 'equals' | 'contains'
  value: string
  action: WebhookAction['type']
  sessionId: string
}

let draftSeq = 0
const draftKey = () => `rule-${++draftSeq}`

const toDraft = (r: WebhookRule): DraftRule => ({
  key: draftKey(),
  type: r.type ?? '',
  field: r.field ?? '',
  op: r.contains !== undefined ? 'contains' : 'equals',
  value: r.contains ?? r.equals ?? '',
  action: r.action.type,
  sessionId: r.action.type === 'session' ? r.action.sessionId : '',
})

const fromDraft = (d: DraftRule): WebhookRule => ({
  ...(d.type.trim() ? { type: d.type.trim() } : {}),
  ...(d.field.trim() ? { field: d.field.trim(), [d.op]: d.value } : {}),
  action: d.action === 'session' ? { type: 'session', sessionId: d.sessionId.trim() } : { type: d.action },
})

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

function WebhookDialog({
  employeeId,
  editing,
  onClose,
  onSaved,
}: {
  employeeId: string
  editing: WebhookInfo | null
  onClose(): void
  onSaved(created?: WebhookWithSecret): void
}) {
  const api = useApi()
  const [name, setName] = useState(editing?.name ?? '')
  const [about, setAbout] = useState(editing?.about ?? '')
  const [authType, setAuthType] = useState<WebhookAuthType>(editing?.auth.type ?? 'token')
  const [header, setHeader] = useState(editing?.auth.header ?? '')
  const [type, setType] = useState(editing?.mapping.type ?? '')
  const [subject, setSubject] = useState(editing?.mapping.subject ?? '')
  const [text, setText] = useState(editing?.mapping.text ?? '')
  const [rules, setRules] = useState<DraftRule[]>((editing?.rules ?? []).map(toDraft))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const setRule = (i: number, patch: Partial<DraftRule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const save = async () => {
    setSaving(true)
    setError('')
    const body = {
      about: about.trim(),
      auth: { type: authType, ...(header.trim() ? { header: header.trim() } : {}) },
      mapping: {
        ...(type.trim() ? { type: type.trim() } : {}),
        ...(subject.trim() ? { subject: subject.trim() } : {}),
        ...(text.trim() ? { text: text.trim() } : {}),
      },
      rules: rules.map(fromDraft),
    }
    try {
      if (editing) {
        await api.updateWebhook(editing.id, body)
        onSaved()
      } else onSaved(await api.createWebhook({ employeeId, name: name.trim(), ...body }))
    } catch (e) {
      setError(e instanceof ApiRequestError || e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-title1">
            <Webhook className="size-4 text-fg-tertiary" />
            {editing ? `Edit ${editing.name}` : 'Add a webhook'}
          </DialogTitle>
          <DialogDescription>
            Paths point into the JSON body, like <code className="font-mono">action</code> or{' '}
            <code className="font-mono">data.issue.id</code>.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Row id="wh-name" label="Name" hint="Events come from webhook:<name>">
            <Input
              id="wh-name"
              value={name}
              disabled={!!editing}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="sentry"
              className="font-mono text-micro"
            />
          </Row>
          <Row id="wh-about" label="What it's for">
            <Input id="wh-about" value={about} onChange={(e) => setAbout(e.target.value)} placeholder="Errors from the web app" />
          </Row>
          <Row id="wh-auth" label="Check" hint="How a delivery proves it's real">
            <div className="flex flex-wrap gap-1.5">
              <select
                id="wh-auth"
                className={selectClass}
                value={authType}
                onChange={(e) => setAuthType(e.target.value as WebhookAuthType)}
              >
                <option value="token">Token in a header</option>
                <option value="hmac">HMAC-SHA256 signature</option>
              </select>
              <Input
                aria-label="Header"
                value={header}
                onChange={(e) => setHeader(e.target.value)}
                placeholder={authType === 'token' ? 'X-Webhook-Token' : 'X-Signature'}
                className="w-48 font-mono text-micro"
              />
            </div>
          </Row>
          <Row id="wh-type" label="Event type" hint="Path; default received">
            <Input
              id="wh-type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="action"
              className="font-mono text-micro"
            />
          </Row>
          <Row id="wh-subject" label="Subject" hint="Path: follow-ups about it reach the same session">
            <Input
              id="wh-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="data.issue.id"
              className="font-mono text-micro"
            />
          </Row>
          <Row id="wh-text" label="Text" hint="Optional, with {path} placeholders">
            <Input
              id="wh-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Sentry {action}: {data.issue.title}"
              className="font-mono text-micro"
            />
          </Row>
          <div>
            <div className="mb-1 flex items-center">
              <span className="text-mini text-fg-secondary">Rules</span>
              <span className="ml-2 text-micro text-fg-quaternary">The first that matches decides; none: the router</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() =>
                  setRules((rs) => [
                    ...rs,
                    { key: draftKey(), type: '', field: '', op: 'equals', value: '', action: 'ignore', sessionId: '' },
                  ])
                }
              >
                <Plus /> Rule
              </Button>
            </div>
            {rules.map((r, i) => (
              <div
                key={r.key}
                className="mb-1.5 flex flex-wrap items-center gap-1.5 rounded-md border p-1.5"
                data-testid="webhook-rule"
              >
                <Input
                  aria-label={`Rule ${i + 1} type`}
                  value={r.type}
                  onChange={(e) => setRule(i, { type: e.target.value })}
                  placeholder="type, e.g. charge.*"
                  className="w-36 font-mono text-micro"
                />
                <Input
                  aria-label={`Rule ${i + 1} field`}
                  value={r.field}
                  onChange={(e) => setRule(i, { field: e.target.value })}
                  placeholder="field path"
                  className="w-32 font-mono text-micro"
                />
                <select
                  aria-label={`Rule ${i + 1} comparison`}
                  className={selectClass}
                  value={r.op}
                  onChange={(e) => setRule(i, { op: e.target.value as DraftRule['op'] })}
                >
                  <option value="equals">=</option>
                  <option value="contains">contains</option>
                </select>
                <Input
                  aria-label={`Rule ${i + 1} value`}
                  value={r.value}
                  onChange={(e) => setRule(i, { value: e.target.value })}
                  placeholder="value"
                  className="w-28 text-micro"
                />
                <select
                  aria-label={`Rule ${i + 1} action`}
                  className={selectClass}
                  value={r.action}
                  onChange={(e) => setRule(i, { action: e.target.value as WebhookAction['type'] })}
                >
                  <option value="ignore">Ignore</option>
                  <option value="router">To the router</option>
                  <option value="session">To a session</option>
                </select>
                {r.action === 'session' && (
                  <Input
                    aria-label={`Rule ${i + 1} session`}
                    value={r.sessionId}
                    onChange={(e) => setRule(i, { sessionId: e.target.value })}
                    placeholder="ses_…"
                    className="w-40 font-mono text-micro"
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove rule ${i + 1}`}
                  onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
                >
                  <X />
                </Button>
              </div>
            ))}
          </div>
          {error && (
            <p className="text-mini text-[var(--red)]" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {editing ? 'Save' : 'Add webhook'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
