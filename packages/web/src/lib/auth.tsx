import type { Access, Me } from '@mp/api'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation } from 'react-router'
import { useData } from '@/lib/api.tsx'

/** Fired by the data layer on every 401: the sign-in is gone, show the login page. */
export const UNAUTHORIZED_EVENT = 'mp:unauthorized'

const RANK: Record<Access, number> = { viewer: 0, member: 1, admin: 2 }

/** Whether `have` is at least `need` (viewer < member < admin). */
export const atLeast = (have: Access | undefined, need: Access) => !!have && RANK[have] >= RANK[need]

export interface AuthState {
  /** Who is signed in; null when nobody is (or not loaded yet). */
  me: Me | null
  loading: boolean
  /** Whether the signed-in person has at least this access. The server enforces it anyway. */
  can(need: Access): boolean
  signOut(): Promise<void>
  reload(): void
}

const Ctx = createContext<AuthState | null>(null)

/** Loads the signed-in person (`GET /api/me`) and drops it on any 401 from the API. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { api } = useData()
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick reloads
  useEffect(() => {
    let live = true
    setLoading(true)
    api.me().then(
      (m) => {
        if (!live) return
        setMe(m)
        setLoading(false)
      },
      () => {
        if (!live) return
        setMe(null)
        setLoading(false)
      },
    )
    return () => {
      live = false
    }
  }, [api, tick])

  useEffect(() => {
    const off = () => setMe(null)
    window.addEventListener(UNAUTHORIZED_EVENT, off)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, off)
  }, [])

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {})
    setMe(null)
  }, [api])
  const reload = useCallback(() => setTick((t) => t + 1), [])

  const value = useMemo<AuthState>(
    () => ({ me, loading, can: (need) => atLeast(me?.access, need), signOut, reload }),
    [me, loading, signOut, reload],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}

/** Renders its children for a signed-in person, and sends everyone else to the login page (and back after). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth()
  const { pathname, search } = useLocation()
  if (loading) return <div className="h-svh bg-background" aria-busy="true" />
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(pathname + search)}`} replace />
  return <>{children}</>
}

/** The CSRF token the server set at sign-in (`mp_csrf`), echoed in `x-mp-csrf` on every request. */
export function csrfToken(cookie: string = typeof document === 'undefined' ? '' : document.cookie): string | undefined {
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === 'mp_csrf') return decodeURIComponent(v.join('='))
  }
  return undefined
}

/**
 * Shows its children only to people with at least `need` access (default: member), and
 * `fallback` (default: nothing) to everyone else. For hiding actions; the server enforces access anyway.
 */
export function Can({
  need = 'member',
  fallback = null,
  children,
}: {
  need?: Access
  fallback?: ReactNode
  children: ReactNode
}) {
  const { can } = useAuth()
  return <>{can(need) ? children : fallback}</>
}

/** The line shown instead of a message box to people who can only read. */
export function ReadOnlyNote({ text = 'You have read-only access here.' }: { text?: string }) {
  return <p className="border-t px-4 py-3 text-micro text-fg-quaternary">{text}</p>
}
