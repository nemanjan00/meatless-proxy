import { Bot } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar.tsx'
import { initials } from '@/lib/format.ts'
import { cn } from '@/lib/utils.ts'

const HUES = ['#5e6ad2', '#4ea7fc', '#27a644', '#f0bf00', '#fc7840', '#00b8cc', '#eb5757']

/** A stable colour per name. `Meatless`, `@meatless` and `@meatless#router` share one, so an employee and its sessions match. */
function hueFor(name: string) {
  const key = name
    .replace(/^@/, '')
    .split('#')[0]!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
  let h = 0
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return HUES[h % HUES.length]!
}

/** A person's avatar: initials on a colour derived from the name. */
export function PersonAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <Avatar className={cn('size-5', className)}>
      <AvatarFallback className="text-tiny font-semibold text-white" style={{ background: hueFor(name) }}>
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  )
}

/** An AI employee's avatar: a rounded square with a bot glyph (always recognisable as an AI). */
export function EmployeeAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn('inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] text-white', className)}
      style={{ background: name === 'All' ? 'var(--fg-quaternary)' : hueFor(name) }}
      title={name}
    >
      <Bot className="size-[70%]" strokeWidth={2} />
    </span>
  )
}

export function AuthorAvatar({
  type,
  name,
  className,
}: {
  type: 'employee' | 'session' | 'person'
  name: string
  className?: string
}) {
  return type === 'person' ? (
    <PersonAvatar name={name} className={className} />
  ) : (
    <EmployeeAvatar name={name} className={className} />
  )
}
