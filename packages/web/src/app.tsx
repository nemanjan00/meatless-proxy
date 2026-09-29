import { type ComponentType, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { AppShell } from '@/components/app-shell.tsx'
import { Toaster } from '@/components/ui/sonner.tsx'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { type DataLayer, DataProvider } from '@/lib/api.tsx'
import { EmployeesProvider } from '@/lib/employees.tsx'
import { ThemeProvider } from '@/lib/theme.tsx'

/** Pages load on demand, one chunk per route (see vite.config.ts for the vendor chunks). */
const page = <M extends Record<K, ComponentType<any>>, K extends keyof M>(load: () => Promise<M>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })))

const ChatPage = page(() => import('@/pages/chat.tsx'), 'ChatPage')
const EventsPage = page(() => import('@/pages/events.tsx'), 'EventsPage')
const FilesPage = page(() => import('@/pages/files.tsx'), 'FilesPage')
const InboxPage = page(() => import('@/pages/inbox.tsx'), 'InboxPage')
const LineagePage = page(() => import('@/pages/lineage.tsx'), 'LineagePage')
const NowPage = page(() => import('@/pages/now.tsx'), 'NowPage')
const RecordDetailPage = page(() => import('@/pages/records.tsx'), 'RecordDetailPage')
const RecordListPage = page(() => import('@/pages/records.tsx'), 'RecordListPage')
const SessionDetailPage = page(() => import('@/pages/session-detail.tsx'), 'SessionDetailPage')
const SessionsPage = page(() => import('@/pages/sessions.tsx'), 'SessionsPage')
const SettingsPage = page(() => import('@/pages/settings.tsx'), 'SettingsPage')
const TriggersPage = page(() => import('@/pages/triggers.tsx'), 'TriggersPage')
const UsagePage = page(() => import('@/pages/usage.tsx'), 'UsagePage')

/** Knowledge pages: one generic list and detail per record kind. */
export const KNOWLEDGE = [
  { path: 'projects', kind: 'project', title: 'Projects' },
  { path: 'contacts', kind: 'contact', title: 'Contacts' },
  { path: 'procedures', kind: 'procedure', title: 'Procedures' },
  { path: 'skills', kind: 'skill', title: 'Skills' },
  { path: 'memory', kind: 'memory', title: 'Memory' },
] as const

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/now" replace />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="now" element={<NowPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="sessions/:id" element={<SessionDetailPage />} />
        <Route path="lineage/:id" element={<LineagePage />} />
        <Route path="triggers" element={<TriggersPage />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="chat/:channelId" element={<ChatPage />} />
        <Route path="chat/:channelId/:threadId" element={<ChatPage />} />
        {KNOWLEDGE.map((k) => (
          <Route key={k.path} path={k.path} element={<RecordListPage kind={k.kind} title={k.title} basePath={`/${k.path}`} />} />
        ))}
        {KNOWLEDGE.map((k) => (
          <Route
            key={`${k.path}-d`}
            path={`${k.path}/:id`}
            element={<RecordDetailPage kind={k.kind} title={k.title} basePath={`/${k.path}`} />}
          />
        ))}
        <Route path="records/:kind/:id" element={<RecordDetailPage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="settings/:section" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/now" replace />} />
      </Route>
    </Routes>
  )
}

export function App({ data }: { data: DataLayer }) {
  return (
    <ThemeProvider>
      <DataProvider value={data}>
        <TooltipProvider delayDuration={400}>
          <EmployeesProvider>
            <AppRoutes />
          </EmployeesProvider>
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </DataProvider>
    </ThemeProvider>
  )
}
