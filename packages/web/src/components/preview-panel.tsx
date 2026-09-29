import type { PreviewToken, SessionPreview } from '@mp/api'
import { ExternalLink, GitCommitHorizontal, RotateCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { EmptyState, ErrorState, LoadingRows } from '@/components/empty.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useApi, useLive } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'
import { cn } from '@/lib/utils.ts'

/**
 * The sandbox of every preview frame. `allow-same-origin` is safe because previews are served from
 * their own origin (docs/spec.md "Live previews"): it only lets the preview use its own storage.
 */
export const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-same-origin'

export interface PreviewPanelProps {
  /** The session's preview, from `GET /api/sessions/:id/preview`. */
  preview: SessionPreview
  /** The port to show first (e.g. from `?port=`). Default: the first exposed port. */
  initialPort?: number
  /** Called when the viewer picks another port. */
  onPortChange?(port: number): void
  /** Re-fetches the session's preview (a new commit, a changed environment). */
  onRefresh?(): void
}

/**
 * A session's live preview: a port picker, the frame (loaded with a fresh single-use token each
 * time), the running commit, reload, and full screen in a new tab. Reloads by itself when the
 * environment's checkout moves to another commit (`preview.commit` on the session's channel).
 */
export function PreviewPanel({ preview, initialPort, onPortChange, onRefresh }: PreviewPanelProps) {
  const api = useApi()
  const { can } = useAuth()
  const ports = preview.ports
  const [port, setPort] = useState<number>(initialPort && ports.includes(initialPort) ? initialPort : (ports[0] ?? 0))
  const [token, setToken] = useState<PreviewToken | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const member = can('member')
  const envId = preview.envId
  const running = preview.status === 'running'

  // A port that went away (the environment was recreated) falls back to the first one.
  useEffect(() => {
    if (ports.length && !ports.includes(port)) setPort(ports[0]!)
  }, [ports, port])

  /** Mints a fresh token and points the frame at it: every load and reload uses its own token. */
  const load = useCallback(async () => {
    if (!envId || !port || !member || !running) return
    const n = ++seq.current
    setLoading(true)
    try {
      const t = await api.previewToken(envId, port)
      if (n !== seq.current) return
      setToken(t)
      setError(null)
    } catch (e) {
      if (n !== seq.current) return
      setError(e instanceof Error ? e : new Error(String(e)))
    } finally {
      if (n === seq.current) setLoading(false)
    }
  }, [api, envId, port, member, running])

  useEffect(() => {
    load()
  }, [load])

  // The employee committed: show the new commit and reload the frame.
  useLive(
    [`session:${preview.sessionId}`],
    (e) => {
      if (e.topic !== 'preview.commit' || e.payload.sessionId !== preview.sessionId) return
      onRefresh?.()
      load()
    },
    ['preview.commit'],
  )

  const pick = (p: number) => {
    setPort(p)
    onPortChange?.(p)
  }

  const openFull = async () => {
    if (!envId) return
    try {
      const t = await api.previewToken(envId, port)
      window.open(t.url, '_blank', 'noopener,noreferrer')
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)))
    }
  }

  if (!envId || preview.status === 'none') return <EmptyState text="This session has no environment." />
  if (preview.status === 'missing') return <EmptyState text="The environment is gone, so there is nothing to preview." />
  if (preview.status === 'stopped') return <EmptyState text="The environment is stopped. The preview comes back when it runs." />
  if (!ports.length) return <EmptyState text="The environment doesn't expose any ports." />

  const commit = preview.commit
  return (
    <div className="flex flex-col gap-2" data-testid="preview-panel">
      <div className="flex min-h-8 flex-wrap items-center gap-2">
        {ports.length > 1 && (
          <fieldset className="flex items-center gap-0.5 rounded-md border p-0.5" aria-label="Port">
            {ports.map((p) => (
              <Button
                key={p}
                size="sm"
                variant={p === port ? 'secondary' : 'ghost'}
                className={cn('h-6 px-2 font-mono text-micro', p !== port && 'text-fg-tertiary')}
                aria-pressed={p === port}
                onClick={() => pick(p)}
              >
                :{p}
              </Button>
            ))}
          </fieldset>
        )}
        {ports.length === 1 && <span className="font-mono text-micro text-fg-tertiary">:{port}</span>}
        {commit && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="gap-1 font-mono text-tiny text-fg-secondary" data-testid="preview-commit">
                <GitCommitHorizontal className="size-3" />
                {commit.sha.slice(0, 7)}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              {commit.subject ?? 'Running commit'}
              {commit.repo ? ` · ${commit.repo}` : ''}
            </TooltipContent>
          </Tooltip>
        )}
        <span className="flex-1" />
        {member && (
          <>
            <Button variant="ghost" size="sm" onClick={() => load()} disabled={loading} aria-label="Reload preview">
              <RotateCw className={cn(loading && 'animate-spin')} /> Reload
            </Button>
            <Button variant="ghost" size="sm" onClick={openFull} aria-label="Open full screen">
              <ExternalLink /> Full screen
            </Button>
          </>
        )}
      </div>
      {!member ? (
        <p className="py-6 text-center text-micro text-fg-quaternary">Previews run the employee's code: members can open them.</p>
      ) : error && !token ? (
        <ErrorState error={error} retry={load} />
      ) : token ? (
        <iframe
          // A new token means a new load, even for the same port.
          key={token.token}
          src={token.url}
          title={`Preview of port ${port}`}
          sandbox={PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          className="h-[560px] w-full rounded-lg border bg-white"
          data-testid="preview-frame"
        />
      ) : (
        <LoadingRows rows={3} />
      )}
    </div>
  )
}
