import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => cleanup())

// findBy*/waitFor wait 1 s by default: a full run (a worker per file, in parallel) renders slower than that now
// and then, and pages failed to appear in time on CI and locally. Tests still have 20 s each.
configure({ asyncUtilTimeout: 5000 })

// jsdom lacks these browser APIs used by Radix, Recharts and the layout code.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const g = globalThis as Record<string, unknown>
g.ResizeObserver ??= RO
if (!window.matchMedia)
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
if (!('CSS' in globalThis) || !CSS.escape)
  (globalThis as { CSS: { escape(s: string): string } }).CSS = { escape: (s: string) => s.replace(/"/g, '\\"') }
