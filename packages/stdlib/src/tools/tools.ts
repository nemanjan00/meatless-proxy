import { globMatch, type Json } from '@mp/core'
import { VISION_TAG } from '@mp/runner'
import type { Session } from '@mp/sessions'
import { LOADED_TOOLS_META, loadedToolsOf, type ToolContext, type ToolDefinition } from '@mp/tools'
import { fail, ok, type Kit } from '../kit.ts'
import { groupOf, isOnDemandTool, ON_DEMAND_GROUPS, onDemandFor } from '../on-demand.ts'

/** Results tools.find returns by default, and at most. */
const FIND_LIMIT = 12
const FIND_MAX = 40
/** Words too common to tell tools apart. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'in',
  'on',
  'for',
  'and',
  'or',
  'with',
  'my',
  'i',
  'me',
  'tool',
  'tools',
])

/** The first sentence of a description, at most `max` characters. */
export function oneLineAbout(description: string, max = 140): string {
  const flat = description.replace(/\s+/g, ' ').trim()
  const end = flat.search(/[.:;](\s|$)/)
  const first = end > 0 ? flat.slice(0, end) : flat
  return first.length <= max ? first : `${first.slice(0, max - 1)}…`
}

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))

/** How well a tool matches the query words: its name counts most, then its group, then its description. */
function score(def: ToolDefinition, query: string[]): number {
  const name = new Set(words(def.name))
  const group = groupOf(def.name)
  const groupText = group ? ` ${group.name} ${group.about} ` : ''
  const desc = ` ${def.description.toLowerCase()} `
  let s = 0
  for (const w of query) {
    if (name.has(w)) s += 4
    else if ([...name].some((n) => n.startsWith(w) || w.startsWith(n))) s += 2
    if (groupText.includes(w)) s += 2
    if (desc.includes(w)) s += 1
  }
  return s
}

/**
 * tools.find and tools.load: how a session finds and loads its on-demand tools. Both only see the tools
 * of the session's toolset (the permission boundary) that are registered and allowed.
 */
export function registerToolTools(kit: Kit) {
  const { registry, deps } = kit

  /** The tools a session may use: its toolset, registered, allowed for the employee, and visible to the model. */
  const usable = async (session: Session): Promise<ToolDefinition[]> => {
    const allowed = deps.toolsetFor ? new Set(await deps.toolsetFor(session.data.employeeId)) : null
    return session.data.toolset
      .map((n) => registry.get(n)?.def)
      .filter((d): d is ToolDefinition => !!d)
      .filter((d) => !allowed || allowed.has(d.name))
      .filter((d) => deps.vision?.enabled || !d.tags?.includes(VISION_TAG))
  }

  const loadedNow = (session: Session) => new Set(loadedToolsOf(session.data.meta))
  const isOffered = (session: Session, name: string, loaded: Set<string>) =>
    !onDemandFor(session.data.toolset)?.(name) || loaded.has(name)

  kit.tool(
    {
      name: 'tools.find',
      description:
        'Search the tools you can load: returns matching tool names with one line each, and whether each is loaded. Search by what you want to do (e.g. "remind me tomorrow", "upload a file to slack", "merge request review"). Then tools.load the ones you need.',
      effect: 'read',
      params: {
        properties: {
          query: { type: 'string', description: 'What you want to do, or part of a tool name.' },
          limit: { type: 'number', description: `Most results. Default ${FIND_LIMIT}.` },
        },
        required: ['query'],
      },
    },
    async (a, ctx: ToolContext) => {
      const session = await kit.ownSession(undefined, ctx)
      const defs = await usable(session)
      const loaded = loadedNow(session)
      const limit = Math.max(1, Math.min(FIND_MAX, Math.floor(Number(a.limit) || FIND_LIMIT)))
      const query = String(a.query ?? '').trim()
      const q = words(query)
      // A pattern or an exact name finds those tools.
      const byName = query.includes('.') ? defs.filter((d) => d.name === query || globMatch(query, d.name)) : []
      const ranked = (
        byName.length ? byName.map((d) => ({ d, s: 100 })) : defs.map((d) => ({ d, s: score(d, q) })).filter((x) => x.s > 0)
      )
        .sort((x, y) => y.s - x.s || x.d.name.localeCompare(y.d.name))
        .slice(0, limit)
      const tools = ranked.map(({ d }) => ({
        name: d.name,
        about: oneLineAbout(d.description),
        loaded: isOffered(session, d.name, loaded),
      }))
      const groups = ON_DEMAND_GROUPS.map((g) => ({ name: g.name, about: g.about, tools: g.list }))
      if (!tools.length)
        return ok({
          tools: [],
          note: `No tool matches ${JSON.stringify(query)}. These are the groups of tools you can load; search again with other words.`,
          groups: groups as unknown as Json,
        })
      const toLoad = tools.filter((t) => !t.loaded).map((t) => t.name)
      return ok({
        tools,
        ...(toLoad.length ? { next: `tools.load { names: ${JSON.stringify(toLoad.slice(0, 5))} } to use them.` } : {}),
      })
    },
  )

  kit.tool(
    {
      name: 'tools.load',
      description:
        'Load tools (names from tools.find, or a pattern like mcp.slack.*) so you can call them: they are offered from your next step and stay loaded for the rest of this session.',
      effect: 'idempotent',
      params: {
        properties: {
          names: { type: 'array', items: { type: 'string' }, description: 'Tool names or patterns, e.g. ["schedule.create"].' },
        },
        required: ['names'],
      },
    },
    async (a, ctx: ToolContext) => {
      const asked = (Array.isArray(a.names) ? a.names : [a.names]).filter((n: unknown): n is string => typeof n === 'string')
      if (!asked.length) return fail('give names: tool names from tools.find, e.g. ["schedule.create"]')
      const session = await kit.ownSession(undefined, ctx)
      const defs = await usable(session)
      const loaded = loadedNow(session)
      const add: string[] = []
      const already: string[] = []
      const unknown: string[] = []
      for (const n of asked) {
        const name = n.trim()
        const matches = defs.filter((d) => d.name === name || (name.includes('*') && globMatch(name, d.name)))
        if (!matches.length) unknown.push(name)
        for (const d of matches) {
          if (isOffered(session, d.name, loaded) || add.includes(d.name)) {
            if (!already.includes(d.name) && !add.includes(d.name)) already.push(d.name)
          } else if (isOnDemandTool(d.name)) add.push(d.name)
        }
      }
      if (add.length)
        await kit.patchMeta(session.id, (m) => {
          const have = loadedToolsOf(m)
          m[LOADED_TOOLS_META] = [...new Set([...have, ...add])].sort()
          return m
        })
      if (!add.length && !already.length)
        return fail(`no tool you can use matches ${unknown.join(', ')}: search with tools.find`, { unknown })
      return ok({
        ...(add.length ? { loaded: add } : {}),
        ...(already.length ? { alreadyLoaded: already } : {}),
        ...(unknown.length ? { unknown, hint: 'Not tools you can use: search with tools.find.' } : {}),
        ...(add.length ? { note: 'Offered from your next step, for the rest of this session.' } : {}),
      })
    },
  )
}
