import type { DesktopToken, Environment } from '@mp/api'
import { ExternalLink, Hand, Monitor, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ErrorState, LoadingRows } from '@/components/empty.tsx'
import { PREVIEW_SANDBOX } from '@/components/preview-panel.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { useApi } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'
import { cn } from '@/lib/utils.ts'

type DesktopEnv = Pick<Environment, 'envId' | 'name' | 'canControl' | 'status'>

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))

/**
 * An environment's desktop (Xvfb and VNC), in a sandboxed frame on the preview origin: the VNC
 * connection and its single-use token never touch the harness's own origin (docs/spec.md "Live
 * previews"). View-only by default; admins and the session's requester can take control, which mints
 * a control token (the server gives view-only viewers a view-only VNC server, so it is enforced there).
 */
export function DesktopViewer({ env, className }: { env: DesktopEnv; className?: string }) {
  const api = useApi()
  const { can } = useAuth()
  const member = can('member')
  const [control, setControl] = useState(false)
  const [token, setToken] = useState<DesktopToken | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const running = env.status === 'running'

  /** A fresh single-use token for every load: reload, and switching between view and control. */
  const load = useCallback(async () => {
    if (!member || !running) return
    const n = ++seq.current
    setLoading(true)
    try {
      const t = await api.desktopToken(env.envId, { control })
      if (n !== seq.current) return
      setToken(t)
      setError(null)
    } catch (e) {
      if (n !== seq.current) return
      setError(asError(e))
      // Control refused: back to watching.
      if (control) setControl(false)
    } finally {
      if (n === seq.current) setLoading(false)
    }
  }, [api, env.envId, control, member, running])

  useEffect(() => {
    load()
  }, [load])

  const openTab = async () => {
    try {
      const t = await api.desktopToken(env.envId, { control })
      window.open(t.url, '_blank', 'noopener,noreferrer')
    } catch (e) {
      setError(asError(e))
    }
  }

  if (!running) return <p className="py-6 text-center text-fg-tertiary">The environment is stopped, so its desktop is off.</p>

  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="desktop-viewer">
      <div className="flex min-h-8 flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-micro text-fg-tertiary">
          <Monitor className="size-3.5" />
          <span className="font-mono">:99</span>
        </span>
        {member && (
          <Badge
            variant="outline"
            className={cn('text-tiny', control ? 'border-[var(--status-running)] text-foreground' : 'text-fg-secondary')}
            data-testid="desktop-mode"
          >
            {control ? 'Controlling' : 'View only'}
          </Badge>
        )}
        <span className="flex-1" />
        {member && env.canControl && (
          <Button
            variant={control ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={control}
            onClick={() => setControl((c) => !c)}
            disabled={loading}
          >
            <Hand /> {control ? 'Release control' : 'Take control'}
          </Button>
        )}
        {member && (
          <>
            <Button variant="ghost" size="sm" onClick={() => load()} disabled={loading} aria-label="Reload desktop">
              <RotateCw className={cn(loading && 'animate-spin')} /> Reload
            </Button>
            <Button variant="ghost" size="sm" onClick={openTab} aria-label="Open desktop in a new tab">
              <ExternalLink /> New tab
            </Button>
          </>
        )}
      </div>
      {!member ? (
        <p className="py-6 text-center text-micro text-fg-quaternary">
          Desktops show the employee's running programs: members can open them.
        </p>
      ) : error && !token ? (
        <ErrorState error={error} retry={load} />
      ) : token ? (
        <>
          {error && <p className="text-micro text-[var(--red)]">{error.message}</p>}
          <iframe
            // A new token means a new load.
            key={token.token}
            src={token.url}
            title={`Desktop of ${env.name}`}
            sandbox={PREVIEW_SANDBOX}
            referrerPolicy="no-referrer"
            className="aspect-[16/10] w-full rounded-lg border bg-[#1c1c1f]"
            data-testid="desktop-frame"
          />
        </>
      ) : (
        <LoadingRows rows={3} />
      )}
    </div>
  )
}

/**
 * A small live view-only picture of a desktop, for lists. The token is minted when the thumbnail
 * scrolls into view. The frame takes no input: clicking opens the full viewer.
 */
export function DesktopThumbnail({
  env,
  onOpen,
  className,
}: {
  env: Pick<Environment, 'envId' | 'name'>
  onOpen(): void
  className?: string
}) {
  const api = useApi()
  const { can } = useAuth()
  const member = can('member')
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true)
        io.disconnect()
      }
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || !member) return
    let live = true
    api.desktopToken(env.envId, { thumbnail: true }).then(
      (t) => live && setUrl(t.url),
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [api, env.envId, visible, member])

  return (
    <div
      ref={ref}
      className={cn(
        'group relative aspect-[16/10] overflow-hidden rounded-md border bg-[#1c1c1f] transition-quick hover:border-[var(--ring)]',
        className,
      )}
      data-testid="desktop-thumbnail"
    >
      {url ? (
        <iframe
          src={url}
          title={`Desktop of ${env.name} (thumbnail)`}
          sandbox={PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          tabIndex={-1}
          className="pointer-events-none absolute inset-0 size-full border-0"
        />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-fg-quaternary">
          <Monitor className="size-4" />
          {failed && <span className="sr-only">Desktop unavailable</span>}
        </span>
      )}
      {/* Over the frame, which takes no input: a click opens the full viewer. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open the desktop of ${env.name}`}
        className="absolute inset-0 rounded-md"
      />
    </div>
  )
}
