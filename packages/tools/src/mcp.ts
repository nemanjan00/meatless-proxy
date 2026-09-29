import type { Json } from '@mp/core'
import { resultText, type McpHub } from '@mp/mcp'
import type { EffectClass, ToolRegistry } from './types.ts'

export interface RegisterMcpOptions {
  /** Effect class per tool. Default: `non_idempotent` (outside systems are the uncertain ones). */
  effectOf?: (server: string, tool: string) => EffectClass
  /** Secret variable names a tool needs injected at call time. */
  secretsOf?: (server: string, tool: string) => string[] | undefined
  /** Only (re)register the tools of this server. */
  server?: string
}

/** `mcp.<server>.<tool>`. Characters outside `[A-Za-z0-9_-]` in either part become `_`. */
export function mcpToolName(server: string, tool: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')
  return `mcp.${safe(server)}.${safe(tool)}`
}

/**
 * Registers every tool of the hub as `mcp.<server>.<tool>`. Calling it again
 * refreshes: tools are replaced with their current definitions, and MCP tools
 * of the covered servers that are gone are unregistered. Returns the
 * registered names, sorted.
 *
 * The handler calls `hub.callTool` with the model's arguments and the call's
 * abort signal. Its output is the result's text (or its structured content
 * when there is no text), and `isError` is passed through.
 */
export async function registerMcpTools(registry: ToolRegistry, hub: McpHub, opts: RegisterMcpOptions = {}): Promise<string[]> {
  const infos = await hub.listTools(opts.server)
  const names = new Set<string>()
  for (const info of infos) {
    if (opts.server !== undefined && info.server !== opts.server) continue
    const name = mcpToolName(info.server, info.name)
    const secrets = opts.secretsOf?.(info.server, info.name)
    const { server, name: tool } = info
    registry.register(
      {
        name,
        description: info.description ?? '',
        parameters:
          info.inputSchema && typeof info.inputSchema === 'object' ? info.inputSchema : { type: 'object', properties: {} },
        effect: opts.effectOf?.(server, tool) ?? 'non_idempotent',
        source: 'mcp',
        server,
        ...(secrets?.length ? { secrets } : {}),
      },
      async (args, ctx) => {
        const res = await hub.callTool(server, tool, (args ?? {}) as Record<string, unknown>, { signal: ctx.signal })
        const text = resultText(res)
        const output: Json = text || res.structuredContent === undefined ? text : (res.structuredContent as Json)
        return res.isError ? { output, isError: true } : { output }
      },
      { replace: true },
    )
    names.add(name)
  }
  for (const def of registry.list()) {
    if (def.source !== 'mcp' || names.has(def.name)) continue
    if (opts.server !== undefined && def.server !== opts.server) continue
    registry.unregister(def.name)
  }
  return [...names].sort()
}
