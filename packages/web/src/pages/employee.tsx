import type { ContactData, EmployeeData, SshKeyInfo } from '@mp/api'
import { KeyRound, Pencil, RotateCw, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { NavLink, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { CopyButton } from '@/components/copy.tsx'
import { ErrorState, LoadingRows } from '@/components/empty.tsx'
import { EmployeeProjects } from '@/components/employee-projects.tsx'
import { EmployeeIntegrationsSection } from '@/components/integration-setup.tsx'
import { HandleLink } from '@/components/links.tsx'
import { McpServers } from '@/components/mcp-servers.tsx'
import { NetworkSetting } from '@/components/network-setting.tsx'
import { NewEmployeeButton } from '@/components/new-employee-dialog.tsx'
import { Page, SectionTitle } from '@/components/page.tsx'
import { EmployeeAvatar } from '@/components/people.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { useApi, useLoad } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'
import { agoPhrase, formatDateTime } from '@/lib/format.ts'

function Section({ title, actions, children, id }: { title: string; actions?: ReactNode; children: ReactNode; id: string }) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby={id}>
      <SectionTitle actions={actions}>
        <span id={id}>{title}</span>
      </SectionTitle>
      {children}
    </section>
  )
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-fg-tertiary">{label}</dt>
      <dd className="min-w-0 text-fg-secondary">{children}</dd>
    </div>
  )
}

/** The employee's profile: identity, role, model, router context. */
function Profile({
  employee,
  contact,
  admin = false,
  reload = () => {},
}: {
  employee: { id: string; key: string | null; version: number; data: EmployeeData }
  contact?: ContactData
  admin?: boolean
  reload?: () => void
}) {
  const d = employee.data
  const allow = d.toolAllow ?? d.tools?.allow ?? []
  const deny = d.toolDeny ?? d.tools?.deny ?? []
  const handles = (contact?.handles ?? []).filter((h) => h.system !== 'mp')
  const about = (typeof contact?.bio === 'string' && contact.bio) || (typeof d.scope === 'string' && d.scope) || null
  return (
    <div className="flex flex-col gap-4" data-testid="employee-profile">
      <div className="flex items-start gap-3">
        <EmployeeAvatar name={d.name} className="size-10" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-title2 font-semibold">{d.name}</h2>
            <span className="rounded bg-accent-tint px-1.5 py-px text-tiny font-medium text-[#828fff]">AI</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-fg-tertiary">
            <span className="font-mono text-micro">@{employee.key ?? employee.id}</span>
            {contact?.role && <span>· {contact.role}</span>}
          </div>
        </div>
      </div>
      {about && <p className="text-regular text-fg-secondary">{about}</p>}
      <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5">
        <Property label="Model">
          <span className="font-mono text-micro">{d.model || 'deployment default'}</span>
        </Property>
        <Property label="Router context">
          {d.routerSessionId ? (
            <NavLink to={`/sessions/${d.routerSessionId}`} className="text-[#828fff] hover:underline">
              Open router session
            </NavLink>
          ) : (
            <span className="text-fg-quaternary">none yet</span>
          )}
        </Property>
        <Property label="Tools">
          {allow.length ? `${allow.length} allowed pattern${allow.length === 1 ? '' : 's'}` : 'none'}
          {deny.length ? `, ${deny.length} denied` : ''}
        </Property>
        <Property label="Network">
          <NetworkSetting employee={employee} admin={admin} onSaved={reload} />
        </Property>
        {handles.length > 0 && (
          <Property label="Accounts">
            <span className="flex flex-wrap gap-1">
              {handles.map((h) => (
                <span key={`${h.system}:${h.id}`} className="rounded bg-level-3 px-1.5 py-px text-micro">
                  {h.system}: <HandleLink handle={h} />
                </span>
              ))}
            </span>
          </Property>
        )}
        {d.personality && <Property label="Personality">{d.personality}</Property>}
      </dl>
    </div>
  )
}

/** The SSH public key: copy it, see its fingerprint, rotate it (admins). */
function SshKey({ employeeId, admin }: { employeeId: string; admin: boolean }) {
  const api = useApi()
  const key = useLoad((a) => a.employeeSshKey(employeeId), [employeeId])
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const rotate = async () => {
    setBusy(true)
    try {
      await api.rotateSshKey(employeeId)
      toast('New SSH key made', { description: 'Add it where the old one was: its GitLab account or deploy keys.' })
      setConfirm(false)
      key.reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const k: SshKeyInfo | undefined = key.data
  return (
    <Section
      id="ssh-title"
      title="SSH key"
      actions={
        admin && k?.publicKey ? (
          <Button size="xs" variant="ghost" className="text-fg-tertiary" onClick={() => setConfirm(true)}>
            <RotateCw />
            Rotate
          </Button>
        ) : null
      }
    >
      <p className="text-fg-tertiary">
        The employee pushes and signs in to git hosts over SSH with this key. Its private half is a secret the model never sees.
        Add the public key to its GitLab account (the GitLab setup below does it for you) or as a deploy key.
      </p>
      {key.error && !k ? (
        <ErrorState error={key.error} retry={key.reload} />
      ) : !k ? (
        <LoadingRows rows={2} />
      ) : !k.publicKey ? (
        <p className="text-fg-tertiary">No key yet. {admin ? 'Rotate to make one.' : ''}</p>
      ) : (
        <div className="flex flex-col gap-2 rounded-xl border bg-level-1 p-3" data-testid="ssh-key">
          <div className="flex items-start gap-2">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-fg-tertiary" />
            <code className="min-w-0 flex-1 font-mono text-micro break-all text-fg-secondary">{k.publicKey}</code>
            <CopyButton value={k.publicKey} label="Copy public key" />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 pl-6 text-micro text-fg-tertiary">
            <span>
              Fingerprint <code className="font-mono break-all text-fg-secondary">{k.fingerprint}</code>
            </span>
            {k.createdAt && <span title={formatDateTime(k.createdAt)}>Created {agoPhrase(k.createdAt)}</span>}
          </div>
        </div>
      )}
      <Dialog open={confirm} onOpenChange={(o) => !busy && setConfirm(o)}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="text-title1">Rotate the SSH key?</DialogTitle>
            <DialogDescription className="text-mini text-fg-tertiary">
              The harness makes a new keypair and the old key stops working at once. Replace it everywhere it was added: the
              employee’s GitLab account (the GitLab setup can add the new one and remove the old), and any deploy keys.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={rotate} disabled={busy}>
              {busy ? 'Rotating…' : 'Rotate key'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  )
}

/** `/employees/:id`: an employee's profile, projects, SSH key, guided integration setup and MCP servers. */
export function EmployeePage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const { can } = useAuth()
  const admin = can('admin')
  const employee = useLoad((a) => a.getRecord<EmployeeData>('employee', id), [id])
  const contactId = employee.data?.data.contactId
  const contact = useLoad(
    (a) => (contactId ? a.getRecord<ContactData>('contact', contactId) : Promise.resolve(null)),
    [contactId],
  )
  const isNew = params.get('new') === '1'
  const e = employee.data
  return (
    <Page
      title={e?.data.name ?? 'Employee'}
      icon={<EmployeeAvatar name={e?.data.name ?? '?'} className="size-4" />}
      actions={
        admin && (
          <>
            {e && (
              <Button asChild size="sm" variant="ghost" className="text-fg-tertiary">
                <NavLink to={`/settings/employees?employee=${e.id}`}>
                  <Pencil />
                  Edit
                </NavLink>
              </Button>
            )}
            <NewEmployeeButton />
          </>
        )
      }
    >
      {employee.error && !e ? (
        <ErrorState error={employee.error} retry={employee.reload} />
      ) : !e ? (
        <LoadingRows />
      ) : (
        <div className="mx-auto flex w-full max-w-[808px] flex-col gap-8 px-4 py-6 md:px-6" data-testid="employee-page">
          {isNew && (
            <div
              className="flex items-start gap-3 rounded-lg border border-[var(--ring)]/40 bg-accent-tint px-4 py-3"
              role="status"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">{e.data.name} is ready.</p>
                <p className="text-fg-tertiary">
                  It has a router session, its own requests channel and an SSH key. Next, connect the systems it works in below.
                </p>
              </div>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Dismiss"
                onClick={() => {
                  params.delete('new')
                  setParams(params, { replace: true })
                }}
              >
                <X />
              </Button>
            </div>
          )}
          <Profile employee={e} contact={contact.data?.data} admin={admin} reload={employee.reload} />
          <EmployeeProjects employeeId={e.id} employeeName={e.data.name} />
          <SshKey employeeId={e.id} admin={admin} />
          <EmployeeIntegrationsSection employeeId={e.id} employeeName={e.data.name} admin={admin} initial={params.get('setup')} />
          {/* Its own MCP servers (admins; the component renders nothing for others). */}
          <McpServers employeeId={e.id} />
        </div>
      )}
    </Page>
  )
}
