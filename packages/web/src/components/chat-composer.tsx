import { Paperclip, Send } from 'lucide-react'
import { type DragEvent, forwardRef, type KeyboardEvent, useImperativeHandle, useRef, useState } from 'react'
import { PendingAttachments, usePendingAttachments } from '@/components/chat-attachments.tsx'
import { AuthorAvatar } from '@/components/people.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { applySuggestion, matchSuggestions, mentionAt, type TagSuggestion } from '@/lib/chat.ts'
import { cn } from '@/lib/utils.ts'

export interface ComposerHandle {
  focus(): void
}

/**
 * The chat composer: Enter sends, Shift+Enter is a new line, and typing `@`
 * opens tag suggestions (employees, their active sessions, people) that
 * ↑/↓ move through and Enter or Tab insert.
 */
export const Composer = forwardRef<
  ComposerHandle,
  {
    placeholder: string
    /** `attachments` are the ids of uploaded files and images (only with `attachments` on). */
    onSend(text: string, attachments: string[]): Promise<void>
    /** Images: an attach button, paste and drag and drop, uploaded as they are added. */
    attachments?: boolean
    compact?: boolean
    /** Tags to show in the hint, e.g. `@employee`, `@employee#slug`, `@person`. */
    examples?: string[]
    /** What `@` can complete to. */
    suggestions?: TagSuggestion[]
    className?: string
  }
>(function Composer(
  { placeholder, onSend, attachments = false, compact = false, examples = [], suggestions = [], className },
  ref,
) {
  const [text, setText] = useState('')
  const pending = usePendingAttachments()
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus() }), [])

  const mention = mentionAt(text, caret)
  const matches = mention && dismissed !== mention.start ? matchSuggestions(suggestions, mention.query) : []
  const open = matches.length > 0

  const canSend = (!!text.trim() || pending.ready.length > 0) && !pending.uploading && !pending.failed
  const send = async () => {
    if (!canSend || busy) return
    setBusy(true)
    try {
      await onSend(text.trim(), pending.ready)
      setText('')
      setCaret(0)
      pending.clear()
    } finally {
      setBusy(false)
    }
  }
  const pick = (s: TagSuggestion) => {
    if (!mention) return
    const next = applySuggestion(text, mention.start, caret, s)
    setText(next.text)
    setCaret(next.caret)
    setActive(0)
    requestAnimationFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(next.caret, next.caret)
    })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const d = e.key === 'ArrowDown' ? 1 : -1
        setActive((a) => (a + d + matches.length) % matches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(matches[Math.min(active, matches.length - 1)]!)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(mention!.start)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }
  return (
    // The whole box reads as the input, so a press anywhere in it that isn't
    // on a control (the hint row, the padding) focuses the textarea.
    // biome-ignore lint/a11y/noStaticElementInteractions: the textarea inside is the accessible control
    <div
      className={cn(
        'relative m-4 cursor-text rounded-lg border bg-level-1 focus-within:border-ring/70',
        dragging && 'border-ring/70 bg-accent-tint',
        className,
      )}
      data-testid="composer"
      onMouseDown={(e) => {
        const target = e.target as HTMLElement
        if (target.closest('textarea, button, a, input, [role="listbox"]')) return
        e.preventDefault()
        area.current?.focus()
      }}
      {...(attachments
        ? {
            onDragOver: (e: DragEvent) => {
              if (![...e.dataTransfer.types].includes('Files')) return
              e.preventDefault()
              setDragging(true)
            },
            onDragLeave: (e: DragEvent) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
            },
            onDrop: (e: DragEvent) => {
              if (!e.dataTransfer.files.length) return
              e.preventDefault()
              setDragging(false)
              pending.add(e.dataTransfer.files)
            },
          }
        : {})}
    >
      {open && (
        <div
          role="listbox"
          aria-label="Tag suggestions"
          className="absolute bottom-full left-0 z-30 mb-1 w-full max-w-sm overflow-hidden rounded-lg border bg-popover p-1 shadow-medium"
          data-testid="tag-suggestions"
        >
          {matches.map((s, i) => (
            <button
              key={`${s.type}:${s.id}`}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(s)
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-mini',
                i === active && 'bg-accent text-foreground',
              )}
            >
              <AuthorAvatar type={s.type} name={s.type === 'session' ? s.insert : s.label} className="size-4" />
              <span className="min-w-0 truncate text-fg-secondary">{s.label}</span>
              <span className="ml-auto max-w-[55%] shrink-0 truncate font-mono text-micro text-fg-tertiary">{s.insert}</span>
            </button>
          ))}
        </div>
      )}
      {attachments && <PendingAttachments items={pending.items} onRemove={pending.remove} />}
      <Textarea
        ref={area}
        onPaste={(e) => {
          if (!attachments) return
          const files = [...e.clipboardData.files]
          if (!files.length) return
          e.preventDefault()
          pending.add(files)
        }}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setCaret(e.target.selectionStart ?? e.target.value.length)
          setActive(0)
          setDismissed(null)
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label="Message"
        aria-autocomplete="list"
        aria-expanded={open}
        className="min-h-12 resize-none border-0 bg-transparent text-small shadow-none dark:bg-transparent"
      />
      <div className="flex items-center gap-2 px-2 pb-2 text-micro text-fg-quaternary">
        {attachments && (
          <>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              data-testid="attach-input"
              onChange={(e) => {
                if (e.target.files) pending.add(e.target.files)
                e.target.value = ''
              }}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Attach files"
              title="Attach files or images (or paste, or drop them here)"
              onClick={() => picker.current?.click()}
              className="text-fg-tertiary"
            >
              <Paperclip />
            </Button>
          </>
        )}
        {pending.notice && (
          <span className="min-w-0 truncate text-destructive" role="status" data-testid="attach-notice">
            {pending.notice}
          </span>
        )}
        {!compact && !pending.notice && (
          <span className="hidden min-w-0 truncate sm:inline" data-testid="tag-hint">
            {examples.length ? (
              <>
                Type <code className="font-mono">@</code> to tag, e.g.{' '}
                {examples.map((x, i) => (
                  <span key={x}>
                    {i > 0 && (i === examples.length - 1 ? ' or ' : ', ')}
                    <code className="font-mono">{x}</code>
                  </span>
                ))}
              </>
            ) : (
              'Type @ to tag an employee, a session or a person'
            )}
          </span>
        )}
        <Button size="sm" className="ml-auto" onClick={send} disabled={busy || !canSend}>
          <Send /> Send
        </Button>
      </div>
    </div>
  )
})
