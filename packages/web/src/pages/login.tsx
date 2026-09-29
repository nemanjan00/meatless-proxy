import { KeyRound, Mail } from 'lucide-react'
import { Navigate, useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button.tsx'
import { useLoad } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'

/** What went wrong, from `/login?error=` (set by the server's sign-in routes). */
export const LOGIN_ERRORS: Record<string, string> = {
  invalid_link: 'That sign-in link has expired or was already used. Ask for a new one.',
  too_many_attempts: 'Too many sign-in attempts. Wait a minute, then try again.',
  unknown_user: 'Nobody in the directory has that email address. Ask an admin to add you.',
  oidc_failed: "Signing in with your identity provider didn't work. Try again.",
  oidc_unavailable: "The identity provider can't be reached right now. Try again in a moment.",
  oidc_off: 'Single sign-on is not set up here. Use a sign-in link.',
}

/** A local path to return to after signing in. */
function safeNext(next: string | null): string {
  if (!next?.startsWith('/') || next.startsWith('//') || next.startsWith('/login')) return '/'
  return next
}

/**
 * The login page. People sign in with a one-time link (from an admin, by email,
 * or `npm run login-link`), or with the identity provider when OIDC is set up.
 */
export function LoginPage() {
  const [params] = useSearchParams()
  const { me, loading } = useAuth()
  const config = useLoad((api) => api.authConfig(), [])
  const next = safeNext(params.get('next'))
  const error = params.get('error')
  if (!loading && me) return <Navigate to={next} replace />
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4">
      <div className="w-full max-w-[380px] rounded-xl border bg-card p-6 shadow-[0_4px_24px_#00000033]">
        <div className="mb-6 flex items-center gap-2 text-fg-secondary">
          <span className="flex size-6 items-center justify-center rounded-md bg-brand text-tiny font-semibold text-white">
            mp
          </span>
          <span className="font-medium">meatless-proxy</span>
        </div>
        <h1 className="text-title2 font-semibold text-foreground">Sign in</h1>
        {error && (
          <p role="alert" className="mt-3 rounded-md border border-[var(--red)]/40 bg-[var(--red)]/10 px-3 py-2 text-mini">
            {LOGIN_ERRORS[error] ?? 'Signing in did not work. Try again.'}
          </p>
        )}
        <div className="mt-4 flex gap-3 text-fg-tertiary">
          <Mail className="mt-0.5 size-4 shrink-0" />
          <p className="text-small">
            Check your email for a sign-in link, or ask an admin for one. A link works once, for 15 minutes.
          </p>
        </div>
        {config.data?.oidc && (
          <>
            <div className="my-5 flex items-center gap-3 text-micro text-fg-quaternary">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
            <Button asChild className="w-full">
              <a href={`/auth/oidc/start?next=${encodeURIComponent(next)}`}>
                <KeyRound />
                Continue with single sign-on
              </a>
            </Button>
          </>
        )}
        <div className="mt-6 text-micro text-fg-quaternary">
          Admins can make a link in Settings, or on the server with
          <code className="mt-1 block whitespace-nowrap font-mono">npm run login-link -- --contact &lt;email&gt;</code>
        </div>
      </div>
    </main>
  )
}
