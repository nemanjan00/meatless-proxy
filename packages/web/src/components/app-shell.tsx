import {
  Activity,
  BookOpen,
  Brain,
  ChartBar,
  Check,
  ChevronsUpDown,
  FileText,
  FolderKanban,
  IdCard,
  Inbox,
  KeyRound,
  Layers,
  LogOut,
  MessagesSquare,
  Moon,
  Radio,
  Search,
  Settings,
  Sparkles,
  Sun,
  Users,
  Workflow,
  Zap,
} from 'lucide-react'
import { type ReactNode, Suspense, useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { CommandMenu } from '@/components/command-menu.tsx'
import { EmployeeAvatar, PersonAvatar } from '@/components/people.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { Kbd } from '@/components/ui/kbd.tsx'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
} from '@/components/ui/sidebar.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useData, useLiveReload, useLiveStatus, useLoad } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'
import { useEmployees } from '@/lib/employees.tsx'
import { NAV_SHORTCUTS } from '@/lib/shortcuts.ts'
import { useTheme } from '@/lib/theme.tsx'
import { cn } from '@/lib/utils.ts'

interface NavItem {
  to: string
  label: string
  icon: ReactNode
  badge?: number
}

function shortcutFor(to: string) {
  return NAV_SHORTCUTS.find((s) => s.to === to)?.keys
}

function NavGroup({ label, items }: { label?: string; items: NavItem[] }) {
  const { pathname } = useLocation()
  return (
    <SidebarGroup className="py-1">
      {label && <SidebarGroupLabel className="h-7 text-micro text-fg-tertiary">{label}</SidebarGroupLabel>}
      <SidebarGroupContent>
        <SidebarMenu className="gap-px">
          {items.map((item) => {
            const active = pathname === item.to || pathname.startsWith(`${item.to}/`)
            const keys = shortcutFor(item.to)
            return (
              <SidebarMenuItem key={item.to}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      className={cn(
                        'h-7 gap-2.5 px-2 text-sidebar-foreground [&>svg]:size-4 [&>svg]:text-fg-tertiary',
                        active && 'bg-sidebar-accent text-foreground [&>svg]:text-foreground',
                      )}
                    >
                      <NavLink to={item.to}>
                        {item.icon}
                        <span>{item.label}</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </TooltipTrigger>
                  {keys && (
                    <TooltipContent side="right" className="flex items-center gap-1.5">
                      {item.label}
                      {keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </TooltipContent>
                  )}
                </Tooltip>
                {item.badge ? <SidebarMenuBadge className="text-tiny text-fg-tertiary">{item.badge}</SidebarMenuBadge> : null}
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function EmployeeSwitcher() {
  const { employees, current, setCurrentId } = useEmployees()
  const label = current?.data.name ?? 'All employees'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton className="h-9 gap-2 px-2 data-[state=open]:bg-sidebar-accent" aria-label="Switch employee">
          <EmployeeAvatar name={current?.data.name ?? 'All'} className="size-5" />
          <span className="truncate font-medium text-foreground">{label}</span>
          <ChevronsUpDown className="ml-auto size-3.5 text-fg-tertiary" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-micro text-fg-tertiary">Employees</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setCurrentId(null)}>
          <Layers className="size-4" />
          All employees
          {!current && <Check className="ml-auto size-4" />}
        </DropdownMenuItem>
        {employees.map((e, i) => (
          <DropdownMenuItem key={e.id} onSelect={() => setCurrentId(e.id)}>
            <EmployeeAvatar name={e.data.name} className="size-4" />
            {e.data.name}
            {current?.id === e.id ? <Check className="ml-auto size-4" /> : <DropdownMenuShortcut>⌥{i + 1}</DropdownMenuShortcut>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {current && (
          <DropdownMenuItem asChild>
            <NavLink to={`/employees/${current.id}`}>
              <IdCard className="size-4" />
              {current.data.name}’s page
            </NavLink>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <NavLink to="/settings/employees">
            <Settings className="size-4" />
            Manage employees
          </NavLink>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function LiveIndicator() {
  const status = useLiveStatus()
  const { mock } = useData()
  const color = status === 'open' ? 'var(--green)' : status === 'connecting' ? 'var(--yellow)' : 'var(--red)'
  const text = status === 'open' ? 'Live' : status === 'connecting' ? 'Reconnecting' : 'Offline'
  return (
    <div className="flex items-center gap-2 px-2 text-micro text-fg-tertiary" title={mock ? 'Mock data' : undefined}>
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {text}
      {mock && <span className="rounded-sm border px-1 text-tiny">mock</span>}
    </div>
  )
}

function ThemeToggle() {
  const { resolved, toggle } = useTheme()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggle}
          className="inline-flex size-7 items-center justify-center rounded-md text-fg-tertiary transition-quick hover:bg-sidebar-accent hover:text-foreground"
          aria-label="Toggle theme"
        >
          {resolved === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-1.5">
        {resolved === 'dark' ? 'Light theme' : 'Dark theme'} <Kbd>⇧</Kbd>
        <Kbd>T</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

/** The signed-in person, in the sidebar footer: their access, their API tokens, and signing out. */
function UserMenu() {
  const { me, signOut } = useAuth()
  const navigate = useNavigate()
  if (!me) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton className="h-9 gap-2 px-2 data-[state=open]:bg-sidebar-accent" aria-label="Your account">
          <PersonAvatar name={me.name} className="size-5" />
          <span className="min-w-0 truncate text-foreground">{me.name}</span>
          <span className="ml-auto rounded-sm border px-1 text-tiny text-fg-tertiary">{me.access}</span>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-foreground">{me.name}</div>
          <div className="truncate text-micro text-fg-tertiary">{me.email ?? `Signed in as a ${me.access}`}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <NavLink to="/settings/tokens">
            <KeyRound className="size-4" />
            API tokens
          </NavLink>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={async () => {
            await signOut()
            navigate('/login', { replace: true })
          }}
        >
          <LogOut className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppSidebar({ onSearch }: { onSearch: () => void }) {
  const inbox = useLoad((api) => api.inbox(), [])
  useLiveReload(['now'], inbox.reload, ['run.state'])
  const unread = inbox.data?.filter((i) => !i.read).length ?? 0
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="gap-1 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <EmployeeSwitcher />
          </SidebarMenuItem>
        </SidebarMenu>
        <button
          type="button"
          onClick={onSearch}
          className="flex h-7 items-center gap-2 rounded-md border bg-background/40 px-2 text-fg-tertiary transition-quick hover:text-fg-secondary"
        >
          <Search className="size-3.5" />
          <span>Search or jump to…</span>
          <span className="ml-auto flex gap-0.5">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
      </SidebarHeader>
      <SidebarContent className="gap-0">
        <NavGroup
          items={[
            { to: '/inbox', label: 'Inbox', icon: <Inbox />, badge: unread },
            { to: '/now', label: 'Now', icon: <Activity /> },
            { to: '/sessions', label: 'Sessions', icon: <Workflow /> },
            { to: '/chat', label: 'Chat', icon: <MessagesSquare /> },
          ]}
        />
        <NavGroup
          label="Routing"
          items={[
            { to: '/triggers', label: 'Triggers', icon: <Zap /> },
            { to: '/events', label: 'Events', icon: <Radio /> },
          ]}
        />
        <NavGroup
          label="Knowledge"
          items={[
            { to: '/projects', label: 'Projects', icon: <FolderKanban /> },
            { to: '/procedures', label: 'Procedures', icon: <BookOpen /> },
            { to: '/contacts', label: 'Contacts', icon: <Users /> },
            { to: '/memory', label: 'Memory', icon: <Brain /> },
            { to: '/skills', label: 'Skills', icon: <Sparkles /> },
            { to: '/files', label: 'Files', icon: <FileText /> },
          ]}
        />
        <NavGroup
          label="Workspace"
          items={[
            { to: '/usage', label: 'Usage', icon: <ChartBar /> },
            { to: '/settings', label: 'Settings', icon: <Settings /> },
          ]}
        />
      </SidebarContent>
      <SidebarFooter className="gap-1 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <UserMenu />
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="flex items-center justify-between">
          <LiveIndicator />
          <ThemeToggle />
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

/** The app shell: collapsible sidebar, the page, the command menu and global shortcuts. */
export function AppShell() {
  const [open, setOpen] = useState(false)
  const { toggle } = useTheme()
  const { employees, setCurrentId } = useEmployees()
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
      if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
        const emp = employees[Number(e.code.slice(5)) - 1]
        if (emp) setCurrentId(emp.id)
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [employees, setCurrentId])
  return (
    <SidebarProvider>
      <AppSidebar onSearch={() => setOpen(true)} />
      <SidebarInset className="min-w-0">
        <Suspense fallback={<div className="h-11 border-b" aria-busy="true" />}>
          <Outlet />
        </Suspense>
      </SidebarInset>
      <CommandMenu open={open} onOpenChange={setOpen} onToggleTheme={toggle} />
    </SidebarProvider>
  )
}
