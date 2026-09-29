import type { SessionListItem } from '@mp/api'
import { CirclePause, CirclePlay, Moon, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { EmployeeAvatar } from '@/components/people.tsx'
import { StatusIcon } from '@/components/status-icon.tsx'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command.tsx'
import { useApi } from '@/lib/api.tsx'
import { useEmployees } from '@/lib/employees.tsx'
import { NAV_SHORTCUTS, isTypingTarget, routeForSequence } from '@/lib/shortcuts.ts'
import { sessionStatusKey } from '@/lib/status.ts'

/** ⌘K: jump anywhere and run any action. Also installs the `G` navigation shortcuts. */
export function CommandMenu({
  open,
  onOpenChange,
  onToggleTheme,
}: {
  open: boolean
  onOpenChange(o: boolean): void
  onToggleTheme(): void
}) {
  const navigate = useNavigate()
  const api = useApi()
  const { employees, setCurrentId } = useEmployees()
  const [query, setQuery] = useState('')
  const [sessions, setSessions] = useState<SessionListItem[]>([])

  useEffect(() => {
    let first: string | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      if (e.shiftKey && e.key.toLowerCase() === 't') {
        onToggleTheme()
        return
      }
      if (first) {
        const to = routeForSequence(first, e.key)
        first = null
        if (to) {
          e.preventDefault()
          navigate(to)
        }
        return
      }
      if (e.key.toLowerCase() === 'g') {
        first = 'g'
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => (first = null), 1200)
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [navigate, onToggleTheme])

  useEffect(() => {
    if (!open) return
    let live = true
    api.listSessions({ text: query || undefined, limit: 8 }).then(
      (p) => live && setSessions(p.items),
      () => {},
    )
    return () => {
      live = false
    }
  }, [api, open, query])

  const go = (to: string) => {
    onOpenChange(false)
    navigate(to)
  }
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Command menu" description="Jump anywhere or run an action">
      <CommandInput placeholder="Type a command or search…" value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {sessions.length > 0 && (
          <CommandGroup heading="Sessions">
            {sessions.map((s) => (
              <CommandItem
                key={s.session.id}
                value={`session ${s.session.data.title} ${s.session.data.slug}`}
                onSelect={() => go(`/sessions/${s.session.id}`)}
              >
                <StatusIcon status={sessionStatusKey(s.session.data.status, s.runState)} tooltip={false} />
                <span className="truncate">{s.session.data.title}</span>
                <span className="ml-auto truncate text-micro text-fg-tertiary">{s.employee.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Go to">
          {NAV_SHORTCUTS.map((s) => (
            <CommandItem key={s.to} value={`go ${s.label}`} onSelect={() => go(s.to!)}>
              <Search className="text-fg-tertiary" />
              {s.label}
              <CommandShortcut>{s.keys.join(' ')}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem
            value="toggle theme dark light"
            onSelect={() => {
              onToggleTheme()
              onOpenChange(false)
            }}
          >
            <Moon />
            Toggle theme
            <CommandShortcut>⇧ T</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="pause all employees kill switch"
            onSelect={async () => {
              onOpenChange(false)
              await api.pauseAll()
              toast('All employees paused', { description: 'Runs stop at their next step boundary.' })
            }}
          >
            <CirclePause />
            Pause all employees
          </CommandItem>
          <CommandItem
            value="resume all employees"
            onSelect={async () => {
              onOpenChange(false)
              await api.resumeAll()
              toast('All employees resumed')
            }}
          >
            <CirclePlay />
            Resume all employees
          </CommandItem>
          {employees.map((e, i) => (
            <CommandItem
              key={e.id}
              value={`switch employee ${e.data.name}`}
              onSelect={() => {
                setCurrentId(e.id)
                onOpenChange(false)
              }}
            >
              <EmployeeAvatar name={e.data.name} className="size-4" />
              Switch to {e.data.name}
              <CommandShortcut>⌥ {i + 1}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
