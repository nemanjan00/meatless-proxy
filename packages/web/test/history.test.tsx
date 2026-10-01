import type { ApiEntry, Json } from '@mp/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TimelineEntry } from '../src/components/history.tsx'

const entry = (meta: Record<string, Json>): ApiEntry => ({
  id: 'ent_s',
  parent: 'ent_p',
  kind: 'summary',
  content: { text: 'read three files: PAY-7 needs a refund', rewoundTo: 'ent_p', replacesTip: 'ent_t' },
  hash: 'h',
  meta,
  createdAt: new Date(0).toISOString(),
})

describe('summaries in the history', () => {
  it('shows a collapsed stretch with how much it replaced, and the summary', () => {
    render(
      <TimelineEntry item={{ entry: entry({ op: 'rewind', collapsedEntries: 5, collapsedToolCalls: 3, keptEntries: 2 }) }} />,
    )
    expect(screen.getByTestId('collapsed-stretch').textContent).toBe(
      'Collapsed 5 entries (3 tool calls): the detailed branch is kept',
    )
    expect(screen.getByText('read three files: PAY-7 needs a refund')).toBeTruthy()
  })

  it('shows a jump back as a rewind', () => {
    render(<TimelineEntry item={{ entry: entry({ op: 'rewind' }) }} />)
    expect(screen.queryByTestId('collapsed-stretch')).toBeNull()
    expect(screen.getByTestId('summary-entry').textContent).toContain('Rewound: the detailed branch is kept')
  })
})
