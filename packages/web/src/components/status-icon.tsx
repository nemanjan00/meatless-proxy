import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  CircleSlash,
  CircleX,
  type LucideIcon,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { STATUS, type StatusKey } from '@/lib/status.ts'
import { cn } from '@/lib/utils.ts'

const ICONS: Record<string, LucideIcon> = {
  circle: Circle,
  'circle-dashed': CircleDashed,
  'circle-dot': CircleDot,
  'circle-pause': CirclePause,
  'circle-alert': CircleAlert,
  'circle-check': CircleCheck,
  'circle-x': CircleX,
  'circle-slash': CircleSlash,
}

/** The stylebook's status icon: a small coloured lucide icon in front of a title. */
export function StatusIcon({ status, className, tooltip = true }: { status: StatusKey; className?: string; tooltip?: boolean }) {
  const s = STATUS[status]
  const Icon = ICONS[s.icon]!
  const icon = (
    <Icon
      aria-label={s.label}
      role="img"
      data-status={status}
      className={cn('size-4 shrink-0', s.animated && 'animate-status', className)}
      style={{ color: s.color }}
      strokeWidth={1.75}
    />
  )
  if (!tooltip) return icon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{icon}</span>
      </TooltipTrigger>
      <TooltipContent>{s.label}</TooltipContent>
    </Tooltip>
  )
}

export function StatusLabel({ status }: { status: StatusKey }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-fg-secondary">
      <StatusIcon status={status} tooltip={false} />
      {STATUS[status].label}
    </span>
  )
}
