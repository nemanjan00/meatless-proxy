import { isMpError, NotFoundError, ValidationError } from '@mp/core'
import type { LinearClient } from './client.ts'

/** The fields every issue summary is read with. */
const ISSUE_FIELDS = `id identifier title url priority priorityLabel createdAt updatedAt
  state { id name type } assignee { id name email } team { id key name }
  labels { nodes { id name } } project { id name } parent { id identifier title }`

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (s: string) => UUID.test(s)

/** Linear's priorities: 0 none, 1 urgent, 2 high, 3 medium (normal), 4 low. */
const PRIORITIES: Record<string, number> = { none: 0, urgent: 1, high: 2, medium: 3, normal: 3, low: 4 }

/** A priority from a number (0-4) or a name (`urgent`, `high`, `medium`/`normal`, `low`, `none`). */
export function parsePriority(p: number | string): number {
  if (typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= 4) return p
  if (typeof p === 'string') {
    const n = PRIORITIES[p.trim().toLowerCase()]
    if (n !== undefined) return n
    if (/^[0-4]$/.test(p.trim())) return Number(p.trim())
  }
  throw new ValidationError('priority must be 0-4 or one of none, urgent, high, medium, low')
}

export interface LinearUser {
  id: string
  name: string
  email?: string | null
  displayName?: string | null
  active?: boolean
}

/** A compact issue, as tools return it. */
export interface IssueSummary {
  id: string
  identifier: string
  title: string
  url: string
  state: string | null
  stateType: string | null
  priority: string | null
  assignee: { id: string; name: string; email: string | null } | null
  team: string | null
  labels: string[]
  project: string | null
  parent: string | null
  updatedAt: string
}

export function summarize(i: any): IssueSummary {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    url: i.url,
    state: i.state?.name ?? null,
    stateType: i.state?.type ?? null,
    priority: i.priorityLabel ?? (typeof i.priority === 'number' ? String(i.priority) : null),
    assignee: i.assignee ? { id: i.assignee.id, name: i.assignee.name, email: i.assignee.email ?? null } : null,
    team: i.team?.key ?? null,
    labels: (i.labels?.nodes ?? []).map((l: any) => l.name),
    project: i.project?.name ?? null,
    parent: i.parent?.identifier ?? null,
    updatedAt: i.updatedAt,
  }
}

export interface SearchIssuesInput {
  /** Full-text search over title, description and comments. */
  text?: string
  team?: string
  /** State names or types (`started`, `unstarted`, `backlog`, `triage`, `completed`, `canceled`). */
  state?: string[]
  /** `me`, `none`, an email, a user id or a name. */
  assignee?: string
  /** Label names; issues must have all of them. */
  labels?: string[]
  limit?: number
  cursor?: string
}

export interface CreateIssueInput {
  /** Team id or key; defaults to the parent's team. */
  team?: string
  title: string
  description?: string
  priority?: number | string
  /** `me`, an email, a user id or a name. */
  assignee?: string
  /** Label ids or names. */
  labels?: string[]
  /** The parent issue: identifier (`PAY-123`) or id. */
  parent?: string
  /** Project id or name. */
  project?: string
  /** Initial state name; default the team's default. */
  state?: string
}

export interface UpdateIssueInput {
  title?: string
  description?: string
  /** State name (or type) in the issue's team. */
  state?: string
  /** `me`, an email, a user id, a name, or null to unassign. */
  assignee?: string | null
  priority?: number | string
  /** Replaces all labels. */
  labels?: string[]
  addLabels?: string[]
  removeLabels?: string[]
}

/** The operations the tools are built from: queries plus id resolution (team keys, state and label names, emails). */
export function createLinearApi(client: LinearClient) {
  const one = async <T>(query: string, variables: Record<string, unknown>, pick: (d: any) => T[] | undefined) =>
    (pick(await client.request(query, variables)) ?? [])[0]

  const api = {
    client,

    async viewer() {
      const d = await client.request(
        'query Viewer { viewer { id name displayName email admin organization { id name urlKey } } }',
      )
      return d.viewer
    },

    /** A user by id, or null when there is none. */
    async user(id: string): Promise<LinearUser | null> {
      try {
        const d = await client.request('query User($id: String!) { user(id: $id) { id name displayName email active } }', { id })
        return d.user ?? null
      } catch (e) {
        if (isNotFound(e)) return null
        throw e
      }
    },

    async searchIssues(input: SearchIssuesInput) {
      const limit = clampLimit(input.limit, 25)
      const filter = await api.issueFilter(input)
      if (input.text?.trim()) {
        return client.paginate(
          `query SearchIssues($term: String!, $filter: IssueFilter, $first: Int, $after: String) {
            searchIssues(term: $term, filter: $filter, first: $first, after: $after) { nodes { ${ISSUE_FIELDS} } ${PAGE_INFO} } }`,
          { term: input.text.trim(), filter, after: input.cursor },
          (d) => d.searchIssues,
          limit,
        )
      }
      return client.paginate(
        `query Issues($filter: IssueFilter, $first: Int, $after: String) {
          issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } ${PAGE_INFO} } }`,
        { filter, after: input.cursor },
        (d) => d.issues,
        limit,
      )
    },

    async issueFilter(input: SearchIssuesInput): Promise<Record<string, unknown> | null> {
      const and: Record<string, unknown>[] = []
      if (input.team) and.push({ team: isUuid(input.team) ? { id: { eq: input.team } } : teamByKeyOrName(input.team) })
      if (input.state?.length)
        and.push({
          state: { or: input.state.flatMap((s) => [{ name: { eqIgnoreCase: s } }, { type: { eq: s.toLowerCase() } }]) },
        })
      if (input.assignee) and.push({ assignee: userFilter(input.assignee) })
      for (const l of input.labels ?? []) and.push({ labels: { some: { name: { eqIgnoreCase: l } } } })
      return and.length ? { and } : null
    },

    async getIssue(ref: string, comments = 10) {
      const d = await client.request(
        `query Issue($id: String!, $comments: Int) { issue(id: $id) { ${ISSUE_FIELDS} description estimate dueDate
          creator { id name } cycle { id number name }
          children(first: 50) { nodes { id identifier title state { name type } assignee { id name } } }
          comments(first: $comments, orderBy: createdAt) { nodes { id body createdAt url user { id name email } } } } }`,
        { id: ref, comments: clampLimit(comments, 10, 50) },
      )
      if (!d.issue) throw new NotFoundError('Linear issue', ref)
      return d.issue
    },

    /** The issue's ids, team and labels: for resolving references before a mutation. */
    async issueRef(ref: string): Promise<{ id: string; identifier: string; url: string; teamId: string; labelIds: string[] }> {
      const d = await client.request(
        'query IssueRef($id: String!) { issue(id: $id) { id identifier url team { id } labels { nodes { id } } } }',
        { id: ref },
      )
      if (!d.issue) throw new NotFoundError('Linear issue', ref)
      return {
        id: d.issue.id,
        identifier: d.issue.identifier,
        url: d.issue.url,
        teamId: d.issue.team.id,
        labelIds: (d.issue.labels?.nodes ?? []).map((l: any) => l.id),
      }
    },

    async teamId(ref: string): Promise<string> {
      if (isUuid(ref)) return ref
      const t = await one<{ id: string }>(
        'query TeamByKey($filter: TeamFilter) { teams(filter: $filter, first: 2) { nodes { id key name } } }',
        { filter: teamByKeyOrName(ref) },
        (d) => d.teams?.nodes,
      )
      if (!t) throw new NotFoundError('Linear team', ref, { hint: 'list_teams shows the teams and their keys' })
      return t.id
    },

    async stateId(teamId: string, name: string): Promise<string> {
      const d = await client.request(
        'query StatesForTeam($filter: WorkflowStateFilter) { workflowStates(filter: $filter, first: 100) { nodes { id name type } } }',
        { filter: { team: { id: { eq: teamId } } } },
      )
      const states: { id: string; name: string; type: string }[] = d.workflowStates?.nodes ?? []
      const want = name.trim().toLowerCase()
      const s = states.find((x) => x.name.toLowerCase() === want) ?? states.find((x) => x.type === want)
      if (!s)
        throw new ValidationError(`no workflow state "${name}" in this team`, [`states: ${states.map((x) => x.name).join(', ')}`])
      return s.id
    },

    async userId(ref: string): Promise<string> {
      if (isUuid(ref)) return ref
      if (ref.trim().toLowerCase() === 'me') return (await api.viewer()).id
      const u = await one<LinearUser>(
        'query UserByRef($filter: UserFilter) { users(filter: $filter, first: 2) { nodes { id name email } } }',
        { filter: userFilter(ref) },
        (d) => d.users?.nodes,
      )
      if (!u) throw new NotFoundError('Linear user', ref, { hint: 'list_users shows the users' })
      return u.id
    },

    /** Label ids from ids or names. A team's own label wins over a workspace label of the same name. */
    async labelIds(teamId: string, refs: string[]): Promise<string[]> {
      const names = refs.filter((r) => !isUuid(r))
      const byName = new Map<string, string>()
      if (names.length) {
        const d = await client.request(
          'query LabelsByName($filter: IssueLabelFilter) { issueLabels(filter: $filter, first: 250) { nodes { id name team { id } } } }',
          {
            filter: {
              or: names.map((n) => ({ name: { eqIgnoreCase: n } })),
              and: [{ or: [{ team: { id: { eq: teamId } } }, { team: { null: true } }] }],
            },
          },
        )
        const nodes: { id: string; name: string; team: { id: string } | null }[] = d.issueLabels?.nodes ?? []
        for (const l of [...nodes].sort((a, b) => Number(!!a.team) - Number(!!b.team))) byName.set(l.name.toLowerCase(), l.id)
      }
      const missing = names.filter((n) => !byName.has(n.toLowerCase()))
      if (missing.length) throw new ValidationError('unknown labels', [missing.join(', '), 'list_labels shows the labels'])
      return [...new Set(refs.map((r) => (isUuid(r) ? r : byName.get(r.toLowerCase())!)))]
    },

    async projectId(ref: string): Promise<string> {
      if (isUuid(ref)) return ref
      const p = await one<{ id: string }>(
        'query ProjectByName($filter: ProjectFilter) { projects(filter: $filter, first: 2) { nodes { id name } } }',
        { filter: { name: { eqIgnoreCase: ref } } },
        (d) => d.projects?.nodes,
      )
      if (!p) throw new NotFoundError('Linear project', ref, { hint: 'list_projects shows the projects' })
      return p.id
    },

    async createIssue(input: CreateIssueInput) {
      if (!input.title?.trim()) throw new ValidationError('title is required')
      const parent = input.parent ? await api.issueRef(input.parent) : null
      const teamId = input.team ? await api.teamId(input.team) : parent?.teamId
      if (!teamId) throw new ValidationError('team is required (a team key such as PAY, or a parent issue)')
      const issueInput: Record<string, unknown> = { teamId, title: input.title.trim() }
      if (input.description !== undefined) issueInput.description = input.description
      if (input.priority !== undefined) issueInput.priority = parsePriority(input.priority)
      if (input.assignee && input.assignee.trim().toLowerCase() !== 'none')
        issueInput.assigneeId = await api.userId(input.assignee)
      if (input.labels?.length) issueInput.labelIds = await api.labelIds(teamId, input.labels)
      if (parent) issueInput.parentId = parent.id
      if (input.project) issueInput.projectId = await api.projectId(input.project)
      if (input.state) issueInput.stateId = await api.stateId(teamId, input.state)
      const d = await client.request(
        `mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
        { input: issueInput },
        { mutation: true },
      )
      if (!d.issueCreate?.success || !d.issueCreate.issue) throw new ValidationError('Linear did not create the issue')
      return d.issueCreate.issue
    },

    async updateIssue(ref: string, input: UpdateIssueInput) {
      const issue = await api.issueRef(ref)
      const patch: Record<string, unknown> = {}
      if (input.title !== undefined) patch.title = input.title
      if (input.description !== undefined) patch.description = input.description
      if (input.priority !== undefined) patch.priority = parsePriority(input.priority)
      if (input.state) patch.stateId = await api.stateId(issue.teamId, input.state)
      if (input.assignee === null || (typeof input.assignee === 'string' && input.assignee.toLowerCase() === 'none'))
        patch.assigneeId = null
      else if (input.assignee) patch.assigneeId = await api.userId(input.assignee)
      if (input.labels || input.addLabels?.length || input.removeLabels?.length) {
        const base = input.labels ? await api.labelIds(issue.teamId, input.labels) : issue.labelIds
        const add = input.addLabels?.length ? await api.labelIds(issue.teamId, input.addLabels) : []
        const remove = new Set(input.removeLabels?.length ? await api.labelIds(issue.teamId, input.removeLabels) : [])
        patch.labelIds = [...new Set([...base, ...add])].filter((id) => !remove.has(id))
      }
      if (!Object.keys(patch).length) throw new ValidationError('nothing to update')
      const d = await client.request(
        `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
        { id: issue.id, input: patch },
        { mutation: true },
      )
      if (!d.issueUpdate?.success || !d.issueUpdate.issue) throw new ValidationError('Linear did not update the issue')
      return d.issueUpdate.issue
    },

    async comment(ref: string, body: string) {
      if (!body?.trim()) throw new ValidationError('body is required')
      const issueId = isUuid(ref) ? ref : (await api.issueRef(ref)).id
      const d = await client.request(
        'mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url createdAt issue { identifier } } } }',
        { input: { issueId, body } },
        { mutation: true },
      )
      if (!d.commentCreate?.success || !d.commentCreate.comment) throw new ValidationError('Linear did not create the comment')
      return d.commentCreate.comment
    },

    async listTeams(limit?: number) {
      return client.paginate(
        `query Teams($first: Int, $after: String) { teams(first: $first, after: $after) { nodes { id key name description } ${PAGE_INFO} } }`,
        {},
        (d) => d.teams,
        clampLimit(limit, 100, 250),
      )
    },

    async listWorkflowStates(team: string) {
      const filter = { team: isUuid(team) ? { id: { eq: team } } : teamByKeyOrName(team) }
      return client.paginate(
        `query WorkflowStates($filter: WorkflowStateFilter, $first: Int, $after: String) {
          workflowStates(filter: $filter, first: $first, after: $after) { nodes { id name type position team { key } } ${PAGE_INFO} } }`,
        { filter },
        (d) => d.workflowStates,
        250,
      )
    },

    async listUsers(opts: { query?: string; includeInactive?: boolean; limit?: number }) {
      const and: Record<string, unknown>[] = []
      if (!opts.includeInactive) and.push({ active: { eq: true } })
      if (opts.query?.trim()) {
        const q = opts.query.trim()
        and.push({
          or: [
            { name: { containsIgnoreCase: q } },
            { displayName: { containsIgnoreCase: q } },
            { email: { containsIgnoreCase: q } },
          ],
        })
      }
      return client.paginate(
        `query Users($filter: UserFilter, $first: Int, $after: String) {
          users(filter: $filter, first: $first, after: $after) { nodes { id name displayName email active } ${PAGE_INFO} } }`,
        { filter: and.length ? { and } : null },
        (d) => d.users,
        clampLimit(opts.limit, 100, 250),
      )
    },

    async listProjects(opts: { team?: string; limit?: number }) {
      const filter = opts.team
        ? { accessibleTeams: { some: isUuid(opts.team) ? { id: { eq: opts.team } } : teamByKeyOrName(opts.team) } }
        : null
      return client.paginate(
        `query Projects($filter: ProjectFilter, $first: Int, $after: String) {
          projects(filter: $filter, first: $first, after: $after) { nodes { id name url state targetDate lead { id name } } ${PAGE_INFO} } }`,
        { filter },
        (d) => d.projects,
        clampLimit(opts.limit, 50, 250),
      )
    },

    async listLabels(opts: { team?: string; limit?: number }) {
      const filter = opts.team
        ? { or: [{ team: isUuid(opts.team) ? { id: { eq: opts.team } } : teamByKeyOrName(opts.team) }, { team: { null: true } }] }
        : null
      return client.paginate(
        `query Labels($filter: IssueLabelFilter, $first: Int, $after: String) {
          issueLabels(filter: $filter, first: $first, after: $after) { nodes { id name color team { key } parent { name } } ${PAGE_INFO} } }`,
        { filter },
        (d) => d.issueLabels,
        clampLimit(opts.limit, 250, 250),
      )
    },

    async listCycles(opts: { team?: string; limit?: number }) {
      const filter = opts.team ? { team: isUuid(opts.team) ? { id: { eq: opts.team } } : teamByKeyOrName(opts.team) } : null
      return client.paginate(
        `query Cycles($filter: CycleFilter, $first: Int, $after: String) {
          cycles(filter: $filter, first: $first, after: $after, orderBy: createdAt) { nodes { id number name startsAt endsAt completedAt isActive team { key } } ${PAGE_INFO} } }`,
        { filter },
        (d) => d.cycles,
        clampLimit(opts.limit, 20, 100),
      )
    },

    /** The identifier of an issue by id, best effort (one attempt): for webhooks that only carry the id. */
    async identifierOf(issueId: string): Promise<{ identifier: string; title: string; url: string } | null> {
      const d = await client.request(
        'query IssueIdentifier($id: String!) { issue(id: $id) { identifier title url } }',
        { id: issueId },
        { maxRetries: 0 },
      )
      return d.issue ?? null
    },
  }
  return api
}

export type LinearApi = ReturnType<typeof createLinearApi>

/** Linear reports a missing entity as a GraphQL error ("Entity not found", "Could not find referenced …"). */
export function isNotFound(e: unknown): boolean {
  return isMpError(e, 'not_found') || (isMpError(e, 'integration_request') && /not found|could not find/i.test(e.message))
}

function teamByKeyOrName(ref: string) {
  return { or: [{ key: { eqIgnoreCase: ref } }, { name: { eqIgnoreCase: ref } }] }
}

function userFilter(ref: string): Record<string, unknown> {
  const r = ref.trim()
  if (r.toLowerCase() === 'me') return { isMe: { eq: true } }
  if (r.toLowerCase() === 'none') return { null: true }
  if (isUuid(r)) return { id: { eq: r } }
  if (r.includes('@')) return { email: { eqIgnoreCase: r } }
  return { or: [{ name: { eqIgnoreCase: r } }, { displayName: { eqIgnoreCase: r } }] }
}

function clampLimit(n: number | undefined, dflt: number, max = 100): number {
  if (n === undefined || !Number.isFinite(n)) return dflt
  return Math.max(1, Math.min(max, Math.floor(n)))
}
