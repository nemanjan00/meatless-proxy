import { useEffect, useState } from 'react'
import { Markdown } from '@/components/markdown.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { cn } from '@/lib/utils.ts'

const WIDE = 1024

/** Whether the window is at least `px` wide, following resizes. */
function useWide(px = WIDE): boolean {
  const [wide, setWide] = useState(() => typeof window === 'undefined' || window.innerWidth >= px)
  useEffect(() => {
    const on = () => setWide(window.innerWidth >= px)
    window.addEventListener('resize', on)
    on()
    return () => window.removeEventListener('resize', on)
  }, [px])
  return wide
}

/**
 * A markdown editor with a live preview: side by side on wide screens, Write and Preview tabs on
 * narrow ones (the stylebook leaves the rich editor open). ⌘↵ calls `onSubmit`, Esc `onCancel`.
 */
export function StepsEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  resolve,
  id,
  minHeight = 'min-h-72',
  className,
  label = 'Steps (markdown)',
}: {
  value: string
  onChange(next: string): void
  onSubmit?(): void
  onCancel?(): void
  resolve?: (kind: string, id: string) => string | undefined
  id?: string
  minHeight?: string
  className?: string
  label?: string
}) {
  const [tab, setTab] = useState('write')
  const wide = useWide()
  const textarea = (
    <Textarea
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          onSubmit?.()
        }
        if (e.key === 'Escape' && onCancel) {
          e.stopPropagation()
          onCancel()
        }
      }}
      spellCheck
      className={cn(minHeight, 'resize-y font-mono text-micro leading-relaxed')}
      aria-label={label}
    />
  )
  const preview = (
    <section
      className={cn(minHeight, 'overflow-auto rounded-md border bg-level-1 px-4 py-3')}
      data-testid="steps-preview"
      aria-label="Preview"
    >
      {value.trim() ? <Markdown text={value} resolve={resolve} /> : <p className="text-fg-quaternary">Nothing to preview yet.</p>}
    </section>
  )
  if (wide)
    return (
      <div className={cn('grid grid-cols-2 gap-3', className)}>
        {textarea}
        {preview}
      </div>
    )
  return (
    <Tabs value={tab} onValueChange={setTab} className={className}>
      <TabsList variant="line" className="h-8 justify-start gap-3 border-b pb-0">
        <TabsTrigger value="write" className="flex-none px-0">
          Write
        </TabsTrigger>
        <TabsTrigger value="preview" className="flex-none px-0">
          Preview
        </TabsTrigger>
      </TabsList>
      <TabsContent value="write" className="pt-2">
        {textarea}
      </TabsContent>
      <TabsContent value="preview" className="pt-2">
        {preview}
      </TabsContent>
    </Tabs>
  )
}
