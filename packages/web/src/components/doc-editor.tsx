import { Pencil } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Markdown } from '@/components/markdown.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Kbd } from '@/components/ui/kbd.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { cn } from '@/lib/utils.ts'

/** Drops a leading `# Title` line that repeats the page title. */
export function stripTitle(markdown: string, title: string): string {
  const m = /^\s*#\s+(.+)\n+/.exec(markdown)
  if (!m) return markdown
  const norm = (x: string) =>
    x
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
  const a = norm(m[1]!)
  const b = norm(title)
  return a === b || b.startsWith(a) || a.startsWith(b) ? markdown.slice(m[0].length) : markdown
}

/**
 * A markdown document, rendered, with an in-place editor: a plain textarea
 * with a live preview (the stylebook leaves the rich editor open). ⌘↵ saves,
 * Esc cancels.
 */
export function DocumentEditor({
  value,
  onSave,
  placeholder = 'No document yet.',
  resolve,
  className,
  title,
}: {
  /** When the document starts with this title as its H1, the heading isn't repeated. */
  title?: string
  value: string
  onSave?: (next: string) => Promise<void> | void
  placeholder?: string
  resolve?: (kind: string, id: string) => string | undefined
  className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])
  const save = async () => {
    if (!onSave) return
    setSaving(true)
    try {
      await onSave(draft)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }
  if (!editing)
    return (
      <div className={cn('group relative', className)}>
        {value ? (
          <Markdown text={title ? stripTitle(value, title) : value} resolve={resolve} />
        ) : (
          <p className="text-fg-tertiary">{placeholder}</p>
        )}
        {onSave && (
          <Button
            variant="ghost"
            size="xs"
            className="absolute -top-1 right-0 text-fg-tertiary opacity-0 transition-quick group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => setEditing(true)}
          >
            <Pencil /> Edit
          </Button>
        )}
      </div>
    )
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="grid gap-3 lg:grid-cols-2">
        <Textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="min-h-80 font-mono text-micro leading-relaxed"
          aria-label="Document markdown"
        />
        <div className="min-h-80 overflow-auto rounded-md border bg-level-1 p-3">
          <Markdown text={draft} resolve={resolve} />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 text-micro text-fg-tertiary">
        <span className="mr-auto">
          Link records with <code className="font-mono">[[kind:id|label]]</code>
        </span>
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
          Cancel <Kbd>Esc</Kbd>
        </Button>
        <Button size="sm" onClick={save} disabled={saving}>
          Save <Kbd className="bg-white/15 text-white">⌘↵</Kbd>
        </Button>
      </div>
    </div>
  )
}
