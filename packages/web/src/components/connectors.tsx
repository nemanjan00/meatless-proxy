import { type RefObject, useLayoutEffect, useRef, useState } from 'react'

export interface Connector {
  from: string
  to: string
  key: string
  hot?: boolean
  dashed?: boolean
}

/**
 * Draws curves between DOM elements marked `data-anchor="<id>"` inside a
 * scrolling container: from the right edge of `from` to the left edge of
 * `to`. Recomputes on resize, when the connectors change, and when
 * `version` changes (e.g. new data moved the anchors).
 */
export function useConnectors(box: RefObject<HTMLElement | null>, connectors: Connector[], version: unknown) {
  const [state, setState] = useState<{ paths: (Connector & { d: string })[]; w: number; h: number }>({ paths: [], w: 0, h: 0 })
  const current = useRef(connectors)
  current.current = connectors
  const key = connectors.map((c) => `${c.key}:${c.hot ? 1 : 0}`).join('|')
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the connector list and the caller's version
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const compute = () => {
      const base = el.getBoundingClientRect()
      const r = (id: string) => el.querySelector(`[data-anchor="${CSS.escape(id)}"]`)?.getBoundingClientRect()
      const paths: (Connector & { d: string })[] = []
      for (const c of current.current) {
        const a = r(c.from)
        const b = r(c.to)
        if (!a || !b) continue
        const x1 = a.right - base.left + el.scrollLeft
        const y1 = a.top + a.height / 2 - base.top + el.scrollTop
        const x2 = b.left - base.left + el.scrollLeft
        const y2 = b.top + b.height / 2 - base.top + el.scrollTop
        const mx = (x1 + x2) / 2
        paths.push({ ...c, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` })
      }
      setState({ paths, w: el.scrollWidth, h: el.scrollHeight })
    }
    compute()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(compute)
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [box, key, version])
  return state
}

export function ConnectorLayer({ paths, w, h }: { paths: (Connector & { d: string })[]; w: number; h: number }) {
  return (
    <svg className="pointer-events-none absolute top-0 left-0" width={w} height={h} aria-hidden="true">
      {paths.map((p) => (
        <path
          key={p.key}
          d={p.d}
          fill="none"
          stroke={p.hot ? 'var(--ring)' : 'var(--input)'}
          strokeWidth={p.hot ? 1.5 : 1}
          strokeDasharray={p.dashed ? '4 3' : undefined}
        />
      ))}
    </svg>
  )
}
