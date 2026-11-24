import type { CreatedApiToken } from '@mp/api'
import { useState } from 'react'
import { NavLink } from 'react-router'
import { Code, Step, claudeCommand } from '@/components/connect-agent.tsx'
import { CopyField } from '@/components/copy.tsx'
import { Button } from '@/components/ui/button.tsx'
import { useApi } from '@/lib/api.tsx'

const TOKEN_PLACEHOLDER = '<your token>'

/** The `mcpServers` entry for the admin server, for clients other than Claude Code. */
export const adminMcpJson = (url: string, token: string) =>
  JSON.stringify({ mcpServers: { 'vegan-admin': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)

/**
 * The admin MCP server at `/mcp/admin` (docs/spec.md#the-admin-mcp-server): what it is, how to connect
 * an agent to it, its two tools, and what it will and won't do. Admins only.
 */
export function AdminAgent() {
  const api = useApi()
  const [created, setCreated] = useState<CreatedApiToken | null>(null)
  const [busy, setBusy] = useState(false)
  const url = `${location.origin}/mcp/admin`
  const token = created?.token ?? TOKEN_PLACEHOLDER

  const create = async () => {
    setBusy(true)
    try {
      setCreated(await api.createToken({ name: 'Admin agent' }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-[760px]" data-testid="admin-agent">
      <p className="mb-6 text-fg-tertiary">
        Your own agent, such as Claude Code, can run vegan the way you do in Settings: set up employees and their integrations,
        triggers, secrets, MCP servers, projects, procedures, schedules, limits and people, look into sessions and runs, and pull
        the kill switch. It connects to a second MCP server at <Code>{url}</Code>, separate from the chat one in{' '}
        <NavLink to="/settings/agent" className="text-brand hover:underline">
          Connect an agent
        </NavLink>
        , and acts as you.
      </p>

      <Step n={1} title="Create a token">
        <p>
          Any of your API tokens works, and it works here only while you are an admin. A token of its own is easier to revoke when
          you're done.
        </p>
        {created ? (
          <div className="rounded-xl border border-brand/50 bg-brand/10 p-3" role="status">
            <div className="mb-2 text-mini text-foreground">
              Copy it now, it won't be shown again. The steps below include it.
            </div>
            <CopyField value={created.token} label="Copy token" />
          </div>
        ) : (
          <Button size="sm" onClick={create} disabled={busy}>
            Create a token
          </Button>
        )}
      </Step>

      <Step n={2} title="Add it to your agent">
        <p>
          <span className="text-foreground">Claude Code:</span> run this, then check it with <Code>claude mcp list</Code>. It sits
          next to the chat server (<Code>vegan</Code>), under its own name.
        </p>
        <CopyField value={claudeCommand(url, token, 'vegan-admin')} label="Copy command" multiline />
        <p className="pt-2">
          <span className="text-foreground">Other MCP clients:</span> add a streamable HTTP server with this config.
        </p>
        <CopyField value={adminMcpJson(url, token)} label="Copy config" multiline full />
        <p className="text-fg-tertiary">
          The token is a password with admin rights: keep it out of repositories and shared config.
        </p>
      </Step>

      <Step n={3} title="Ask it">
        <ul className="list-disc space-y-1 pl-5">
          <li>“On vegan-admin, list the employees and the triggers that route to each.”</li>
          <li>“Add the WIKI_TOKEN secret for the docs MCP server, scoped to that employee only.”</li>
          <li>“Why did yesterday's 09:00 scheduled task not run? Check its runs.”</li>
          <li>“Lower the daily cost limit to $20 and show me today's usage.”</li>
          <li>“Make Ana a member and send me a sign-in link for her.”</li>
        </ul>
      </Step>

      <Step n={4} title="How it works">
        <p>
          It is the same HTTP API the web UI uses, not a second one, so it can do exactly what the API can, and a new page or
          setting is there as soon as its route is. It has two tools:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <Code>api_routes</Code> lists every <Code>/api/</Code> route: its method, its path, and whether it needs a viewer, a
            member or an admin. <Code>filter</Code> narrows it, e.g. <Code>employees</Code> or <Code>POST /api/secrets</Code>.
          </li>
          <li>
            <Code>api_request</Code> calls one: <Code>method</Code>, a <Code>path</Code> with its ids filled in, an optional{' '}
            <Code>query</Code> and a JSON <Code>body</Code>. JSON answers come back parsed, text as text (cut at 200,000
            characters), and a file such as an export as an attachment, up to 8 MB.
          </li>
        </ul>
        <p>
          A wrong call answers like the API does, e.g. 400 with which field is wrong, and the agent sees it as a failed tool call
          it can fix. Each request is answered on its own: there are no notifications here, chat stays on the chat server.
        </p>
      </Step>

      <Step n={5} title="What it will and won't do">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Every change is yours: it's attributed to you in revisions and history, exactly as if you made it in the web UI.
          </li>
          <li>
            Changes are live at once, for every employee. Ask your agent to read before it changes, and to say what it'll do.
          </li>
          <li>Secret values can be set, never read: like in Settings, only their names come back.</li>
          <li>
            It only reaches <Code>/api/</Code>. Paths elsewhere (the chat server, webhooks, other sites) are refused, and request
            bodies are JSON, so uploads such as an import aren't possible from it.
          </li>
          <li>
            Admins only, checked on every request: a revoked token, or an admin who's made a member or deactivated, is refused
            from the next call. It gives a token nothing the API doesn't already give it.
          </li>
          <li>
            Revoke the token in{' '}
            <NavLink to="/settings/tokens" className="text-brand hover:underline">
              API tokens
            </NavLink>{' '}
            when you're done: it stops working right away.
          </li>
        </ul>
      </Step>
    </div>
  )
}
