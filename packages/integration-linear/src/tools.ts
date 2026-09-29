import { errorMessage, isMpError, type Logger } from '@mp/core'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { type LinearApi, summarize } from './api.ts'

export const LINEAR_TOOLS = [
  'search_issues',
  'get_issue',
  'create_issue',
  'update_issue',
  'create_sub_issue',
  'comment',
  'list_teams',
  'list_workflow_states',
  'list_users',
  'list_projects',
  'list_labels',
  'list_cycles',
  'viewer',
] as const

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const priority = z
  .union([z.number().int().min(0).max(4), z.string()])
  .describe('0 none, 1 urgent, 2 high, 3 medium, 4 low; or the name.')
const stringList = (d: string) => z.union([z.string(), z.array(z.string())]).describe(d)
const list = (v: string | string[] | undefined) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])

/** The Linear MCP server: every tool returns compact JSON text; failures come back as `isError` results. */
export function createLinearMcpServer(api: LinearApi, logger: Logger, version = '0.0.0'): McpServer {
  const server = new McpServer({ name: 'linear', version })
  const run = async (tool: string, f: () => Promise<unknown>): Promise<ToolResult> => {
    try {
      const out = await f()
      return { content: [{ type: 'text', text: JSON.stringify(out) }] }
    } catch (e) {
      const details = isMpError(e) ? e.details : undefined
      logger.warn('linear tool failed', { tool, error: errorMessage(e) })
      const err: Record<string, unknown> = { error: errorMessage(e) }
      if (isMpError(e)) err.code = e.code
      if (details?.status) err.status = details.status
      if (details?.hint) err.hint = details.hint
      return { content: [{ type: 'text', text: JSON.stringify(err) }], isError: true }
    }
  }
  const read = { readOnlyHint: true, openWorldHint: true }
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true }

  server.registerTool(
    'search_issues',
    {
      description:
        'Find Linear issues. Combine full-text `text` with filters: team (key such as PAY), state (names or types: triage, backlog, unstarted, started, completed, canceled), assignee (me, none, an email or a name) and labels (all must match). Returns compact issues, most recently updated first, and nextCursor for the next page.',
      inputSchema: {
        text: z.string().optional().describe('Words to search for in titles, descriptions and comments.'),
        team: z.string().optional().describe('Team key (PAY), name or id.'),
        state: stringList('State name(s) or type(s).').optional(),
        assignee: z.string().optional().describe('me, none, an email, a name or a user id.'),
        labels: stringList('Label name(s); an issue must have all of them.').optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Default 25, at most 100.'),
        cursor: z.string().optional().describe('nextCursor from a previous call.'),
      },
      annotations: read,
    },
    (a) =>
      run('search_issues', async () => {
        const res = await api.searchIssues({ ...a, state: list(a.state), labels: list(a.labels) })
        return { issues: res.nodes.map(summarize), nextCursor: res.nextCursor }
      }),
  )

  server.registerTool(
    'get_issue',
    {
      description:
        'Read one Linear issue by identifier (PAY-123) or id: description, state, assignee, labels, parent, sub-issues and the latest comments.',
      inputSchema: {
        issue: z.string().describe('Identifier such as PAY-123, or the issue id.'),
        comments: z.number().int().min(0).max(50).optional().describe('How many of the latest comments to include. Default 10.'),
      },
      annotations: read,
    },
    (a) =>
      run('get_issue', async () => {
        const i = await api.getIssue(a.issue, a.comments ?? 10)
        const comments = [...(i.comments?.nodes ?? [])]
          .sort((x: any, y: any) => String(x.createdAt).localeCompare(String(y.createdAt)))
          .map((c: any) => ({
            id: c.id,
            author: c.user ? { id: c.user.id, name: c.user.name, email: c.user.email ?? null } : null,
            createdAt: c.createdAt,
            body: c.body,
          }))
        return {
          ...summarize(i),
          description: i.description ?? '',
          estimate: i.estimate ?? null,
          dueDate: i.dueDate ?? null,
          cycle: i.cycle ? (i.cycle.name ?? `Cycle ${i.cycle.number}`) : null,
          creator: i.creator ? { id: i.creator.id, name: i.creator.name } : null,
          parent: i.parent ? { identifier: i.parent.identifier, title: i.parent.title } : null,
          children: (i.children?.nodes ?? []).map((c: any) => ({
            identifier: c.identifier,
            title: c.title,
            state: c.state?.name ?? null,
            assignee: c.assignee?.name ?? null,
          })),
          createdAt: i.createdAt,
          comments,
        }
      }),
  )

  server.registerTool(
    'create_issue',
    {
      description:
        "Create a Linear issue. teamId takes a team key (PAY) or id and may be left out when parentId is given (the parent's team is used). assigneeId takes me, an email, a name or an id; labelIds take names or ids; parentId takes an identifier (PAY-123) or id; projectId a name or id. Returns the new issue with its identifier and url.",
      inputSchema: {
        teamId: z.string().optional().describe('Team key (PAY), name or id.'),
        title: z.string().min(1),
        description: z.string().optional().describe('Markdown.'),
        priority: priority.optional(),
        assigneeId: z.string().optional().describe('me, an email, a name or a user id.'),
        labelIds: z.array(z.string()).optional().describe('Label names or ids.'),
        parentId: z.string().optional().describe('Parent issue identifier (PAY-123) or id: makes this a sub-issue.'),
        projectId: z.string().optional().describe('Project name or id.'),
        state: z.string().optional().describe("Initial state name; default the team's default state."),
      },
      annotations: write,
    },
    (a) =>
      run('create_issue', async () =>
        summarize(
          await api.createIssue({
            title: a.title,
            ...(a.teamId ? { team: a.teamId } : {}),
            ...(a.description !== undefined ? { description: a.description } : {}),
            ...(a.priority !== undefined ? { priority: a.priority } : {}),
            ...(a.assigneeId ? { assignee: a.assigneeId } : {}),
            ...(a.labelIds ? { labels: a.labelIds } : {}),
            ...(a.parentId ? { parent: a.parentId } : {}),
            ...(a.projectId ? { project: a.projectId } : {}),
            ...(a.state ? { state: a.state } : {}),
          }),
        ),
      ),
  )

  server.registerTool(
    'update_issue',
    {
      description:
        'Change a Linear issue: title, description (markdown, replaces it), state by name (e.g. "In Progress", "Done"), assignee (me, an email, a name, an id, or null/"none" to unassign), priority, and labels (labels replaces them all; addLabels and removeLabels change some). Returns the updated issue.',
      inputSchema: {
        issue: z.string().describe('Identifier such as PAY-123, or the issue id.'),
        title: z.string().optional(),
        description: z.string().optional(),
        state: z.string().optional(),
        assignee: z.string().nullable().optional(),
        priority: priority.optional(),
        labels: z.array(z.string()).optional(),
        addLabels: z.array(z.string()).optional(),
        removeLabels: z.array(z.string()).optional(),
      },
      annotations: write,
    },
    ({ issue, ...patch }) => run('update_issue', async () => summarize(await api.updateIssue(issue, patch))),
  )

  server.registerTool(
    'create_sub_issue',
    {
      description:
        'Split work out as a sub-issue of an existing Linear issue, in the parent\'s team: a "real fork" people can see and track. Returns the new identifier and url.',
      inputSchema: {
        parent: z.string().describe('Parent identifier (PAY-123) or id.'),
        title: z.string().min(1),
        description: z.string().optional().describe('Markdown.'),
        assignee: z.string().optional().describe('me, an email, a name or a user id.'),
        priority: priority.optional(),
        labels: z.array(z.string()).optional().describe('Label names or ids.'),
      },
      annotations: write,
    },
    (a) =>
      run('create_sub_issue', async () => {
        const i = await api.createIssue({
          parent: a.parent,
          title: a.title,
          ...(a.description !== undefined ? { description: a.description } : {}),
          ...(a.assignee ? { assignee: a.assignee } : {}),
          ...(a.priority !== undefined ? { priority: a.priority } : {}),
          ...(a.labels ? { labels: a.labels } : {}),
        })
        return { id: i.id, identifier: i.identifier, url: i.url, title: i.title, parent: i.parent?.identifier ?? a.parent }
      }),
  )

  server.registerTool(
    'comment',
    {
      description: 'Post a comment (markdown) on a Linear issue. Returns the comment id and url.',
      inputSchema: {
        issue: z.string().describe('Identifier such as PAY-123, or the issue id.'),
        body: z.string().min(1).describe('Markdown.'),
      },
      annotations: write,
    },
    (a) =>
      run('comment', async () => {
        const c = await api.comment(a.issue, a.body)
        return { id: c.id, url: c.url, identifier: c.issue?.identifier ?? a.issue, createdAt: c.createdAt }
      }),
  )

  server.registerTool(
    'list_teams',
    {
      description: 'List the Linear teams with their keys (the PAY in PAY-123).',
      inputSchema: { limit: z.number().int().optional() },
      annotations: read,
    },
    (a) =>
      run('list_teams', async () => ({
        teams: (await api.listTeams(a.limit)).nodes.map((t: any) => ({ id: t.id, key: t.key, name: t.name })),
      })),
  )

  server.registerTool(
    'list_workflow_states',
    {
      description: "List a team's workflow states (the names update_issue's state takes), in board order.",
      inputSchema: { team: z.string().describe('Team key (PAY), name or id.') },
      annotations: read,
    },
    (a) =>
      run('list_workflow_states', async () => ({
        states: (await api.listWorkflowStates(a.team)).nodes
          .sort((x: any, y: any) => (x.position ?? 0) - (y.position ?? 0))
          .map((s: any) => ({ id: s.id, name: s.name, type: s.type })),
      })),
  )

  server.registerTool(
    'list_users',
    {
      description: 'List Linear users (active only unless includeInactive), optionally matching a name or email.',
      inputSchema: {
        query: z.string().optional(),
        includeInactive: z.boolean().optional(),
        limit: z.number().int().optional(),
      },
      annotations: read,
    },
    (a) =>
      run('list_users', async () => ({
        users: (await api.listUsers(a)).nodes.map((u: any) => ({
          id: u.id,
          name: u.name,
          displayName: u.displayName ?? null,
          email: u.email ?? null,
          ...(u.active === false ? { active: false } : {}),
        })),
      })),
  )

  server.registerTool(
    'list_projects',
    {
      description: 'List Linear projects, optionally only those of one team.',
      inputSchema: { team: z.string().optional(), limit: z.number().int().optional() },
      annotations: read,
    },
    (a) =>
      run('list_projects', async () => ({
        projects: (await api.listProjects(a)).nodes.map((p: any) => ({
          id: p.id,
          name: p.name,
          state: p.state ?? null,
          lead: p.lead?.name ?? null,
          targetDate: p.targetDate ?? null,
          url: p.url ?? null,
        })),
      })),
  )

  server.registerTool(
    'list_labels',
    {
      description: "List issue labels: a team's own plus the workspace's, or all of them.",
      inputSchema: { team: z.string().optional(), limit: z.number().int().optional() },
      annotations: read,
    },
    (a) =>
      run('list_labels', async () => ({
        labels: (await api.listLabels(a)).nodes.map((l: any) => ({
          id: l.id,
          name: l.parent?.name ? `${l.parent.name}/${l.name}` : l.name,
          team: l.team?.key ?? null,
        })),
      })),
  )

  server.registerTool(
    'list_cycles',
    {
      description: "List a team's cycles (sprints), newest first, with which one is active.",
      inputSchema: { team: z.string().optional(), limit: z.number().int().optional() },
      annotations: read,
    },
    (a) =>
      run('list_cycles', async () => ({
        cycles: (await api.listCycles(a)).nodes.map((c: any) => ({
          id: c.id,
          number: c.number,
          name: c.name ?? null,
          team: c.team?.key ?? null,
          startsAt: c.startsAt,
          endsAt: c.endsAt,
          active: !!c.isActive,
          completed: !!c.completedAt,
        })),
      })),
  )

  server.registerTool(
    'viewer',
    { description: 'Who this Linear connection acts as: the user and the workspace.', annotations: read },
    () =>
      run('viewer', async () => {
        const v = await api.viewer()
        return {
          id: v.id,
          name: v.name,
          displayName: v.displayName ?? null,
          email: v.email ?? null,
          organization: v.organization ? { name: v.organization.name, urlKey: v.organization.urlKey } : null,
        }
      }),
  )

  return server
}
