import type { ApiRecord } from '@mp/api'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { Input } from '@/components/ui/input.tsx'
import { useApi } from '@/lib/api.tsx'
import { kindOfId } from '@/lib/names.ts'
import { cn } from '@/lib/utils.ts'

/** One suggestion: a record of one of the kinds. */
export interface PickOption {
  id: string
  kind: string
  label: string
  detail?: string
}

/** A record's display name, as the rest of the UI shows it. */
export function recordLabel(r: ApiRecord): string {
  const d = r.data as Record<string, unknown>
  return String(d.name ?? d.title ?? d.summary ?? d.slug ?? r.key ?? r.id)
}

function detailOf(r: ApiRecord): string | undefined {
  const d = r.data as Record<string, unknown>
  const bits = [d.role, d.team, d.email, d.status].filter((x): x is string => typeof x === 'string' && !!x)
  return bits.length ? bits.slice(0, 2).join(' · ') : undefined
}

/**
 * A typeahead for record references: type a name and pick the record,
 * instead of pasting an id. It searches the given kinds (`GET /api/records/:kind?text=`),
 * shows names with a short detail, and works with the keyboard (↑ ↓ Enter Esc).
 * Pasting an id of the right kind still works.
 */
export function RecordPicker({
  kinds,
  onPick,
  exclude = [],
  placeholder,
  id,
  autoFocus,
  onCancel,
  className,
}: {
  kinds: string[]
  onPick(option: PickOption): void
  exclude?: string[]
  placeholder?: string
  id?: string
  autoFocus?: boolean
  /** Esc, or leaving the field without picking. */
  onCancel?(): void
  className?: string
}) {
  const api = useApi()
  const listId = useId()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [options, setOptions] = useState<PickOption[]>([])
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const kindsKey = kinds.join(',')
  const excludeKey = exclude.join(',')

  useEffect(() => {
    if (!open) return
    const mine = ++seq.current
    setLoading(true)
    const t = setTimeout(async () => {
      const text = q.trim()
      const pasted = kindOfId(text)
      const lists = await Promise.all(
        kindsKey.split(',').map((kind) =>
          api
            .listRecords(kind, { ...(text && !pasted ? { text } : {}), limit: 8, orderBy: 'updatedAt', dir: 'desc' })
            .then((p) => p.items.map((r) => ({ id: r.id, kind, label: recordLabel(r), detail: detailOf(r) })))
            .catch(() => [] as PickOption[]),
        ),
      )
      let found = lists.flat()
      if (pasted && kindsKey.split(',').includes(pasted)) {
        const r = await api.getRecord(pasted, text).catch(() => null)
        found = r ? [{ id: r.id, kind: pasted, label: recordLabel(r), detail: detailOf(r) }] : []
      }
      if (mine !== seq.current) return
      const skip = new Set(excludeKey.split(',').filter(Boolean))
      setOptions(found.filter((o) => !skip.has(o.id)).slice(0, 10))
      setActive(0)
      setLoading(false)
    }, 150)
    return () => clearTimeout(t)
  }, [api, q, open, kindsKey, excludeKey])

  const pick = (o: PickOption) => {
    setQ('')
    setOpen(false)
    onPick(o)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((a) => Math.min(a + 1, Math.max(options.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      if (open && options[active]) {
        e.preventDefault()
        pick(options[active])
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
      onCancel?.()
    }
  }

  return (
    <div className={cn('relative', className)}>
      <Input
        id={id}
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() =>
          setTimeout(() => {
            setOpen(false)
            onCancel?.()
          }, 150)
        }
        onKeyDown={onKey}
        placeholder={placeholder ?? `Search ${kinds.join(' or ')}…`}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        className="h-7 px-1.5 text-mini"
      />
      {open && (
        <div
          id={listId}
          role="listbox"
          data-testid="record-picker-options"
          className="absolute top-8 right-0 left-0 z-50 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {options.length === 0 ? (
            <div className="px-2 py-1.5 text-micro text-fg-tertiary">{loading ? 'Searching…' : 'No matches'}</div>
          ) : (
            options.map((o, i) => (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-mini',
                  i === active ? 'bg-secondary text-foreground' : 'text-fg-secondary',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.detail && <span className="max-w-32 shrink-0 truncate text-micro text-fg-tertiary">{o.detail}</span>}
                {kinds.length > 1 && <span className="shrink-0 text-micro text-fg-quaternary">{o.kind}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
