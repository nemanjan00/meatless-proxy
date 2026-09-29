/**
 * Keyboard shortcuts, Linear style: `G` then a letter jumps to a page.
 * Shown in menus and tooltips as <kbd> hints.
 */
export interface Shortcut {
  keys: string[]
  label: string
  to?: string
}

export const NAV_SHORTCUTS: Shortcut[] = [
  { keys: ['G', 'I'], label: 'Inbox', to: '/inbox' },
  { keys: ['G', 'N'], label: 'Now', to: '/now' },
  { keys: ['G', 'S'], label: 'Sessions', to: '/sessions' },
  { keys: ['G', 'C'], label: 'Chat', to: '/chat' },
  { keys: ['G', 'T'], label: 'Triggers', to: '/triggers' },
  { keys: ['G', 'E'], label: 'Events', to: '/events' },
  { keys: ['G', 'P'], label: 'Projects', to: '/projects' },
  { keys: ['G', 'R'], label: 'Procedures', to: '/procedures' },
  { keys: ['G', 'O'], label: 'People', to: '/contacts' },
  { keys: ['G', 'M'], label: 'Memory', to: '/memory' },
  { keys: ['G', 'K'], label: 'Skills', to: '/skills' },
  { keys: ['G', 'F'], label: 'Files', to: '/files' },
  { keys: ['G', 'U'], label: 'Usage', to: '/usage' },
  { keys: ['G', ','], label: 'Settings', to: '/settings' },
]

/** The route for a `G` sequence's second key, if any. */
export function routeForSequence(first: string, second: string): string | undefined {
  if (first.toLowerCase() !== 'g') return undefined
  return NAV_SHORTCUTS.find((s) => s.keys[1]!.toLowerCase() === second.toLowerCase())?.to
}

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}
