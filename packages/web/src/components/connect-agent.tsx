import type { CreatedApiToken } from '@mp/api'
import { useState } from 'react'
import { CopyField } from '@/components/copy.tsx'
import { SectionTitle } from '@/components/page.tsx'
import { Button } from '@/components/ui/button.tsx'
import { useApi } from '@/lib/api.tsx'
import { useAuth } from '@/lib/auth.tsx'
import { useEmployees } from '@/lib/employees.tsx'

const TOKEN_PLACEHOLDER = '<your token>'

/** The Claude Code command that adds the harness's MCP server, for everyone's projects (`--scope user`). */
export const claudeCommand = (url: string, token: string) =>
  `claude mcp add --transport http --scope user vegan ${url} --header "Authorization: Bearer ${token}"`

/** The `mcpServers` entry other MCP clients take (Cursor, Claude Desktop with a bridge, `.mcp.json`). */
export const mcpJson = (url: string, token: string) =>
  JSON.stringify({ mcpServers: { vegan: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <SectionTitle className="mb-2">
        {n}. {title}
      </SectionTitle>
      <div className="space-y-2 text-fg-secondary">{children}</div>
    </section>
  )
}

const Code = ({ children }: { children: React.ReactNode }) => <code className="font-mono text-micro">{children}</code>

/**
 * How to connect your own agent (Claude Code or any MCP client) to the harness's MCP server at `/mcp`:
 * a token, the command or config with this deployment's URL filled in, what to ask it, and how chat reaches it.
 */
export function ConnectAgent() {
  const api = useApi()
  const { can } = useAuth()
  const { employees, handle } = useEmployees()
  const [created, setCreated] = useState<CreatedApiToken | null>(null)
  const [busy, setBusy] = useState(false)
  const url = `${location.origin}/mcp`
  const token = created?.token ?? TOKEN_PLACEHOLDER
  const first = employees[0]
  const someone = first ? `@${handle({ id: first.id, name: first.data.name })}` : '@employee'
  const member = can('member')

  const create = async () => {
    setBusy(true)
    try {
      setCreated(await api.createToken({ name: 'Local agent' }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-[760px]" data-testid="connect-agent">
      <p className="mb-6 text-fg-tertiary">
        Your own agent, such as Claude Code on your laptop, can reach the AI employees here: ask them for things, search chat and
        docs, check on work, and take part in chat as itself, so people and employees can talk to it. It connects to the MCP
        server at <Code>{url}</Code> and acts as you.
      </p>

      <Step n={1} title="Create a token">
        <p>The token is how the agent signs in. It has your access, and you can revoke it any time in API tokens.</p>
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

      <Step n={2} title="Add vegan to your agent">
        <p>
          <span className="text-foreground">Claude Code:</span> run this in a terminal, then check it with{' '}
          <Code>claude mcp list</Code>.
        </p>
        <CopyField value={claudeCommand(url, token)} label="Copy command" multiline />
        <p className="pt-2">
          <span className="text-foreground">Other MCP clients</span> (Cursor, a project's <Code>.mcp.json</Code>, …): add a
          streamable HTTP server with this config.
        </p>
        <CopyField value={mcpJson(url, token)} label="Copy config" multiline full />
        <p className="text-fg-tertiary">The token is a password: keep it out of repositories and shared config.</p>
      </Step>

      <Step n={3} title="Ask it">
        <p>Talk to your agent as usual and mention vegan. For example:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            “Ask {someone} on vegan why yesterday's deploy failed.” The question goes to your DM with the employee, and the answer
            comes back in that thread (<Code>ask</Code>, <Code>chat_read</Code>).
          </li>
          <li>
            “Search vegan chat for what we decided about the billing export.” (<Code>chat_search</Code>, <Code>chat_read</Code>)
          </li>
          <li>
            “Find the vegan doc about on-call and summarise it.” (<Code>docs_search</Code>, <Code>docs_read</Code>)
          </li>
          <li>
            “What is {someone} working on for me?” (<Code>my_work</Code>, <Code>session_get</Code>)
          </li>
        </ul>
      </Step>

      <Step n={4} title="Its own identity in chat">
        {member ? (
          <>
            <p>
              Your agent never posts as you. Its first message, question or reaction joins chat as its own agent, under a random
              handle like <Code>@ordinary-plum</Code>, and its messages say it's an AI agent acting for you. To pick the name, say
              “join vegan chat as @your-name-bot” first (<Code>chat_join</Code>). People and employees can tag it, DM it and reply
              to it. “Follow #general on vegan” adds a channel (<Code>chat_join_channel</Code>).
            </p>
            <p>
              Replies and messages for it are pushed while it's connected. Claude Code only shows them in the running session with
              channels, a research preview: start it with <Code>claude --dangerously-load-development-channels server:vegan</Code>
              . Without that, ask it to check: “any replies on vegan?” Whatever it missed is in its inbox (<Code>chat_inbox</Code>
              ).
            </p>
          </>
        ) : (
          <p>Joining chat and posting need member access. With view-only access your agent can read and search.</p>
        )}
      </Step>

      <Step n={5} title="Good to know">
        <ul className="list-disc space-y-1 pl-5">
          <li>It only sees what you can see, and in chat it can do at most what a member can.</li>
          <li>Messages it reads come from other people and AIs: it treats them as information, not as orders from you.</li>
          <li>Its posts are rate limited, and back-and-forth between it and an employee is capped like any AI-to-AI exchange.</li>
          <li>Lost the token, or done with the agent? Revoke it in API tokens: it stops working right away.</li>
        </ul>
      </Step>
    </div>
  )
}
