import type { KnowledgeRef } from '@mp/api'
import { FolderKanban, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { EmployeeAvatar, PersonAvatar } from '@/components/people.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx'
import { hrefFor } from '@/lib/doclinks.ts'
import { cn } from '@/lib/utils.ts'

/** The "any" value of a filter select. */
export const ANY = 'any'

/** A compact select for a filter bar; highlighted while it filters. */
export function BarSelect({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string
  value: string
  onChange(v: string): void
  options: { value: string; label: ReactNode }[]
  className?: string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        aria-label={label}
        className={cn('h-7 max-w-52 gap-1.5 px-2 text-mini data-[size=sm]:h-7', value !== ANY && 'text-foreground', className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** A form row: a label with an optional hint, the control, and an error under it. */
export function Field({
  id,
  label,
  hint,
  error,
  children,
  className,
}: {
  id?: string
  label: string
  hint?: ReactNode
  error?: string | null
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={id} className="flex min-w-0 items-baseline gap-2 text-micro">
        <span className="shrink-0 font-medium text-fg-secondary">{label}</span>
        {hint && <span className="min-w-0 truncate text-fg-quaternary">{hint}</span>}
      </label>
      {children}
      {error && (
        <p role="alert" className="text-micro text-[var(--red)]">
          {error}
        </p>
      )}
    </div>
  )
}

/** A person, employee or project as a small chip, linked to its page. */
export function RefChip({ r, onRemove, className }: { r: KnowledgeRef; onRemove?(): void; className?: string }) {
  const href = r.employeeId ? `/employees/${r.employeeId}` : hrefFor(r.kind, r.id)
  const icon =
    r.kind === 'project' ? (
      <FolderKanban className="size-3 text-fg-tertiary" />
    ) : r.contactKind === 'ai' ? (
      <EmployeeAvatar name={r.name} className="size-3.5" />
    ) : (
      <PersonAvatar name={r.name} className="size-3.5" />
    )
  return (
    <span
      className={cn(
        'inline-flex h-5 max-w-44 min-w-0 shrink-0 items-center gap-1 rounded-sm border bg-level-1 pr-1 pl-1 text-micro text-fg-secondary',
        className,
      )}
      data-testid="ref-chip"
    >
      {icon}
      {onRemove ? (
        <span className="truncate">{r.name}</span>
      ) : (
        <Link to={href} className="truncate hover:text-foreground" onClick={(e) => e.stopPropagation()}>
          {r.name}
        </Link>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${r.name}`}
          className="rounded-sm text-fg-tertiary hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}

/** A small tag: access levels, "off", "personal". */
export function Tag({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn('inline-flex shrink-0 items-center gap-1 rounded-sm border px-1 text-tiny text-fg-tertiary', className)}
    >
      {children}
    </span>
  )
}

/** A section of a detail page: a heading with actions, then its content. */
export function DetailSection({
  title,
  actions,
  children,
  id,
}: {
  title: ReactNode
  actions?: ReactNode
  children: ReactNode
  id?: string
}) {
  return (
    <section className="mb-10" aria-labelledby={id} data-testid={id}>
      <div className="mb-2 flex min-h-7 items-center gap-2 border-b pb-1.5">
        <h3 id={id} className="text-mini font-medium text-foreground">
          {title}
        </h3>
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/** A block of the right-hand properties panel. */
export function SidePanel({
  title,
  actions,
  children,
  testId,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
  testId?: string
}) {
  return (
    <div className="border-b px-4 py-4" data-testid={testId}>
      <div className="mb-2 flex items-center gap-2 text-micro font-medium text-fg-tertiary">
        <span>{title}</span>
        {actions && <span className="ml-auto flex items-center gap-1">{actions}</span>}
      </div>
      {children}
    </div>
  )
}

/** A confirmation for something that can't be undone. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirm,
  onConfirm,
  busy,
  destructive = true,
}: {
  open: boolean
  onOpenChange(o: boolean): void
  title: string
  description: ReactNode
  confirm: string
  onConfirm(): void
  busy?: boolean
  destructive?: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-title1">{title}</DialogTitle>
          <DialogDescription className="text-mini text-fg-tertiary">{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" variant={destructive ? 'destructive' : 'default'} onClick={onConfirm} disabled={busy}>
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A choice between a few options, as a row of buttons with a hint under the picked one. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T
  onChange(v: T): void
  options: { value: T; label: string; hint?: string; icon?: ReactNode }[]
  label: string
}) {
  const picked = options.find((o) => o.value === value)
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
        {options.map((o) => (
          // biome-ignore lint/a11y/useSemanticElements: a row of buttons reads better than radio inputs here (as in mcp-servers.tsx)
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-mini text-fg-secondary transition-quick hover:bg-secondary',
              o.value === value && 'border-[var(--ring)] bg-accent-tint text-foreground',
            )}
          >
            {o.icon}
            {o.label}
          </button>
        ))}
      </div>
      {picked?.hint && <p className="text-micro text-fg-quaternary">{picked.hint}</p>}
    </div>
  )
}

/** The text of an error, for forms. */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
