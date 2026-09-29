import { Navigate, Route, Routes } from 'react-router'
import { AppShell } from '@/components/app-shell.tsx'
import { Toaster } from '@/components/ui/sonner.tsx'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { type DataLayer, DataProvider } from '@/lib/api.tsx'
import { EmployeesProvider } from '@/lib/employees.tsx'
import { ThemeProvider } from '@/lib/theme.tsx'
import { ChatPage } from '@/pages/chat.tsx'
import { EventsPage } from '@/pages/events.tsx'
import { FilesPage } from '@/pages/files.tsx'
import { InboxPage } from '@/pages/inbox.tsx'
import { LineagePage } from '@/pages/lineage.tsx'
import { NowPage } from '@/pages/now.tsx'
import { RecordDetailPage, RecordListPage } from '@/pages/records.tsx'
import { SessionDetailPage } from '@/pages/session-detail.tsx'
import { SessionsPage } from '@/pages/sessions.tsx'
import { SettingsPage } from '@/pages/settings.tsx'
import { TriggersPage } from '@/pages/triggers.tsx'
import { UsagePage } from '@/pages/usage.tsx'

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
