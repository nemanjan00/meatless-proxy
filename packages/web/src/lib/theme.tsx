import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'

/** `system` follows the OS setting until the user picks one (stylebook: dark by default). */
export type ThemeChoice = 'system' | 'dark' | 'light'

interface ThemeState {
  choice: ThemeChoice
  resolved: 'dark' | 'light'
  setChoice(choice: ThemeChoice): void
  toggle(): void
}

const STORAGE_KEY = 'mp.theme'
const ThemeContext = createContext<ThemeState | null>(null)

function systemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function readChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'dark' || v === 'light' || v === 'system') return v
  } catch {
    // storage unavailable
  }
  return 'system'
}

/** Resolves a choice to the theme to render. With no system preference, dark wins. */
export function resolveTheme(choice: ThemeChoice, system: 'dark' | 'light'): 'dark' | 'light' {
  return choice === 'system' ? system : choice
}

export function ThemeProvider({ children, initial }: { children: ReactNode; initial?: ThemeChoice }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => initial ?? readChoice())
  const [system, setSystem] = useState<'dark' | 'light'>(systemTheme)
  const resolved = resolveTheme(choice, system)

  useEffect(() => {
    if (!window.matchMedia) return
    const mql = window.matchMedia('(prefers-color-scheme: light)')
    const on = () => setSystem(mql.matches ? 'light' : 'dark')
    mql.addEventListener?.('change', on)
    return () => mql.removeEventListener?.('change', on)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark')
  }, [resolved])

  const setChoice = useCallback((c: ThemeChoice) => {
    setChoiceState(c)
    try {
      localStorage.setItem(STORAGE_KEY, c)
    } catch {
      // storage unavailable
    }
  }, [])

  const value = useMemo<ThemeState>(
    () => ({ choice, resolved, setChoice, toggle: () => setChoice(resolved === 'dark' ? 'light' : 'dark') }),
    [choice, resolved, setChoice],
  )
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext)
  if (!ctx) return { choice: 'dark', resolved: 'dark', setChoice: () => {}, toggle: () => {} }
  return ctx
}
