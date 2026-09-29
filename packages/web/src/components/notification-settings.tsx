import type { ChannelSummary, NotificationPrefs } from '@mp/api'
import { BellOff, Hash, MessageCircle, Plus, Volume2, X } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { toast } from 'sonner'
import { SectionTitle } from '@/components/page.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { Switch } from '@/components/ui/switch.tsx'
import { useLoad } from '@/lib/api.tsx'
import { useNotifications } from '@/lib/notifications.tsx'
import { type DesktopPermission, desktopPermission, playChime, requestDesktopPermission } from '@/lib/notify.ts'

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className="flex items-start gap-4 py-2.5">
      <label htmlFor={id} className="min-w-0 flex-1">
        <span className="block text-fg-secondary">{label}</span>
        {hint && <span className="block text-micro text-fg-quaternary">{hint}</span>}
      </label>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">{children(id)}</div>
    </div>
  )
}

const channelLabel = (c: ChannelSummary['channel']) => (c.data.dm ? c.data.name : `#${c.data.name}`)

/** Picks a channel to mute: a popover with a searchable list of the channels you can see. */
function ChannelPicker({ exclude, onPick }: { exclude: string[]; onPick(id: string): void }) {
  const [open, setOpen] = useState(false)
  const channels = useLoad((a) => a.channels(), [])
  const options = (channels.data ?? []).filter((c) => !exclude.includes(c.channel.id) && !c.channel.data.archived)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="xs" variant="secondary">
          <Plus />
          Mute a channel
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Find a channel…" />
          <CommandList>
            <CommandEmpty>{channels.data ? 'No channels to mute.' : 'Loading…'}</CommandEmpty>
            {options.map((c) => (
              <CommandItem
                key={c.channel.id}
                value={`${c.channel.data.name} ${c.channel.id}`}
                onSelect={() => {
                  onPick(c.channel.id)
                  setOpen(false)
                }}
              >
                {c.channel.data.dm ? <MessageCircle className="size-4" /> : <Hash className="size-4" />}
                {channelLabel(c.channel)}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

const PERMISSION_HINT: Record<DesktopPermission, string> = {
  granted: 'Shown only while this tab is in the background.',
  default: 'Your browser asks for permission when you turn this on. Shown only while this tab is in the background.',
  denied:
    'Your browser blocks notifications for this site. Allow them in the site settings (the icon left of the address), then turn this on again.',
  unsupported: "This browser doesn't support desktop notifications.",
}

/** Settings › Notifications: toasts, desktop notifications, sound and muted channels, saved per person. */
export function NotificationSettings() {
  const { prefs, setPrefs } = useNotifications()
  const [permission, setPermission] = useState<DesktopPermission>(() => desktopPermission())
  const channels = useLoad((a) => a.channels(), [])
  const names = new Map((channels.data ?? []).map((c) => [c.channel.id, channelLabel(c.channel)]))

  const save = (patch: Partial<NotificationPrefs>) =>
    setPrefs(patch).catch((e: unknown) => toast(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`))

  const setDesktop = async (on: boolean) => {
    if (!on) return save({ desktop: false })
    const p = await requestDesktopPermission()
    setPermission(p)
    if (p === 'granted') return save({ desktop: true })
    if (p === 'denied') toast('Desktop notifications are blocked', { description: PERMISSION_HINT.denied })
  }

  return (
    <div className="max-w-[640px]" data-testid="notification-settings">
      <p className="mb-4 text-fg-tertiary">
        How you hear about new inbox items: mentions, DMs, replies in your threads, alerts, and runs you asked for that pause or
        wait on you. These settings are yours and follow you to every device.
      </p>
      <div className="divide-y rounded-xl border px-4">
        <Row label="Toasts" hint="A toast in the corner, unless you're already looking at that channel or thread.">
          {(id) => <Switch id={id} checked={prefs.toasts} onCheckedChange={(v) => save({ toasts: v })} />}
        </Row>
        <Row
          label="Desktop notifications"
          hint={<span data-testid="desktop-hint">{prefs.desktop ? PERMISSION_HINT.granted : PERMISSION_HINT[permission]}</span>}
        >
          {(id) => (
            <Switch
              id={id}
              checked={prefs.desktop && permission === 'granted'}
              disabled={permission === 'unsupported'}
              onCheckedChange={(v) => void setDesktop(v)}
            />
          )}
        </Row>
        <Row label="Hide DM text" hint="Desktop notifications for DMs say who wrote, not what.">
          {(id) => <Switch id={id} checked={prefs.hideDmText} onCheckedChange={(v) => save({ hideDmText: v })} />}
        </Row>
        <Row label="Sound" hint="A short, quiet chime.">
          {(id) => (
            <>
              <Button size="xs" variant="ghost" className="text-fg-tertiary" onClick={playChime} aria-label="Play the sound">
                <Volume2 />
              </Button>
              <Switch id={id} checked={prefs.sound} onCheckedChange={(v) => save({ sound: v })} />
            </>
          )}
        </Row>
      </div>

      <SectionTitle
        className="mt-6 mb-2"
        actions={
          <ChannelPicker exclude={prefs.mutedChannels} onPick={(id) => save({ mutedChannels: [...prefs.mutedChannels, id] })} />
        }
      >
        Muted channels
      </SectionTitle>
      <p className="mb-2 text-micro text-fg-quaternary">
        Their items still count in the inbox, but never toast, chime or notify.
      </p>
      {prefs.mutedChannels.length === 0 ? (
        <div className="py-2 text-fg-tertiary">No muted channels.</div>
      ) : (
        <div className="flex flex-wrap gap-1.5" data-testid="muted-channels">
          {prefs.mutedChannels.map((id) => (
            <span key={id} className="inline-flex h-6 items-center gap-1 rounded-md border bg-secondary pr-0.5 pl-2 text-micro">
              <BellOff className="size-3 text-fg-tertiary" />
              {names.get(id) ?? id}
              <button
                type="button"
                aria-label={`Unmute ${names.get(id) ?? id}`}
                onClick={() => save({ mutedChannels: prefs.mutedChannels.filter((c) => c !== id) })}
                className="inline-flex size-5 items-center justify-center rounded-sm text-fg-quaternary transition-quick hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
