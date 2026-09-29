import type { ReactNode } from 'react'
import { SidebarTrigger } from '@/components/ui/sidebar.tsx'
import { cn } from '@/lib/utils.ts'

/** A page: a 44px header bar with the title and actions, an optional filter bar, then the body. */
export function Page({
  title,
  icon,
  actions,
  filters,
  children,
  className,
}: {
  title: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  filters?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className="flex h-svh min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger className="-ml-1 text-fg-tertiary md:hidden" />
        {icon && <span className="text-fg-tertiary [&_svg]:size-4">{icon}</span>}
        <h1 className="min-w-0 truncate font-medium text-foreground">{title}</h1>
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      </header>
      {filters && <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5">{filters}</div>}
      <div className={cn('min-h-0 flex-1 overflow-auto', className)}>{children}</div>
    </div>
  )
}

/** A section heading inside a page or panel (12px, tertiary). */
export function SectionTitle({ children, className, actions }: { children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <div className={cn('flex items-center gap-2 text-micro font-medium text-fg-tertiary', className)}>
      <span>{children}</span>
      {actions && <span className="ml-auto flex items-center gap-1">{actions}</span>}
    </div>
  )
}
