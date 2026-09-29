import type { ReactNode } from 'react'
import { cn } from '@/lib/utils.ts'

/** Stylebook empty state: one line of tertiary text and one action, no illustration. */
export function EmptyState({ text, action, className }: { text: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 py-16 text-center', className)}>
      <p className="text-fg-tertiary">{text}</p>
      {action}
    </div>
  )
}

export function LoadingRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col" role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="flex h-9 items-center gap-3 px-6">
          <div className="size-3.5 rounded-full bg-level-3" />
          <div className="h-3 rounded bg-level-3" style={{ width: `${30 + ((i * 17) % 40)}%` }} />
        </div>
      ))}
    </div>
  )
}

export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <p className="text-fg-tertiary">Couldn't load this: {error.message}</p>
      {retry && (
        <button type="button" onClick={retry} className="text-[#828fff] hover:underline">
          Try again
        </button>
      )}
    </div>
  )
}
