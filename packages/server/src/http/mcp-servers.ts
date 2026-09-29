import type * as Api from '@mp/api'
import { DeniedError, errorMessage, UnavailableError } from '@mp/core'
import { Hono } from 'hono'
import { authenticate, principalOf } from '../auth/guard.ts'
import { OAUTH_CALLBACK_PATH } from '../mcp-servers/oauth.ts'
import type { McpServers } from '../mcp-servers/manager.ts'
import type { Services } from '../services.ts'
import { jsonBody } from './util.ts'

/**
 * The MCP servers API (admins only, see GUARD_RULES) and the OAuth callback:
 *
 * - `GET /api/mcp-servers?employeeId=` (`global` for the global ones), `POST`, `PATCH /:id`, `DELETE /:id`
 * - `POST /:id/reconnect`, `GET /:id/tools`
 * - `POST /:id/oauth/start` → `{ authorizationUrl }`, `POST /:id/oauth/disconnect`
 * - `GET /oauth/mcp/callback`: a plain GET on the harness origin (never a preview origin: those are
 *   refused before any route). It checks the sign-in itself: the state is single-use, 10 minutes, and
 *   bound to the server and to the person who pressed Connect.
 */
export function mcpServerRoutes(s: Services): Hono {
  const app = new Hono()
  const servers = (): McpServers => {
    if (!s.mcpServers) throw new UnavailableError('MCP servers can not be added at runtime with this MCP hub')
    return s.mcpServers
  }

  app.get('/api/mcp-servers', async (c) => {
    const q = c.req.query('employeeId')
    const scope = q === undefined ? undefined : q === '' || q === 'global' ? null : q
    return c.json((await servers().list(scope)) satisfies Api.McpServerInfo[])
  })

  app.post('/api/mcp-servers', async (c) => {
    const info = await servers().create(await jsonBody(c), principalOf(c).contactId)
    return c.json(info satisfies Api.McpServerInfo, 201)
  })

  app.patch('/api/mcp-servers/:id', async (c) =>
    c.json((await servers().update(c.req.param('id'), await jsonBody(c), principalOf(c).contactId)) satisfies Api.McpServerInfo),
  )

  app.delete('/api/mcp-servers/:id', async (c) => {
    await servers().remove(c.req.param('id'))
    return c.body(null, 204)
  })

  app.post('/api/mcp-servers/:id/reconnect', async (c) =>
    c.json((await servers().reconnect(c.req.param('id'))) satisfies Api.McpServerInfo),
  )

  app.get('/api/mcp-servers/:id/tools', async (c) =>
    c.json((await servers().tools(c.req.param('id'))) satisfies Api.McpServerTool[]),
  )

  app.post('/api/mcp-servers/:id/oauth/start', async (c) => {
    const body = await jsonBody<{ returnTo?: unknown }>(c)
    const start = await servers().oauthStart(
      c.req.param('id'),
      { contactId: principalOf(c).contactId },
      { returnTo: body.returnTo, requestOrigin: new URL(c.req.url).origin },
    )
    return c.json(start satisfies Api.McpOAuthStart)
  })

  app.post('/api/mcp-servers/:id/oauth/disconnect', async (c) =>
    c.json((await servers().oauthDisconnect(c.req.param('id'))) satisfies Api.McpServerInfo),
  )

  app.get(OAUTH_CALLBACK_PATH, async (c) => {
    const back = (location: string) => {
      // The request carried an authorization code: never cache the answer.
      c.header('cache-control', 'no-store')
      return c.redirect(location, 303)
    }
    const failed = (message: string) =>
      back(`/settings/mcp?${new URLSearchParams({ mcp_oauth: 'error', mcp_error: message.slice(0, 300) })}`)
    const principal = await authenticate(c, s).catch(() => null)
    if (!principal) return failed('sign in to the harness first, then connect again')
    if (principal.access !== 'admin') return failed('only admins can connect MCP servers')
    try {
      return back(await servers().oauthCallback(c.req.query(), { contactId: principal.contactId }))
    } catch (err) {
      if (err instanceof DeniedError || err instanceof UnavailableError) return failed(err.message)
      s.logger.error('MCP OAuth callback failed', { err: errorMessage(err) })
      return failed('the sign-in could not be completed')
    }
  })

  return app
}
