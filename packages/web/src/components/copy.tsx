import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { cn } from '@/lib/utils.ts'

/** Copies text to the clipboard; false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** A small copy button: a check for a moment after copying. */
export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1500)
    return () => clearTimeout(t)
  }, [done])
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          className={cn('shrink-0 text-fg-tertiary hover:text-foreground', className)}
          onClick={async () => {
            if (await copyText(value)) setDone(true)
            else toast('Couldn’t copy: select the text and copy it by hand')
          }}
        >
          {done ? <Check className="text-[var(--green)]" /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{done ? 'Copied' : label}</TooltipContent>
    </Tooltip>
  )
}

/** A value to copy: monospace, on one line (or wrapped with `multiline`), with a copy button. */
export function CopyField({
  value,
  label,
  multiline = false,
  className,
}: {
  value: string
  /** What the copy button says, e.g. "Copy request URL". */
  label?: string
  multiline?: boolean
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 items-start gap-1 rounded-md border bg-level-2 py-1 pr-1 pl-2.5', className)}>
      <code
        className={cn(
          'min-w-0 flex-1 py-0.5 font-mono text-micro text-fg-secondary',
          multiline ? 'max-h-32 overflow-auto break-all whitespace-pre-wrap' : 'truncate',
        )}
        title={multiline ? undefined : value}
      >
        {value}
      </code>
      <CopyButton value={value} label={label ?? 'Copy'} />
    </div>
  )
}
