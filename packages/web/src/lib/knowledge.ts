import type { Access, MemoryItem, MemoryKind, MemoryScope, PersonType } from '@mp/api'
import { Brain, CircleHelp, Gavel, Heart, Lightbulb, MessageSquareQuote, type LucideIcon } from 'lucide-react'

/** Memory kinds, for people: a label, a hint for the form, an icon and a colour. */
export const MEMORY_KIND: Record<MemoryKind, { label: string; hint: string; icon: LucideIcon; color: string }> = {
  fact: {
    label: 'Fact',
    hint: 'Something true about the company, a system or a person.',
    icon: Lightbulb,
    color: 'var(--status-waiting)',
  },
  preference: { label: 'Preference', hint: 'How someone likes things done.', icon: Heart, color: 'var(--orange)' },
  feedback: { label: 'Feedback', hint: 'What to do (or stop doing) next time.', icon: MessageSquareQuote, color: 'var(--green)' },
  decision: { label: 'Decision', hint: 'Something that was decided, and why.', icon: Gavel, color: 'var(--status-completed)' },
  other: { label: 'Other', hint: 'Anything else worth remembering.', icon: CircleHelp, color: 'var(--fg-tertiary)' },
}

export const MEMORY_ICON = Brain

/** Who may recall a memory, in words. */
export function scopeWords(scope: MemoryScope | undefined, name: (id: string) => string | undefined): string {
  if (!scope || scope.type === 'company') return 'In any work'
  const who = (scope.id && name(scope.id)) || scope.id || 'someone'
  return scope.type === 'project' ? `Only in work on ${who}` : `Only in work with ${who}`
}

/** A memory's "about" people, for the privacy line. */
export const peopleIn = (m: Pick<MemoryItem, 'about'>) =>
  m.about.filter((a) => a.kind === 'contact' && (a.contactKind ?? 'person') === 'person')

/** Access levels, for people. */
export const ACCESS_INFO: Record<Access, { label: string; hint: string }> = {
  viewer: { label: 'Viewer', hint: 'Reads everything they may see; changes nothing.' },
  member: { label: 'Member', hint: 'Chats, starts and steers their own work, edits knowledge.' },
  admin: { label: 'Admin', hint: 'Everything: people, employees, secrets, limits and triggers.' },
}
export const ACCESS_ORDER: Access[] = ['viewer', 'member', 'admin']

export const PERSON_TYPES: { value: PersonType; label: string; plural: string }[] = [
  { value: 'person', label: 'Person', plural: 'People' },
  { value: 'ai', label: 'AI employee', plural: 'AI employees' },
  { value: 'agent', label: 'Agent', plural: 'Agents' },
]

/** Systems people have handles in, for the handle rows. */
export const HANDLE_SYSTEMS: { value: string; label: string; placeholder: string }[] = [
  { value: 'slack', label: 'Slack', placeholder: 'U0123ABCD' },
  { value: 'gitlab', label: 'GitLab', placeholder: 'ana.novak' },
  { value: 'linear', label: 'Linear', placeholder: 'ana' },
]

export const systemLabel = (system: string) =>
  HANDLE_SYSTEMS.find((s) => s.value === system)?.label ?? system.charAt(0).toUpperCase() + system.slice(1)

/** Downloads text as a file (SKILL.md export). */
export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Field names as people read them, for version histories. */
const FIELD_LABELS: Record<string, string> = {
  body: 'instructions',
  whenToUse: 'when to use it',
  description: 'what it helps with',
  scope: 'where it applies',
  enabled: 'on or off',
  files: 'files',
  summary: 'summary',
  content: 'details',
  employeeId: 'who remembers it',
  verified: 'confirmed',
  kind: 'kind',
  name: 'name',
}

/** `['body', 'whenToUse']` → `instructions, when to use it`. */
export const fieldList = (fields: string[]) => fields.map((f) => FIELD_LABELS[f] ?? f).join(', ')
