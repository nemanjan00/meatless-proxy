import type { Access, CreatedPerson, PersonHandle, SignInLinkResult } from '@mp/api'
import { Check, Link2, Plus, Send, X } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { CopyButton } from '@/components/copy.tsx'
import { Field, Segmented, errorText } from '@/components/knowledge-ui.tsx'
import { PickedChip } from '@/components/new-procedure-dialog.tsx'
import { RecordPicker } from '@/components/record-picker.tsx'
import { selectClass } from '@/components/start-form.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import { useApi } from '@/lib/api.tsx'
import { ACCESS_INFO, ACCESS_ORDER, HANDLE_SYSTEMS } from '@/lib/knowledge.ts'
import { formatTime } from '@/lib/format.ts'
import { newKey } from '@/lib/procedures.ts'

/** Handles in other systems: a system and an id per row. */
export function HandlesEditor({
  value,
  onChange,
  idPrefix = 'hd',
}: {
  value: PersonHandle[]
  onChange(next: PersonHandle[]): void
  idPrefix?: string
}) {
  const set = (i: number, patch: Partial<PersonHandle>) => onChange(value.map((h, j) => (j === i ? { ...h, ...patch } : h)))
  return (
    <div className="flex flex-col gap-2" data-testid="handles-editor">
      {value.map((h, i) => {
        const known = HANDLE_SYSTEMS.find((s) => s.value === h.system)
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows of a draft list
          <div key={i} className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-center gap-2">
            <select
              aria-label="System"
              id={`${idPrefix}-sys-${i}`}
              value={known ? h.system : 'other'}
              onChange={(e) => set(i, { system: e.target.value === 'other' ? '' : e.target.value })}
              className={selectClass}
            >
              {HANDLE_SYSTEMS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
              <option value="other">Other…</option>
            </select>
            <div className="flex min-w-0 gap-2">
              {!known && (
                <Input
                  aria-label="System name"
                  value={h.system}
                  onChange={(e) => set(i, { system: e.target.value })}
                  placeholder="github"
                  className="h-8 w-24"
                />
              )}
              <Input
                aria-label={`${known?.label ?? 'Handle'} id`}
                value={h.id}
                onChange={(e) => set(i, { id: e.target.value })}
                placeholder={known?.placeholder ?? 'their id there'}
                className="h-8 min-w-0 flex-1 font-mono text-micro"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Remove handle"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <X />
            </Button>
          </div>
        )
      })}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="self-start"
        onClick={() => onChange([...value, { system: value.some((h) => h.system === 'slack') ? 'gitlab' : 'slack', id: '' }])}
      >
        <Plus /> Add a handle
      </Button>
    </div>
  )
}

/** Handles with both parts filled in. */
export const cleanHandles = (hs: PersonHandle[]) =>
  hs.map((h) => ({ system: h.system.trim().toLowerCase(), id: h.id.trim() })).filter((h) => h.system && h.id)

/** A one-time sign-in link to copy, and whether it was sent. */
export function SignInLinkBox({ link, name }: { link: SignInLinkResult; name: string }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-[var(--ring)]/40 bg-accent-tint p-3"
      data-testid="sign-in-link"
      role="status"
    >
      <p className="flex items-center gap-1.5 text-mini text-foreground">
        {link.sentVia === 'slack' ? (
          <>
            <Send className="size-3.5 text-[var(--green)]" /> Sent to {name} as a Slack DM. You can also copy it:
          </>
        ) : (
          <>
            <Link2 className="size-3.5" /> Sign-in link for {name}: send it to them privately.
          </>
        )}
      </p>
      <div className="flex min-w-0 items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded-md border bg-background px-2 py-1 font-mono text-micro" title={link.url}>
          {link.url}
        </code>
        <CopyButton value={link.url} label="Copy link" />
      </div>
      <p className="text-micro text-fg-tertiary">
        It works once, until {formatTime(link.expiresAt)} (15 minutes).{link.notSent ? ` ${link.notSent}` : ''}
      </p>
    </div>
  )
}

/**
 * "Add person" (admins): who they are, what they may do, their handles in other systems, and a
 * one-time sign-in link (sent as a Slack DM when they have a Slack handle and Slack is set up).
 */
export function NewPersonDialog({
  open,
  onOpenChange,
  onCreated,
  teams = [],
}: {
  open: boolean
  onOpenChange(o: boolean): void
  onCreated(person: CreatedPerson): void
  /** Teams already in the directory, suggested for the team field. */
  teams?: string[]
}) {
  const api = useApi()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [access, setAccess] = useState<Access>('member')
  const [role, setRole] = useState('')
  const [team, setTeam] = useState('')
  const [manager, setManager] = useState<{ id: string; label: string } | null>(null)
  const [handles, setHandles] = useState<PersonHandle[]>([])
  const [sendLink, setSendLink] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field: 'name' | 'email' | 'form'; message: string } | null>(null)
  const [done, setDone] = useState<CreatedPerson | null>(null)
  const key = useRef(newKey())

  const reset = () => {
    key.current = newKey()
    setName('')
    setEmail('')
    setAccess('member')
    setRole('')
    setTeam('')
    setManager(null)
    setHandles([])
    setSendLink(true)
    setError(null)
    setDone(null)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when it opens
  useEffect(() => {
    if (open) reset()
  }, [open])

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (busy) return
    if (!name.trim()) return setError({ field: 'name', message: 'Their name, as colleagues know it.' })
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      return setError({ field: 'email', message: 'That email address looks wrong.' })
    setBusy(true)
    setError(null)
    try {
      const r = await api.createPerson({
        name: name.trim(),
        ...(email.trim() ? { email: email.trim() } : {}),
        access,
        ...(role.trim() ? { role: role.trim() } : {}),
        ...(team.trim() ? { team: team.trim() } : {}),
        ...(manager ? { manager: manager.id } : {}),
        ...(cleanHandles(handles).length ? { handles: cleanHandles(handles) } : {}),
        sendSignInLink: sendLink,
        idempotencyKey: key.current,
      })
      onCreated(r)
      if (r.signInLink) setDone(r)
      else {
        toast(`${r.person.contact.data.name} was added`)
        onOpenChange(false)
      }
    } catch (err) {
      const message = errorText(err)
      setError({ field: /email/.test(message) ? 'email' : 'form', message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[92svh] gap-4 overflow-y-auto sm:max-w-[600px]" data-testid="new-person-dialog">
        <DialogHeader>
          <DialogTitle className="text-title1">
            {done ? `${done.person.contact.data.name} was added` : 'Add a person'}
          </DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">
            {done
              ? 'They sign in with the link below. When it has expired, send a new one from their page.'
              : 'Someone the employees work with. Their access decides what they can do here; the employees recognise them by their handles.'}
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="flex min-w-0 flex-col gap-4">
            {done.signInLink && <SignInLinkBox link={done.signInLink} name={done.person.contact.data.name} />}
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={reset}>
                <Plus /> Add another
              </Button>
              <Button size="sm" asChild>
                <Link to={`/contacts/${done.person.contact.id}`} onClick={() => onOpenChange(false)}>
                  <Check /> Open their page
                </Link>
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex min-w-0 flex-col gap-3.5" noValidate>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="np-name" label="Name" error={error?.field === 'name' ? error.message : null}>
                <Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Ana Novak" />
              </Field>
              <Field
                id="np-email"
                label="Email"
                hint="For signing in with your identity provider"
                error={error?.field === 'email' ? error.message : null}
              >
                <Input
                  id="np-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="ana@example.com"
                />
              </Field>
            </div>
            <Field label="Access">
              <Segmented<Access>
                label="Access"
                value={access}
                onChange={setAccess}
                options={ACCESS_ORDER.map((a) => ({ value: a, label: ACCESS_INFO[a].label, hint: ACCESS_INFO[a].hint }))}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="np-role" label="Title" hint="Their job">
                <Input id="np-role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Payments lead" />
              </Field>
              <Field id="np-team" label="Team">
                <Input
                  id="np-team"
                  value={team}
                  onChange={(e) => setTeam(e.target.value)}
                  placeholder="Payments"
                  list="np-teams"
                />
                <datalist id="np-teams">
                  {teams.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </Field>
            </div>
            <Field id="np-manager" label="Manager" hint="Optional">
              {manager ? (
                <PickedChip label={manager.label} onClear={() => setManager(null)} clearLabel="Change manager" />
              ) : (
                <RecordPicker
                  id="np-manager"
                  kinds={['contact']}
                  filter={(r) => ((r.data as { kind?: string }).kind ?? 'person') === 'person'}
                  placeholder="Type a name"
                  onPick={(o) => setManager({ id: o.id, label: o.label })}
                />
              )}
            </Field>
            <Field label="Handles" hint="Their ids in Slack, GitLab or Linear, so employees know it's them">
              <HandlesEditor value={handles} onChange={setHandles} idPrefix="np-h" />
            </Field>
            <label htmlFor="np-send" className="flex items-start gap-2 rounded-md border px-3 py-2">
              <Checkbox id="np-send" checked={sendLink} onCheckedChange={(v) => setSendLink(v === true)} className="mt-0.5" />
              <span className="flex flex-col">
                <span className="text-mini text-fg-secondary">Send a sign-in link</span>
                <span className="text-micro text-fg-quaternary">
                  A one-time link, valid for 15 minutes. It's sent as a Slack DM when they have a Slack handle and Slack is set
                  up; otherwise you copy it and send it yourself.
                </span>
              </span>
            </label>
            {error?.field === 'form' && (
              <p role="alert" className="text-micro text-[var(--red)]">
                {error.message}
              </p>
            )}
            <DialogFooter className="border-t pt-4">
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? 'Adding…' : 'Add person'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
