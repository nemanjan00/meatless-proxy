/**
 * Measures the fixed overhead of an employee's model call: the employee prompt, split by section, and the
 * tool definitions it is offered (stdlib and the first-party integrations), in total and per tool.
 *
 *   npx tsx scripts/context-overhead.ts            # what a session is offered (core tools when on demand is on)
 *   npx tsx scripts/context-overhead.ts --all      # every tool, as if nothing were on demand
 *   npx tsx scripts/context-overhead.ts --json     # machine-readable
 *
 * Tokens are estimated at 3.5 characters per token (the runner's default estimate), on the JSON the
 * provider receives.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createGitlabIntegration } from '../packages/integration-gitlab/src/index.ts'
import { createLinearIntegration } from '../packages/integration-linear/src/index.ts'
import { createSlackIntegration } from '../packages/integration-slack/src/index.ts'
import { DEFAULT_TOOLSET, employeePrompt, offeredTools } from '../packages/stdlib/src/index.ts'
import { stack } from '../packages/stdlib/test/helpers.ts'
import { registerMcpTools } from '../packages/tools/src/index.ts'
import type { McpHub } from '../packages/mcp/src/index.ts'

const CHARS_PER_TOKEN = 3.5
const tok = (chars: number) => Math.round(chars / CHARS_PER_TOKEN)
const all = process.argv.includes('--all')
const json = process.argv.includes('--json')

/** A hub over in-process MCP servers: enough to list their tools. */
async function integrationHub(): Promise<McpHub> {
  const servers = {
    slack: createSlackIntegration({
      secrets: { botToken: 'xoxb-test', signingSecret: 'shh-test' },
      baseUrl: 'http://127.0.0.1:9',
    }),
    gitlab: createGitlabIntegration({
      secrets: { token: 'glpat-test', webhookSecret: 'whsec-test' },
      baseUrl: 'http://127.0.0.1:9',
    }),
    linear: createLinearIntegration({
      secrets: { apiKey: 'lin-test', webhookSecret: 'whsec-test' },
      baseUrl: 'http://127.0.0.1:9',
    }),
  }
  const clients: Record<string, Client> = {}
  for (const [name, i] of Object.entries(servers)) {
    const [c, s] = InMemoryTransport.createLinkedPair()
    await (i.createMcpServer() as { connect(t: unknown): Promise<void> }).connect(s)
    const client = new Client({ name: 'measure', version: '0' })
    await client.connect(c)
    clients[name] = client
  }
  return {
    async listTools(server?: string) {
      const out = []
      for (const [name, c] of Object.entries(clients)) {
        if (server && server !== name) continue
        for (const t of (await c.listTools()).tools)
          out.push({ server: name, name: t.name, description: t.description, inputSchema: t.inputSchema })
      }
      return out
    },
    async close() {
      for (const c of Object.values(clients)) await c.close()
    },
  } as unknown as McpHub
}

/** The prompt's sections: `## ` headings, with the rules and the tools guide split further. */
function sections(prompt: string): { name: string; chars: number }[] {
  const out: { name: string; chars: number }[] = []
  const parts = prompt.split(/\n\n(?=## )/)
  for (const part of parts) {
    const heading = /^## (.+)/.exec(part)?.[1] ?? '(identity)'
    if (heading === 'How you work') {
      // Subsections are lines of one or two words with no list marker.
      const blocks = part.split(/\n\n(?=[A-Z][a-z]+\n)/)
      for (const b of blocks)
        out.push({ name: `rules: ${b.startsWith('## ') ? '(heading)' : b.split('\n')[0]}`, chars: b.length })
    } else if (heading === 'Your tools' || heading === 'Tools on demand') {
      for (const l of part.split('\n')) {
        const label = l.startsWith('- ')
          ? l
              .slice(2)
              .split(/[\s:(]+/)
              .slice(0, 3)
              .join(' ')
          : '(heading)'
        out.push({ name: `${heading === 'Your tools' ? 'tools' : 'on demand'}: ${label}`, chars: l.length + 1 })
      }
    } else out.push({ name: heading, chars: part.length })
  }
  return out
}

const t = await stack()
const hub = await integrationHub()
const mcp = await registerMcpTools(t.tools, hub)
const contact = await t.directory.contacts.require(t.employee.data.contactId)
const prompt = employeePrompt({
  employee: t.employee,
  contact,
  skills: [{ name: 'release', description: 'Cut a release of a service' }],
  now: '2026-10-02T09:00:00.000Z',
  toolsOnDemand: !all,
})
const toolset = [...DEFAULT_TOOLSET, ...mcp]
const names = all ? toolset : offeredTools(toolset, [])
const specs = t.tools.specs(names)
const perTool = specs
  .map((s) => ({
    name: t.tools.resolveProviderName(s.function.name) ?? s.function.name,
    chars: JSON.stringify(s).length,
    description: s.function.description.length,
    schema: JSON.stringify(s.function.parameters).length,
  }))
  .sort((a, b) => b.chars - a.chars)
const toolChars = JSON.stringify(specs).length
const byGroup = new Map<string, number>()
for (const p of perTool) {
  const g = p.name.startsWith('mcp.') ? p.name.split('.').slice(0, 2).join('.') : p.name.split('.')[0]!
  byGroup.set(g, (byGroup.get(g) ?? 0) + p.chars)
}
const promptSections = sections(prompt)

if (json) {
  console.log(JSON.stringify({ promptChars: prompt.length, toolChars, tools: perTool.length, promptSections, perTool }, null, 2))
} else {
  console.log(`mode: ${all ? 'every tool' : 'offered by default'}`)
  console.log(`\nprompt: ${prompt.length} chars ≈ ${tok(prompt.length)} tokens`)
  for (const s of promptSections) console.log(`  ${String(tok(s.chars)).padStart(6)}  ${s.name}`)
  console.log(`\ntools: ${perTool.length} tools, ${toolChars} chars ≈ ${tok(toolChars)} tokens`)
  console.log('  by group:')
  for (const [g, c] of [...byGroup].sort((a, b) => b[1] - a[1])) console.log(`  ${String(tok(c)).padStart(6)}  ${g}`)
  console.log('  per tool (total / description / schema, tokens):')
  for (const p of perTool)
    console.log(
      `  ${String(tok(p.chars)).padStart(6)} ${String(tok(p.description)).padStart(5)} ${String(tok(p.schema)).padStart(5)}  ${p.name}`,
    )
  console.log(`\ntotal fixed overhead ≈ ${tok(prompt.length + toolChars)} tokens`)
}
await hub.close()
process.exit(0)
