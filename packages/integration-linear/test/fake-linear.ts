import { randomUUID } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A local stand-in for Linear's GraphQL API (https://api.linear.app/graphql), shaped after
 * Linear's public schema: connections with `nodes` and `pageInfo`, filters with comparators
 * (`eq`, `eqIgnoreCase`, `containsIgnoreCase`, `in`, `null`, `some`, `isMe`, `and`/`or`),
 * `issueCreate`/`issueUpdate`/`commentCreate` payloads with `success`, and errors with
 * `extensions.code` (`RATELIMITED` on HTTP 400, `AUTHENTICATION_ERROR`, `INVALID_INPUT`).
 * Operations are dispatched by operation name, and every response returns the whole object
 * (a superset of the selection).
 */

export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export interface FakeUser {
  id: string
  name: string
  displayName: string
  email: string
  active: boolean
}
export interface FakeIssue {
  id: string
  number: number
  teamId: string
  title: string
  description: string
  priority: number
  stateId: string
  assigneeId: string | null
  creatorId: string
  labelIds: string[]
  parentId: string | null
  projectId: string | null
  createdAt: string
  updatedAt: string
}
export interface FakeComment {
  id: string
  issueId: string
  userId: string
  body: string
  createdAt: string
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> }

const PRIORITY_LABELS = ['No priority', 'Urgent', 'High', 'Medium', 'Low']

export class FakeLinear {
  apiKey = 'lin-test-key'
  viewerId = uid(101)
  teams = [
    { id: uid(1), key: 'PAY', name: 'Payments', description: 'Money in, money out' },
    { id: uid(2), key: 'OPS', name: 'Operations', description: null },
  ]
  users: FakeUser[] = [
    { id: uid(101), name: 'Kai Bot', displayName: 'kai', email: 'kai@example.com', active: true },
    { id: uid(102), name: 'Ana Example', displayName: 'ana', email: 'ana@example.com', active: true },
    { id: uid(103), name: 'Old Timer', displayName: 'old', email: 'old@example.com', active: false },
  ]
  states = [
    { id: uid(201), teamId: uid(1), name: 'Backlog', type: 'backlog', position: 0 },
    { id: uid(202), teamId: uid(1), name: 'Todo', type: 'unstarted', position: 1 },
    { id: uid(203), teamId: uid(1), name: 'In Progress', type: 'started', position: 2 },
    { id: uid(204), teamId: uid(1), name: 'Done', type: 'completed', position: 3 },
    { id: uid(205), teamId: uid(2), name: 'Todo', type: 'unstarted', position: 0 },
  ]
  labels = [
    { id: uid(301), name: 'bug', color: '#f00', teamId: null as string | null, parentId: null as string | null },
    { id: uid(302), name: 'backend', color: '#0f0', teamId: uid(1), parentId: null },
    { id: uid(303), name: 'bug', color: '#f0f', teamId: uid(1), parentId: null },
    { id: uid(304), name: 'infra', color: '#00f', teamId: uid(2), parentId: null },
  ]
  projects = [
    { id: uid(401), name: 'Checkout v2', state: 'started', targetDate: '2026-12-01', leadId: uid(102), teamIds: [uid(1)] },
    { id: uid(402), name: 'Datacenter move', state: 'planned', targetDate: null, leadId: null, teamIds: [uid(2)] },
  ]
  cycles = [
    {
      id: uid(501),
      number: 7,
      name: null,
      teamId: uid(1),
      startsAt: '2026-09-21T00:00:00.000Z',
      endsAt: '2026-10-05T00:00:00.000Z',
      completedAt: null,
      isActive: true,
      createdAt: '2026-09-01T00:00:00.000Z',
    },
    {
      id: uid(502),
      number: 6,
      name: 'Sprint 6',
      teamId: uid(1),
      startsAt: '2026-09-07T00:00:00.000Z',
      endsAt: '2026-09-21T00:00:00.000Z',
      completedAt: '2026-09-21T00:00:00.000Z',
      isActive: false,
      createdAt: '2026-08-15T00:00:00.000Z',
    },
  ]
  issues: FakeIssue[] = []
  comments: FakeComment[] = []
  /** Every request received: operation name, variables and headers. */
  requests: { operation: string; variables: Record<string, any>; headers: IncomingHttpHeaders }[] = []
  /** Replies served before normal handling, one per request. */
  queue: Reply[] = []
  private server?: Server
  private clock = Date.UTC(2026, 8, 1)
  url = ''

  constructor() {
    this.addIssue({
      title: 'Refunds fail for EUR cards',
      description: 'Stripe returns 402 on refunds.',
      stateId: uid(203),
      assigneeId: uid(101),
      labelIds: [uid(303), uid(302)],
      priority: 2,
      projectId: uid(401),
    })
    this.addIssue({
      title: 'Add invoice PDF export',
      description: 'Customers want PDFs.',
      stateId: uid(202),
      assigneeId: uid(102),
      labelIds: [uid(302)],
      priority: 3,
    })
    this.addIssue({
      title: 'Rotate TLS certificates',
      description: 'Before they expire.',
      teamId: uid(2),
      stateId: uid(205),
      assigneeId: null,
      labelIds: [uid(304)],
      priority: 1,
    })
    const first = this.issues[0]!
    this.addIssue({
      title: 'Reproduce refund failure',
      description: '',
      stateId: uid(204),
      assigneeId: uid(101),
      parentId: first.id,
    })
    this.comments.push(
      { id: uid(601), issueId: first.id, userId: uid(102), body: 'Seen again today.', createdAt: '2026-09-02T10:00:00.000Z' },
      { id: uid(602), issueId: first.id, userId: uid(101), body: 'Looking into it.', createdAt: '2026-09-03T10:00:00.000Z' },
    )
  }

  addIssue(p: Partial<FakeIssue> & { title: string }): FakeIssue {
    const teamId = p.teamId ?? uid(1)
    const number = this.issues.filter((i) => i.teamId === teamId).length + 1
    const at = new Date((this.clock += 60_000)).toISOString()
    const issue: FakeIssue = {
      id: p.id ?? randomUUID(),
      number,
      teamId,
      title: p.title,
      description: p.description ?? '',
      priority: p.priority ?? 0,
      stateId: p.stateId ?? this.states.find((s) => s.teamId === teamId)!.id,
      assigneeId: p.assigneeId ?? null,
      creatorId: p.creatorId ?? this.viewerId,
      labelIds: p.labelIds ?? [],
      parentId: p.parentId ?? null,
      projectId: p.projectId ?? null,
      createdAt: at,
      updatedAt: at,
    }
    this.issues.push(issue)
    return issue
  }

  // ---- views ---------------------------------------------------------------

  user = (id: string | null) => (id ? (this.users.find((u) => u.id === id) ?? null) : null)
  team = (id: string) => this.teams.find((t) => t.id === id)!
  identifier = (i: FakeIssue) => `${this.team(i.teamId).key}-${i.number}`

  /** An issue as a filterable object (relations inline, lists as arrays). */
  private flat(i: FakeIssue) {
    const state = this.states.find((s) => s.id === i.stateId)!
    return {
      ...i,
      identifier: this.identifier(i),
      team: this.team(i.teamId),
      state: { id: state.id, name: state.name, type: state.type },
      assignee: this.user(i.assigneeId),
      labels: this.labels.filter((l) => i.labelIds.includes(l.id)),
    }
  }

  /** An issue as the API returns it. */
  issueView(i: FakeIssue, commentsFirst = 50) {
    const f = this.flat(i)
    const parent = i.parentId ? this.issues.find((x) => x.id === i.parentId)! : null
    const project = i.projectId ? this.projects.find((p) => p.id === i.projectId)! : null
    return {
      ...f,
      url: `https://linear.app/acme/issue/${f.identifier}/${i.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      priorityLabel: PRIORITY_LABELS[i.priority],
      estimate: null,
      dueDate: null,
      labels: { nodes: f.labels.map((l) => ({ id: l.id, name: l.name })) },
      project: project ? { id: project.id, name: project.name } : null,
      parent: parent ? { id: parent.id, identifier: this.identifier(parent), title: parent.title } : null,
      creator: this.user(i.creatorId),
      cycle: null,
      children: {
        nodes: this.issues.filter((c) => c.parentId === i.id).map((c) => ({ ...this.flat(c), identifier: this.identifier(c) })),
      },
      // Newest first, like Linear's default ordering.
      comments: {
        nodes: this.comments
          .filter((c) => c.issueId === i.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, commentsFirst)
          .map((c) => ({
            ...c,
            url: `https://linear.app/acme/issue/${f.identifier}#comment-${c.id.slice(-4)}`,
            user: this.user(c.userId),
          })),
      },
    }
  }

  private findIssue(ref: string): FakeIssue | undefined {
    return this.issues.find((i) => i.id === ref || this.identifier(i).toLowerCase() === ref.toLowerCase())
  }

  // ---- filters and pagination ----------------------------------------------

  private matches(node: any, filter: any): boolean {
    if (filter == null) return true
    return Object.entries(filter).every(([k, f]: [string, any]) => {
      if (k === 'and') return (f as any[]).every((x) => this.matches(node, x))
      if (k === 'or') return (f as any[]).some((x) => this.matches(node, x))
      if (k === 'null') return (node == null) === f
      if (k === 'isMe') return (node?.id === this.viewerId) === f.eq
      if (k === 'some') return Array.isArray(node) && node.some((x) => this.matches(x, f))
      if (k === 'eq') return node === f
      if (k === 'eqIgnoreCase') return typeof node === 'string' && node.toLowerCase() === String(f).toLowerCase()
      if (k === 'containsIgnoreCase') return typeof node === 'string' && node.toLowerCase().includes(String(f).toLowerCase())
      if (k === 'in') return (f as unknown[]).includes(node)
      if (node == null) return this.matches(null, f)
      return this.matches(node[k], f)
    })
  }

  private page<T extends { id: string }>(all: T[], v: Record<string, any>) {
    const first = Math.min(v.first ?? 50, 250)
    const start = v.after ? all.findIndex((x) => x.id === v.after) + 1 : 0
    if (v.after && start === 0) throw gqlError('Invalid cursor', 'INVALID_INPUT')
    const nodes = all.slice(start, start + first)
    const hasNextPage = start + first < all.length
    return { nodes, pageInfo: { hasNextPage, endCursor: nodes.length ? nodes[nodes.length - 1]!.id : null } }
  }

  // ---- operations ----------------------------------------------------------

  private handle(op: string, v: Record<string, any>): unknown {
    switch (op) {
      case 'Viewer':
        return {
          viewer: { ...this.user(this.viewerId), admin: false, organization: { id: uid(900), name: 'Acme', urlKey: 'acme' } },
        }
      case 'User': {
        const u = this.user(v.id)
        if (!u) throw gqlError('Entity not found: User', 'INVALID_INPUT', 'Could not find referenced User.')
        return { user: u }
      }
      case 'Issues':
      case 'SearchIssues': {
        let all = this.issues.map((i) => this.flat(i)).filter((i) => this.matches(i, v.filter))
        if (op === 'SearchIssues') {
          const term = String(v.term).toLowerCase()
          all = all.filter((i) => `${i.title} ${i.description}`.toLowerCase().includes(term))
        }
        all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        const conn = this.page(all, v)
        const out = { ...conn, nodes: conn.nodes.map((n) => this.issueView(this.issues.find((i) => i.id === n.id)!)) }
        return op === 'Issues' ? { issues: out } : { searchIssues: { ...out, totalCount: all.length } }
      }
      case 'Issue':
      case 'IssueRef':
      case 'IssueIdentifier': {
        const i = this.findIssue(v.id)
        if (!i) throw gqlError('Entity not found: Issue', 'INVALID_INPUT', 'Could not find referenced Issue.')
        return { issue: this.issueView(i, v.comments ?? 50) }
      }
      case 'Teams':
        return { teams: this.page(this.teams, v) }
      case 'TeamByKey':
        return {
          teams: this.page(
            this.teams.filter((t) => this.matches(t, v.filter)),
            v,
          ),
        }
      case 'StatesForTeam':
      case 'WorkflowStates': {
        const all = this.states.map((s) => ({ ...s, team: this.team(s.teamId) })).filter((s) => this.matches(s, v.filter))
        return { workflowStates: this.page(all, v) }
      }
      case 'Users':
      case 'UserByRef':
        return {
          users: this.page(
            this.users.filter((u) => this.matches(u, v.filter)),
            v,
          ),
        }
      case 'Labels':
      case 'LabelsByName': {
        const all = this.labels
          .map((l) => ({ ...l, team: l.teamId ? this.team(l.teamId) : null, parent: null }))
          .filter((l) => this.matches(l, v.filter))
        return { issueLabels: this.page(all, v) }
      }
      case 'Projects':
      case 'ProjectByName': {
        const all = this.projects
          .map((p) => ({
            ...p,
            url: `https://linear.app/acme/project/${p.id.slice(-4)}`,
            lead: this.user(p.leadId),
            accessibleTeams: p.teamIds.map((id) => this.team(id)),
          }))
          .filter((p) => this.matches(p, v.filter))
        return { projects: this.page(all, v) }
      }
      case 'Cycles': {
        const all = this.cycles
          .map((c) => ({ ...c, team: this.team(c.teamId) }))
          .filter((c) => this.matches(c, v.filter))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        return { cycles: this.page(all, v) }
      }
      case 'IssueCreate': {
        const input = v.input
        if (!this.teams.some((t) => t.id === input.teamId))
          throw gqlError('Argument Validation Error', 'INVALID_INPUT', 'teamId must be a UUID.')
        const i = this.addIssue({ ...input, labelIds: input.labelIds ?? [], creatorId: this.viewerId })
        return { issueCreate: { success: true, issue: this.issueView(i) } }
      }
      case 'IssueUpdate': {
        const i = this.findIssue(v.id)
        if (!i) throw gqlError('Entity not found: Issue', 'INVALID_INPUT', 'Could not find referenced Issue.')
        Object.assign(i, v.input, { updatedAt: new Date((this.clock += 60_000)).toISOString() })
        return { issueUpdate: { success: true, issue: this.issueView(i) } }
      }
      case 'CommentCreate': {
        const i = this.issues.find((x) => x.id === v.input.issueId)
        if (!i) throw gqlError('Entity not found: Issue', 'INVALID_INPUT', 'Could not find referenced Issue.')
        const c: FakeComment = {
          id: randomUUID(),
          issueId: i.id,
          userId: this.viewerId,
          body: v.input.body,
          createdAt: new Date((this.clock += 60_000)).toISOString(),
        }
        this.comments.push(c)
        return {
          commentCreate: {
            success: true,
            comment: {
              ...c,
              url: `https://linear.app/acme/issue/${this.identifier(i)}#comment-x`,
              issue: { identifier: this.identifier(i) },
            },
          },
        }
      }
      default:
        throw gqlError(`Unknown operation ${op}`, 'GRAPHQL_VALIDATION_FAILED')
    }
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const send = (r: Reply) => {
          res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers })
          res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
        }
        let parsed: { query: string; variables?: Record<string, any> }
        try {
          parsed = JSON.parse(raw)
        } catch {
          return send({ status: 400, body: { errors: [{ message: 'Invalid JSON' }] } })
        }
        const operation = /\b(?:query|mutation)\s+(\w+)/.exec(parsed.query)?.[1] ?? 'anonymous'
        const variables = parsed.variables ?? {}
        this.requests.push({ operation, variables, headers: req.headers })
        const queued = this.queue.shift()
        if (queued) return send(queued)
        if (req.method !== 'POST' || req.url !== '/graphql')
          return send({ status: 404, body: { errors: [{ message: 'Not found' }] } })
        if (req.headers.authorization !== this.apiKey)
          return send({
            status: 400,
            body: {
              errors: [
                {
                  message: 'Authentication required, not authenticated',
                  extensions: {
                    code: 'AUTHENTICATION_ERROR',
                    type: 'authentication error',
                    userPresentableMessage: 'You need to authenticate to access this operation.',
                  },
                },
              ],
            },
          })
        try {
          send({ status: 200, body: { data: this.handle(operation, variables) } })
        } catch (e) {
          if (e instanceof GqlFailure) return send({ status: 200, body: { data: null, errors: [e.error] } })
          send({ status: 500, body: { errors: [{ message: String(e) }] } })
        }
      })
    })
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/graphql`
    return this.url
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
  }
}

class GqlFailure extends Error {
  constructor(readonly error: Record<string, unknown>) {
    super(String(error.message))
  }
}

function gqlError(message: string, code: string, userPresentableMessage?: string): GqlFailure {
  return new GqlFailure({
    message,
    extensions: {
      code,
      type: code.toLowerCase().replace(/_/g, ' '),
      ...(userPresentableMessage ? { userPresentableMessage, userError: true } : {}),
    },
  })
}

/** Linear's rate-limit reply: HTTP 400 with a RATELIMITED error and the reset time in epoch ms. */
export function rateLimited(resetAt: number): Reply {
  return {
    status: 400,
    headers: { 'x-ratelimit-requests-remaining': '0', 'x-ratelimit-requests-reset': String(resetAt) },
    body: {
      errors: [
        {
          message: 'Rate limit exceeded',
          extensions: { code: 'RATELIMITED', type: 'ratelimited', userPresentableMessage: 'Too many requests.' },
        },
      ],
    },
  }
}
