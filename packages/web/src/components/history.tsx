import type { ApiEntry, AssistantContent, EventEntryContent, PointerContent, SummaryContent, ToolResultContent } from '@mp/api'
import {
  Bookmark,
  ChevronRight,
  CornerDownRight,
  FileSymlink,
  MessageSquare,
  Radio,
  ShieldAlert,
  Terminal,
  Undo2,
  Wrench,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Markdown } from '@/components/markdown.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.tsx'
import { clockOrDate, formatTokens } from '@/lib/format.ts'
import { cn } from '@/lib/utils.ts'

/**
 * A session's history as a timeline: messages, tool calls collapsed to one
 * line (expand for arguments and output), summaries and pointers marked.
 */
export interface TimelineItem {
  entry: ApiEntry
  /** For assistant entries: results of its tool calls, by call id. */
  results?: Map<string, ApiEntry>
}

/** Pairs tool results with the assistant entry that made the calls, so each call renders once with its output. */
export function pairToolResults(entries: ApiEntry[]): TimelineItem[] {
  const items: TimelineItem[] = []
  // A result belongs to the nearest earlier assistant entry that made a call with its id.
  const pending = new Map<string, TimelineItem>()
  for (const e of entries) {
    if (e.kind === 'assistant') {
      const item: TimelineItem = { entry: e, results: new Map() }
      for (const c of (e.content as unknown as AssistantContent).toolCalls ?? []) pending.set(c.id, item)
      items.push(item)
    } else if (e.kind === 'tool_result' || (e.kind === 'pointer' && (e.content as unknown as PointerContent).toolCallId)) {
      // A pointer standing for an offloaded result pairs with its call like the result would.
      const callId =
        e.kind === 'tool_result'
          ? (e.content as unknown as ToolResultContent).toolCallId
          : (e.content as unknown as PointerContent).toolCallId!
      const owner = pending.get(callId)
      if (owner) {
        owner.results!.set(callId, e)
        pending.delete(callId)
      } else items.push({ entry: e })
    } else items.push({ entry: e })
  }
  return items
}

function Row({
  icon,
  label,
  time,
  children,
  className,
}: {
  icon: ReactNode
  label: ReactNode
  time: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('group relative flex gap-3 py-2', className)}>
      <div className="relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border bg-background text-fg-tertiary [&_svg]:size-3">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-micro text-fg-tertiary">
          <span className="min-w-0 truncate">{label}</span>
          <span className="ml-auto shrink-0 text-fg-quaternary opacity-0 transition-quick group-hover:opacity-100">{time}</span>
        </div>
        {children}
      </div>
    </div>
  )
}

function Output({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return (
    <pre className="max-h-72 overflow-auto rounded-md border bg-level-2 p-2 font-mono text-micro whitespace-pre-wrap text-fg-secondary">
      {text}
    </pre>
  )
}

function ToolCall({ call, result }: { call: { id: string; name: string; arguments: string }; result?: ApiEntry }) {
  const [open, setOpen] = useState(false)
  const offloaded = result?.kind === 'pointer' ? (result.content as unknown as PointerContent) : undefined
  const r = offloaded ? undefined : (result?.content as unknown as ToolResultContent | undefined)
  let args: unknown = call.arguments
  try {
    args = JSON.parse(call.arguments)
  } catch {
    // keep the raw string
  }
  const argText =
    typeof args === 'object' && args
      ? Object.entries(args as Record<string, unknown>)
          .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(', ')
      : String(args)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md py-0.5 text-left font-mono text-micro text-fg-secondary hover:text-foreground"
        data-testid="tool-call"
      >
        <ChevronRight className={cn('size-3 shrink-0 text-fg-quaternary transition-quick', open && 'rotate-90')} />
        <Wrench className="size-3 shrink-0 text-fg-tertiary" />
        <span className="shrink-0">{call.name}</span>
        <span className="min-w-0 truncate text-fg-quaternary">({argText})</span>
        {offloaded ? (
          <span className="ml-auto shrink-0 font-sans text-fg-quaternary" data-testid="offloaded-result">
            offloaded
          </span>
        ) : r ? (
          <span className={cn('ml-auto shrink-0 font-sans', r.isError ? 'text-[var(--red)]' : 'text-fg-quaternary')}>
            {r.isError ? 'error' : 'ok'}
          </span>
        ) : (
          <span className="ml-auto shrink-0 font-sans text-[var(--yellow)]">running</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 mb-2 flex flex-col gap-1.5 pl-4">
        <div className="text-micro text-fg-quaternary">Arguments</div>
        <Output value={args} />
        {r && (
          <>
            <div className="text-micro text-fg-quaternary">Output</div>
            <Output value={r.output} />
          </>
        )}
        {offloaded && (
          <>
            <div className="text-micro text-fg-quaternary">
              {result?.meta.automatic
                ? 'Too big to keep in the context: the model sees this preview'
                : 'Offloaded: the model sees'}
            </div>
            <Output value={offloaded.text} />
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-micro text-fg-quaternary hover:text-fg-tertiary">
        <ChevronRight className={cn('size-3 transition-quick', open && 'rotate-90')} />
        Reasoning
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-1 border-l-2 pl-3 text-mini text-fg-tertiary italic">{text}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function TimelineEntry({ item, onShowBranch }: { item: TimelineItem; onShowBranch?: (entryId: string) => void }) {
  const e = item.entry
  const time = clockOrDate(e.createdAt)
  const usage = e.meta.usage as { input: number; output: number; cached: number } | undefined
  switch (e.kind) {
    case 'system':
      return (
        <Row icon={<Terminal />} label="System" time={time}>
          <p className="line-clamp-2 text-mini text-fg-tertiary">{(e.content as { text: string }).text}</p>
        </Row>
      )
    case 'user':
      return (
        <Row icon={<MessageSquare />} label="Input" time={time}>
          <div className="mt-1 rounded-lg border bg-level-1 px-3 py-2 text-small text-foreground">
            {(e.content as { text: string }).text}
          </div>
        </Row>
      )
    case 'event': {
      const c = e.content as unknown as EventEntryContent
      return (
        <Row
          icon={<Radio />}
          label={
            <span className="flex items-center gap-1.5">
              <span className="font-mono">{c.source}</span> · {c.type}
              {!c.trusted && (
                <span className="inline-flex items-center gap-0.5 rounded-sm bg-[var(--orange)]/10 px-1 text-tiny text-[var(--orange)]">
                  <ShieldAlert className="size-3" /> untrusted
                </span>
              )}
              {!c.expectedToAct && <span className="rounded-sm border px-1 text-tiny">context only</span>}
            </span>
          }
          time={time}
        >
          <p className="mt-0.5 text-mini text-fg-secondary">{c.text}</p>
        </Row>
      )
    }
    case 'assistant': {
      const c = e.content as unknown as AssistantContent
      return (
        <Row
          icon={<CornerDownRight />}
          label={
            <span>
              Assistant
              {usage && (
                <span className="ml-2 text-fg-quaternary tabular-nums">
                  {formatTokens(usage.input)} in · {formatTokens(usage.output)} out ·{' '}
                  {Math.round((usage.cached / Math.max(1, usage.input)) * 100)}% cached
                </span>
              )}
            </span>
          }
          time={time}
        >
          <div className="mt-0.5 flex flex-col gap-1">
            {c.reasoning && <Reasoning text={c.reasoning} />}
            {c.text && <Markdown text={c.text} className="text-small" tags />}
            {(c.toolCalls ?? []).map((call) => (
              <ToolCall key={call.id} call={call} result={item.results?.get(call.id)} />
            ))}
          </div>
        </Row>
      )
    }
    case 'tool_result': {
      const c = e.content as unknown as ToolResultContent
      return (
        <Row icon={<Wrench />} label={<span className="font-mono">{c.name}</span>} time={time}>
          <Output value={c.output} />
        </Row>
      )
    }
    case 'summary': {
      const c = e.content as unknown as SummaryContent
      return (
        <Row icon={<Undo2 />} label="Summary" time={time}>
          <div className="mt-1 rounded-lg border border-[var(--indigo)]/30 bg-accent-tint px-3 py-2" data-testid="summary-entry">
            <div className="mb-1 flex items-center gap-2 text-micro text-[#828fff]">
              {e.meta.automatic === true ? (
                <span data-testid="auto-compaction">
                  Compacted automatically near the context limit: the full history is kept
                </span>
              ) : e.meta.op === 'compact' ? (
                'Compacted: the full history is kept'
              ) : typeof e.meta.collapsedEntries === 'number' ? (
                <span data-testid="collapsed-stretch">
                  Collapsed {e.meta.collapsedEntries} {e.meta.collapsedEntries === 1 ? 'entry' : 'entries'}
                  {typeof e.meta.collapsedToolCalls === 'number' && e.meta.collapsedToolCalls > 0
                    ? ` (${e.meta.collapsedToolCalls} tool ${e.meta.collapsedToolCalls === 1 ? 'call' : 'calls'})`
                    : ''}
                  : the detailed branch is kept
                </span>
              ) : (
                'Rewound: the detailed branch is kept'
              )}
              {onShowBranch && c.replacesTip && (
                <button type="button" className="ml-auto hover:underline" onClick={() => onShowBranch(c.replacesTip)}>
                  Show branch
                </button>
              )}
            </div>
            <p className="text-mini text-fg-secondary">{c.text}</p>
          </div>
        </Row>
      )
    }
    case 'pointer': {
      const c = e.content as unknown as PointerContent
      return (
        <Row icon={<FileSymlink />} label="Pointer" time={time}>
          <div className="mt-1 rounded-lg border border-dashed px-3 py-2" data-testid="pointer-entry">
            <div className="mb-1 flex items-center gap-2 text-micro text-fg-tertiary">
              <Bookmark className="size-3" />
              Offloaded{c.doc?.chapter ? ` to “${c.doc.chapter}”` : ''}
              {onShowBranch && (
                <button type="button" className="ml-auto text-[#828fff] hover:underline" onClick={() => onShowBranch(c.original)}>
                  Show original
                </button>
              )}
            </div>
            <p className="text-mini text-fg-secondary">{c.text}</p>
          </div>
        </Row>
      )
    }
    default:
      return (
        <Row icon={<Terminal />} label={e.kind} time={time}>
          <Output value={e.content} />
        </Row>
      )
  }
}

/** The full timeline. `runStart` marks where uncommitted run entries begin. */
export function Timeline({
  entries,
  runStart,
  runLabel,
  streaming,
  onShowBranch,
}: {
  entries: ApiEntry[]
  runStart?: string | null
  runLabel?: ReactNode
  streaming?: { content: string; reasoning: string } | null
  onShowBranch?: (entryId: string) => void
}) {
  const items = pairToolResults(entries)
  const startIdx = runStart ? items.findIndex((i) => i.entry.parent === runStart) : -1
  return (
    <div className="relative" data-testid="timeline">
      <div className="absolute top-2 bottom-2 left-[9.5px] w-px bg-border" />
      {items.map((it, i) => (
        <div key={it.entry.id}>
          {i === startIdx && (
            <div className="relative z-10 my-2 flex items-center gap-2 pl-7 text-micro text-[var(--yellow)]">
              <span className="h-px flex-1 bg-[var(--yellow)]/30" />
              {runLabel}
              <span className="h-px flex-1 bg-[var(--yellow)]/30" />
            </div>
          )}
          <TimelineEntry item={it} onShowBranch={onShowBranch} />
        </div>
      ))}
      {streaming && (streaming.content || streaming.reasoning) && (
        <Row icon={<CornerDownRight />} label="Assistant · streaming" time="">
          {streaming.reasoning && <p className="mt-1 text-mini text-fg-quaternary italic">{streaming.reasoning}</p>}
          <p className="stream-caret mt-1 text-small whitespace-pre-wrap text-fg-secondary">{streaming.content}</p>
        </Row>
      )}
    </div>
  )
}
