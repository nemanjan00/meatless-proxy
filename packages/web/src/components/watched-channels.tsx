import type { WatchedChannel } from '@mp/api'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
import { useLoad } from '@/lib/api.tsx'

/** The rows worth saving: a channel named, and no empty note. */
export function cleanWatch(rows: WatchedChannel[]): WatchedChannel[] {
  return rows
    .map((w) => ({
      source: w.source,
      channel: w.channel.trim().replace(/^#/, ''),
      ...(w.when?.trim() ? { when: w.when.trim() } : {}),
    }))
    .filter((w) => w.channel)
}

/**
 * The channels an employee watches, by name: Slack channels typed in (a name or an id; its app must be
 * in them), harness channels picked from the list. Each has an optional note on when to get involved.
 */
export function WatchedChannels({ value, onChange }: { value: WatchedChannel[]; onChange(next: WatchedChannel[]): void }) {
  const channels = useLoad((api) => api.channels(), [])
  const set = (i: number, patch: Partial<WatchedChannel>) => onChange(value.map((w, j) => (j === i ? { ...w, ...patch } : w)))
  return (
    <div className="flex flex-col gap-2" data-testid="watched-channels">
      {value.map((w, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id of their own
        <div key={i} className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={w.source} onValueChange={(v) => set(i, { source: v as WatchedChannel['source'], channel: '' })}>
              <SelectTrigger size="sm" aria-label={`Channel ${i + 1} source`} className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="slack">Slack</SelectItem>
                <SelectItem value="chat">Harness chat</SelectItem>
              </SelectContent>
            </Select>
            {w.source === 'chat' ? (
              <Select value={w.channel || undefined} onValueChange={(v) => set(i, { channel: v })}>
                <SelectTrigger size="sm" aria-label={`Channel ${i + 1}`} className="w-48">
                  <SelectValue placeholder="Pick a channel" />
                </SelectTrigger>
                <SelectContent>
                  {(channels.data ?? [])
                    .filter((c) => !c.channel.data.dm)
                    .map((c) => (
                      <SelectItem key={c.channel.id} value={c.channel.data.name}>
                        #{c.channel.data.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                aria-label={`Channel ${i + 1}`}
                value={w.channel}
                onChange={(e) => set(i, { channel: e.target.value })}
                placeholder="#bugs or C0123ABCD"
                className="h-8 w-48 font-mono text-micro"
              />
            )}
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Stop watching channel ${i + 1}`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              className="ml-auto"
            >
              <X />
            </Button>
          </div>
          <Textarea
            aria-label={`Channel ${i + 1}: when to get involved`}
            value={w.when ?? ''}
            onChange={(e) => set(i, { when: e.target.value })}
            placeholder={
              'When to get involved, e.g.\n- bug reports from support: look into them\n- questions about deploys nobody answered'
            }
            rows={3}
          />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" onClick={() => onChange([...value, { source: 'slack', channel: '' }])}>
          <Plus />
          Watch a channel
        </Button>
        {value.some((w) => w.source === 'slack') && (
          <span className="text-micro text-fg-quaternary">
            Invite its Slack app to the channel (/invite), or it sees nothing there.
          </span>
        )}
      </div>
    </div>
  )
}
