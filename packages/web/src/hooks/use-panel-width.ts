import { type KeyboardEvent, type PointerEvent, useCallback, useState } from 'react'

const STEP = 16

function readWidth(key: string): number | null {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

function saveWidth(key: string, width: number) {
  try {
    localStorage.setItem(key, String(Math.round(width)))
  } catch {
    // Storage can be blocked; the width then lasts until reload.
  }
}

/**
 * The width of a panel docked to the right edge, resized by dragging (or with
 * ←/→ on) a handle on its left edge. The width is clamped to `min`..`max`,
 * leaves at least `reserve` px of the window to the rest of the page, and is
 * remembered per viewer under `key`.
 */
export function usePanelWidth(
  key: string,
  { initial, min, max, reserve = 0 }: { initial: number; min: number; max: number; reserve?: number },
) {
  const clamp = useCallback(
    (w: number) => Math.round(Math.max(min, Math.min(max, window.innerWidth - reserve, w))),
    [min, max, reserve],
  )
  const [width, setWidth] = useState(() => clamp(readWidth(key) ?? initial))

  const set = useCallback(
    (w: number) => {
      const next = clamp(w)
      setWidth(next)
      saveWidth(key, next)
    },
    [clamp, key],
  )

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const startX = e.clientX
      const startWidth = width
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      const move = (ev: globalThis.PointerEvent) => set(startWidth + (startX - ev.clientX))
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [width, set],
  )

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'ArrowLeft') set(width + STEP)
      else if (e.key === 'ArrowRight') set(width - STEP)
      else if (e.key === 'Home') set(max)
      else if (e.key === 'End') set(min)
      else return
      e.preventDefault()
    },
    [width, set, min, max],
  )

  return {
    width,
    handleProps: {
      'aria-valuenow': width,
      'aria-valuemin': min,
      'aria-valuemax': max,
      tabIndex: 0,
      onPointerDown,
      onKeyDown,
      onDoubleClick: () => set(initial),
    },
  }
}
