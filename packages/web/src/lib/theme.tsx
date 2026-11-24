import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'

/** `system` follows the OS setting until the user picks one (stylebook: dark by default). */
export type ThemeChoice = 'system' | 'dark' | 'light'

interface ThemeState {
  choice: ThemeChoice
  resolved: 'dark' | 'light'
  setChoice(choice: ThemeChoice): void
  /** Switches dark and light; the new theme grows as a circle from `from` (default: the theme button). */
  toggle(from?: { x: number; y: number }): void
}

const STORAGE_KEY = 'mp.theme'
/** The theme button carries this attribute: a toggle from a shortcut or the command menu grows from it. */
export const THEME_TOGGLE_ATTR = 'data-theme-toggle'

/** Where the reveal circle starts: the given point, else the theme button's centre, else the top right. */
function revealOrigin(from?: { x: number; y: number }): { x: number; y: number } {
  if (from) return from
  const r = document.querySelector(`[${THEME_TOGGLE_ATTR}]`)?.getBoundingClientRect()
  return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: window.innerWidth, y: 0 }
}

/**
 * Runs `apply` (which switches the theme) as a View Transition whose new snapshot is revealed by a circle
 * growing from `from` (styles/globals.css, `theme-reveal`), as the Kicksta dashboard does. The centre and
 * radius go on <html> before the transition starts, so the circle clips from the very first frame. Without
 * View Transitions, or with reduced motion, the theme just switches.
 */
function revealTheme(apply: () => void, from?: { x: number; y: number }) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (typeof document.startViewTransition !== 'function' || reduced) return apply()
  const { x, y } = revealOrigin(from)
  const root = document.documentElement
  root.style.setProperty('--theme-x', `${x}px`)
  root.style.setProperty('--theme-y', `${y}px`)
  root.style.setProperty('--theme-r', `${Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))}px`)
  const t = document.startViewTransition(() => flushSync(apply))
  t.finished
    .finally(() => {
      for (const v of ['--theme-x', '--theme-y', '--theme-r']) root.style.removeProperty(v)
    })
    .catch(() => undefined)
}
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
    () => ({
      choice,
      resolved,
      setChoice,
      toggle: (from) => {
        const next = resolved === 'dark' ? 'light' : 'dark'
        revealTheme(() => {
          // The class now, not in the effect: the transition's new snapshot must already show the new theme.
          document.documentElement.classList.toggle('dark', next === 'dark')
          setChoice(next)
        }, from)
      },
    }),
    [choice, resolved, setChoice],
  )
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext)
  if (!ctx) return { choice: 'dark', resolved: 'dark', setChoice: () => {}, toggle: () => {} }
  return ctx
}
