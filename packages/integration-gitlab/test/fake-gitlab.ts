import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A local fake of the GitLab REST v4 API: the endpoints the integration uses,
 * with payload shapes, pagination headers and errors as documented at
 * docs.gitlab.com/api. Mounted at `<prefix>/api/v4`, so self-hosted instances
 * under a sub-path can be tested too.
 */

export const TOKEN = 'glpat-test-token'

export interface RecordedRequest {
  method: string
  /** Decoded path below `/api/v4`. */
  path: string
  /** Raw path below `/api/v4`, as sent (still URL-encoded). */
  rawPath: string
  query: URLSearchParams
  body: any
  headers: IncomingMessage['headers']
}

export interface Injected {
  status: number
  headers?: Record<string, string>
  body?: string
}

const user = (id: number, username: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  username,
  name,
  state: 'active',
  avatar_url: `https://gitlab.example.com/uploads/${username}.png`,
  web_url: `https://gitlab.example.com/${username}`,
  ...extra,
})

export function seed() {
  const users: any[] = [
    user(7, 'billing-bot', 'Billing Bot (AI)', { bot: true, public_email: '' }),
    user(11, 'ana', 'Ana Example', { public_email: 'ana@example.com' }),
    user(12, 'marko', 'Marko Example', { public_email: '' }),
  ]
  const project = {
    id: 42,
    name: 'billing',
    path: 'billing',
    path_with_namespace: 'acme/platform/billing',
    description: 'Billing service',
    default_branch: 'main',
    visibility: 'private',
    web_url: 'https://gitlab.example.com/acme/platform/billing',
    ssh_url_to_repo: 'git@gitlab.example.com:acme/platform/billing.git',
    http_url_to_repo: 'https://gitlab.example.com/acme/platform/billing.git',
    archived: false,
    last_activity_at: '2026-09-28T10:00:00.000Z',
    namespace: { id: 3, name: 'platform', path: 'platform', full_path: 'acme/platform' },
  }
  const commitOf = (i: number) => ({
    id: `${String(i).padStart(4, '0')}abcdef0123456789abcdef0123456789abcd`,
    short_id: `${String(i).padStart(4, '0')}abcd`,
    title: `Commit ${i}`,
    message: `Commit ${i}\n\nBody`,
    author_name: 'Ana Example',
    author_email: 'ana@example.com',
    committed_date: '2026-09-28T09:00:00.000+00:00',
    created_at: '2026-09-28T09:00:00.000+00:00',
  })
  const branches = [
    { name: 'main', default: true, protected: true, merged: false, developers_can_push: false, commit: commitOf(1) },
    { name: 'mp/billing-bot/fix-rounding', default: false, protected: false, merged: false, commit: commitOf(2) },
    ...Array.from({ length: 128 }, (_, i) => ({
      name: `feature/f-${String(i).padStart(3, '0')}`,
      default: false,
      protected: false,
      merged: i % 2 === 0,
      commit: commitOf(10 + i),
    })),
  ]
  const files: Record<string, Record<string, string>> = {
    main: {
      'README.md': '# Billing\n\nThe billing service.\n',
      'src/app.ts': `export const round = (n: number) => Math.round(n * 100) / 100\n${'// filler\n'.repeat(20_000)}`,
      'assets/logo.png': '\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR',
    },
    'mp/billing-bot/fix-rounding': { 'README.md': '# Billing (branch)\n' },
  }
  const tree = [
    { id: 'a1', name: 'src', type: 'tree', path: 'src', mode: '040000' },
    { id: 'a2', name: 'README.md', type: 'blob', path: 'README.md', mode: '100644' },
    { id: 'a3', name: 'app.ts', type: 'blob', path: 'src/app.ts', mode: '100644' },
    { id: 'a4', name: 'assets', type: 'tree', path: 'assets', mode: '040000' },
    { id: 'a5', name: 'logo.png', type: 'blob', path: 'assets/logo.png', mode: '100644' },
  ]
  const mrs: any[] = [
    {
      id: 1012,
      iid: 12,
      project_id: 42,
      title: 'Fix rounding in invoices',
      description: 'Rounds to cents.',
      state: 'opened',
      draft: false,
      work_in_progress: false,
      source_branch: 'mp/billing-bot/fix-rounding',
      target_branch: 'main',
      author: users[0],
      assignees: [users[0]],
      reviewers: [users[1]],
      labels: ['bug'],
      detailed_merge_status: 'ci_must_pass',
      merge_status: 'can_be_merged',
      has_conflicts: false,
      changes_count: '2',
      web_url: 'https://gitlab.example.com/acme/platform/billing/-/merge_requests/12',
      created_at: '2026-09-27T10:00:00.000Z',
      updated_at: '2026-09-28T10:00:00.000Z',
      head_pipeline: { id: 900, status: 'failed', web_url: 'https://gitlab.example.com/acme/platform/billing/-/pipelines/900' },
      sha: 'feedface',
    },
    {
      id: 1011,
      iid: 11,
      project_id: 42,
      title: 'Old change',
      description: '',
      state: 'merged',
      draft: false,
      source_branch: 'feature/f-001',
      target_branch: 'main',
      author: users[1],
      assignees: [],
      reviewers: [],
      labels: [],
      web_url: 'https://gitlab.example.com/acme/platform/billing/-/merge_requests/11',
      created_at: '2026-09-20T10:00:00.000Z',
      updated_at: '2026-09-21T10:00:00.000Z',
    },
  ]
  const diffs: Record<number, any[]> = {
    12: [
      {
        old_path: 'src/app.ts',
        new_path: 'src/app.ts',
        a_mode: '100644',
        b_mode: '100644',
        new_file: false,
        renamed_file: false,
        deleted_file: false,
        diff: '@@ -1,1 +1,2 @@\n-export const round = (n) => n\n+export const round = (n: number) =>\n+  Math.round(n * 100) / 100\n',
      },
      {
        old_path: 'docs/rounding.md',
        new_path: 'docs/rounding.md',
        new_file: true,
        renamed_file: false,
        deleted_file: false,
        diff: `@@ -0,0 +1,3000 @@\n${'+a line of documentation\n'.repeat(3000)}`,
      },
      { old_path: 'old.txt', new_path: 'new.txt', new_file: false, renamed_file: true, deleted_file: false, diff: '' },
    ],
  }
  const note = (id: number, author: any, body: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: null,
    body,
    author,
    created_at: '2026-09-28T11:00:00.000Z',
    system: false,
    resolvable: false,
    ...extra,
  })
  const discussions: Record<string, any[]> = {
    'mr:12': [
      {
        id: 'd1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0',
        individual_note: false,
        notes: [
          note(501, users[1], 'Please handle negative amounts.', {
            type: 'DiffNote',
            resolvable: true,
            resolved: false,
            position: { new_path: 'src/app.ts', new_line: 2, old_path: 'src/app.ts', old_line: null },
          }),
        ],
      },
      {
        id: 'e1',
        individual_note: false,
        notes: [
          note(502, users[1], 'Typo here.', { type: 'DiffNote', resolvable: true, resolved: true }),
          note(503, users[0], 'Fixed.', { type: 'DiffNote', resolvable: true, resolved: true }),
        ],
      },
      { id: 'f1', individual_note: true, notes: [note(504, users[2], 'Looks good overall.')] },
    ],
  }
  const pipelines: any[] = [
    {
      id: 900,
      iid: 90,
      project_id: 42,
      status: 'failed',
      ref: 'refs/merge-requests/12/head',
      sha: 'feedfacefeedfacefeedfacefeedfacefeedface',
      source: 'merge_request_event',
      web_url: 'https://gitlab.example.com/acme/platform/billing/-/pipelines/900',
      created_at: '2026-09-28T10:00:00.000Z',
      updated_at: '2026-09-28T10:05:00.000Z',
      duration: 300,
      mr: 12,
    },
    {
      id: 899,
      iid: 89,
      project_id: 42,
      status: 'success',
      ref: 'refs/merge-requests/12/head',
      sha: 'beefbeef',
      source: 'merge_request_event',
      web_url: 'https://gitlab.example.com/acme/platform/billing/-/pipelines/899',
      created_at: '2026-09-27T10:00:00.000Z',
      updated_at: '2026-09-27T10:05:00.000Z',
      mr: 12,
    },
    {
      id: 901,
      iid: 91,
      project_id: 42,
      status: 'success',
      ref: 'main',
      sha: 'cafecafecafe',
      source: 'push',
      web_url: 'https://gitlab.example.com/acme/platform/billing/-/pipelines/901',
      created_at: '2026-09-28T12:00:00.000Z',
      updated_at: '2026-09-28T12:03:00.000Z',
    },
  ]
  const job = (id: number, name: string, stage: string, status: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    stage,
    status,
    allow_failure: false,
    duration: 12.5,
    failure_reason: status === 'failed' ? 'script_failure' : undefined,
    web_url: `https://gitlab.example.com/acme/platform/billing/-/jobs/${id}`,
    ...extra,
  })
  const jobs: Record<number, any[]> = {
    900: [
      job(5000, 'build', 'build', 'success'),
      job(5001, 'test', 'test', 'failed'),
      job(5002, 'lint', 'test', 'failed', { allow_failure: true }),
    ],
    901: [job(5100, 'build', 'build', 'success')],
  }
  const traces: Record<number, string> = {
    5001: `\u001b[0KRunning with gitlab-runner 17.0.0\u001b[0;m\nsection_start:1727517600:step_script\r\u001b[0K\u001b[32;1m$ npm test\u001b[0;m\n${'ok test\n'.repeat(10_000)}\u001b[31;1mFAIL src/app.test.ts\u001b[0;m\nExpected 0.1 got 0.10000001\nsection_end:1727517700:step_script\r\u001b[0K\nERROR: Job failed: exit code 1\n`,
  }
  const issues: any[] = [
    {
      id: 3003,
      iid: 3,
      project_id: 42,
      title: 'Invoices round wrong',
      description: 'Amounts like 0.105 round down.',
      state: 'opened',
      author: users[1],
      assignees: [users[0]],
      labels: ['bug'],
      milestone: { id: 1, title: 'Q4' },
      confidential: false,
      web_url: 'https://gitlab.example.com/acme/platform/billing/-/issues/3',
      created_at: '2026-09-26T10:00:00.000Z',
      updated_at: '2026-09-28T10:00:00.000Z',
    },
  ]
  const notes: Record<string, any[]> = {
    'issue:3': [
      note(601, users[1], 'Seen on invoice 1234.', { created_at: '2026-09-26T11:00:00.000Z' }),
      note(602, users[0], 'changed the description', { system: true, created_at: '2026-09-26T12:00:00.000Z' }),
      note(603, users[0], 'Working on it in !12.', { created_at: '2026-09-27T12:00:00.000Z' }),
    ],
    'mr:12': [],
  }
  /** Accepted tokens and their role; managing hooks needs `maintainer`. */
  const tokens: Record<string, 'developer' | 'maintainer'> = { [TOKEN]: 'maintainer' }
  /** Project hooks, with the token GitLab keeps (and never returns). */
  const hooks: { id: number; project_id: number; token: string; [field: string]: unknown }[] = []
  return {
    users,
    project,
    otherProjects: [] as (typeof project)[],
    tokens,
    hooks,
    branches,
    files,
    tree,
    mrs,
    diffs,
    discussions,
    pipelines,
    jobs,
    traces,
    issues,
    notes,
    nextId: 10_000,
  }
}

export type FakeState = ReturnType<typeof seed>

export interface FakeGitlab {
  url: string
  /** The base URL to give the integration (`url` plus the prefix). */
  baseUrl: string
  state: FakeState
  requests: RecordedRequest[]
  /** Responds to the next requests with these, in order, before normal handling. */
  inject(...responses: Injected[]): void
  close(): Promise<void>
}

export async function startFakeGitlab(opts: { prefix?: string } = {}): Promise<FakeGitlab> {
  const prefix = (opts.prefix ?? '').replace(/\/+$/, '')
  const state = seed()
  const requests: RecordedRequest[] = []
  const injected: Injected[] = []

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url ?? '/', 'http://fake')
    const apiBase = `${prefix}/api/v4`
    if (!url.pathname.startsWith(`${apiBase}/`)) return send(res, 404, { message: '404 Not Found' })
    const rawPath = url.pathname.slice(apiBase.length)
    const segments = rawPath.split('/').slice(1).map(decodeURIComponent)
    let body: any = null
    if (raw) {
      try {
        body = JSON.parse(raw)
      } catch {
        return send(res, 400, { message: 'bad JSON' })
      }
    }
    requests.push({
      method: req.method ?? 'GET',
      path: `/${segments.join('/')}`,
      rawPath,
      query: url.searchParams,
      body,
      headers: req.headers,
    })
    const inj = injected.shift()
    if (inj) {
      res.writeHead(inj.status, { 'content-type': 'application/json', ...inj.headers })
      return res.end(inj.body ?? JSON.stringify({ message: `${inj.status} injected` }))
    }
    const token = String(req.headers['private-token'] ?? '')
    if (!state.tokens[token]) return send(res, 401, { message: '401 Unauthorized' })
    try {
      route(state, req.method ?? 'GET', segments, url.searchParams, body, res, token)
    } catch (e) {
      send(res, 500, { message: String(e) })
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  return {
    url: base,
    baseUrl: `${base}${prefix}`,
    state,
    requests,
    inject: (...r) => void injected.push(...r),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

function send(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(value))
}

function sendText(res: ServerResponse, text: string) {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(text)
}

/** GitLab's offset pagination: `page`, `per_page` (default 20, max 100) and the X-* headers. */
function paged(res: ServerResponse, q: URLSearchParams, items: any[]) {
  const perPage = Math.min(100, Number(q.get('per_page') ?? 20))
  const page = Math.max(1, Number(q.get('page') ?? 1))
  const slice = items.slice((page - 1) * perPage, page * perPage)
  const totalPages = Math.max(1, Math.ceil(items.length / perPage))
  send(res, 200, slice, {
    'x-page': String(page),
    'x-per-page': String(perPage),
    'x-total': String(items.length),
    'x-total-pages': String(totalPages),
    'x-next-page': page < totalPages ? String(page + 1) : '',
    'x-prev-page': page > 1 ? String(page - 1) : '',
  })
}

const notFound = (res: ServerResponse, what = '404 Not found') => send(res, 404, { message: what })

/** The hook fields GitLab returns (everything but the token). */
const HOOK_FLAGS = [
  'push_events',
  'tag_push_events',
  'note_events',
  'confidential_note_events',
  'issues_events',
  'confidential_issues_events',
  'merge_requests_events',
  'job_events',
  'pipeline_events',
  'wiki_page_events',
  'deployment_events',
  'releases_events',
]
const publicHook = ({ token: _, ...h }: { token: string; [k: string]: unknown }) => h

function hooksRoute(
  s: FakeState,
  p: { id: number },
  method: string,
  id: string | undefined,
  q: URLSearchParams,
  body: any,
  res: ServerResponse,
) {
  const mine = s.hooks.filter((h) => h.project_id === p.id)
  if (!id) {
    if (method === 'GET') return paged(res, q, mine.map(publicHook))
    if (method === 'POST') {
      if (!body?.url) return send(res, 400, { error: 'url is missing' })
      const hook: FakeState['hooks'][number] = {
        id: s.nextId++,
        url: body.url,
        project_id: p.id,
        created_at: '2026-09-29T10:00:00.000Z',
        push_events: body.push_events ?? true,
        push_events_branch_filter: body.push_events_branch_filter ?? '',
        enable_ssl_verification: body.enable_ssl_verification ?? true,
        token: body.token ?? '',
      }
      for (const f of HOOK_FLAGS) if (f !== 'push_events') hook[f] = !!body[f]
      s.hooks.push(hook)
      return send(res, 201, publicHook(hook))
    }
  }
  const hook = mine.find((h) => String(h.id) === id)
  if (!hook) return notFound(res, '404 Hook Not Found')
  if (method === 'GET') return send(res, 200, publicHook(hook))
  if (method === 'PUT') {
    if (!body?.url) return send(res, 400, { error: 'url is missing' })
    for (const [k, v] of Object.entries(body)) if (k !== 'id' && k !== 'project_id') hook[k] = v
    return send(res, 200, publicHook(hook))
  }
  if (method === 'DELETE') {
    s.hooks.splice(s.hooks.indexOf(hook), 1)
    res.writeHead(204)
    return res.end()
  }
  return notFound(res)
}

function route(s: FakeState, method: string, seg: string[], q: URLSearchParams, body: any, res: ServerResponse, token = TOKEN) {
  const [a, b, c, d, e, f, g] = seg
  if (method === 'GET' && a === 'user' && seg.length === 1) return send(res, 200, { ...s.users[0], email: 'bot@example.com' })
  if (method === 'GET' && a === 'users' && seg.length === 1) {
    const u = q.get('username')
    return send(
      res,
      200,
      s.users.filter((x) => !u || x.username.toLowerCase() === u.toLowerCase()).map(({ public_email: _, ...x }) => x),
    )
  }
  if (method === 'GET' && a === 'users' && b) {
    const u = s.users.find((x) => String(x.id) === b)
    return u ? send(res, 200, u) : notFound(res, '404 User Not Found')
  }
  if (a !== 'projects' || !b) return notFound(res)
  const p = [s.project, ...s.otherProjects].find((x) => b === String(x.id) || b === x.path_with_namespace)
  if (!p) return notFound(res, '404 Project Not Found')
  if (method === 'GET' && !c) return send(res, 200, p)
  if (c === 'hooks') {
    if (s.tokens[token] !== 'maintainer') return send(res, 403, { message: '403 Forbidden' })
    return hooksRoute(s, p, method, d, q, body, res)
  }

  if (c === 'repository') {
    if (method === 'GET' && d === 'branches') {
      const search = q.get('search')
      return paged(
        res,
        q,
        s.branches.filter((x) => !search || x.name.includes(search)),
      )
    }
    if (method === 'GET' && d === 'files' && e && f === 'raw') {
      const ref = q.get('ref') ?? p.default_branch
      const content = s.files[ref]?.[e]
      return content === undefined ? notFound(res, '404 File Not Found') : sendText(res, content)
    }
    if (method === 'GET' && d === 'tree') {
      const path = (q.get('path') ?? '').replace(/\/+$/, '')
      const recursive = q.get('recursive') === 'true'
      const items = s.tree.filter((t) => {
        const parent = t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/')) : ''
        return recursive ? !path || t.path.startsWith(`${path}/`) : parent === path
      })
      return paged(res, q, items)
    }
  }

  if (c === 'merge_requests') {
    if (!d) {
      if (method === 'GET') {
        const state = q.get('state') ?? 'all'
        const author = q.get('author_username')
        const source = q.get('source_branch')
        return paged(
          res,
          q,
          s.mrs.filter(
            (m) =>
              (state === 'all' || m.state === state) &&
              (!author || m.author.username === author) &&
              (!source || m.source_branch === source),
          ),
        )
      }
      if (method === 'POST') {
        if (!body?.source_branch || !body?.target_branch || !body?.title)
          return send(res, 400, { message: 'source_branch, target_branch, title are missing' })
        if (!s.branches.some((x) => x.name === body.source_branch))
          return send(res, 400, { message: ['Source branch does not exist'] })
        if (
          s.mrs.some(
            (m) => m.state === 'opened' && m.source_branch === body.source_branch && m.target_branch === body.target_branch,
          )
        )
          return send(res, 409, { message: ['Another open merge request already exists for this source branch: !12'] })
        const iid = Math.max(...s.mrs.map((m) => m.iid)) + 1
        const byId = (ids: number[] | undefined) => (ids ?? []).map((id) => s.users.find((u) => u.id === id)).filter(Boolean)
        const mr = {
          id: s.nextId++,
          iid,
          project_id: p.id,
          title: body.title,
          description: body.description ?? null,
          state: 'opened',
          draft: /^draft:/i.test(body.title),
          work_in_progress: /^draft:/i.test(body.title),
          source_branch: body.source_branch,
          target_branch: body.target_branch,
          author: s.users[0],
          assignees: byId(body.assignee_ids),
          reviewers: byId(body.reviewer_ids),
          labels: body.labels ? String(body.labels).split(',') : [],
          detailed_merge_status: 'checking',
          web_url: `${p.web_url}/-/merge_requests/${iid}`,
          created_at: '2026-09-29T10:00:00.000Z',
          updated_at: '2026-09-29T10:00:00.000Z',
        }
        s.mrs.unshift(mr)
        return send(res, 201, mr)
      }
    }
    const mr = s.mrs.find((m) => String(m.iid) === d)
    if (!mr) return notFound(res)
    if (!e) {
      if (method === 'GET') return send(res, 200, mr)
      if (method === 'PUT') {
        if (body.title !== undefined) {
          mr.title = body.title
          mr.draft = /^draft:/i.test(body.title)
        }
        if (body.description !== undefined) mr.description = body.description
        if (body.labels !== undefined) mr.labels = String(body.labels).split(',').filter(Boolean)
        if (body.add_labels) mr.labels = [...new Set([...mr.labels, ...String(body.add_labels).split(',')])]
        if (body.remove_labels) mr.labels = mr.labels.filter((l: string) => !String(body.remove_labels).split(',').includes(l))
        if (body.state_event === 'merge' || body.merge_when_pipeline_succeeds) mr.state = 'merged'
        return send(res, 200, mr)
      }
    }
    if (method === 'PUT' && e === 'merge') {
      mr.state = 'merged'
      return send(res, 200, mr)
    }
    if (method === 'POST' && e === 'approve') return send(res, 201, { approved: true })
    if (method === 'GET' && e === 'diffs') return paged(res, q, s.diffs[mr.iid] ?? [])
    if (method === 'GET' && e === 'discussions') return paged(res, q, s.discussions[`mr:${mr.iid}`] ?? [])
    if (method === 'POST' && e === 'notes') {
      const n = {
        id: s.nextId++,
        body: body.body,
        author: s.users[0],
        created_at: '2026-09-29T10:00:00.000Z',
        system: false,
        noteable_type: 'MergeRequest',
      }
      ;(s.notes[`mr:${mr.iid}`] ??= []).push(n)
      return send(res, 201, n)
    }
    if (method === 'POST' && e === 'discussions' && f && g === 'notes') {
      const disc = (s.discussions[`mr:${mr.iid}`] ?? []).find((x) => x.id === f)
      if (!disc) return notFound(res, '404 Discussion Not Found')
      const n = { id: s.nextId++, body: body.body, author: s.users[0], created_at: '2026-09-29T10:00:00.000Z', system: false }
      disc.notes.push(n)
      return send(res, 201, n)
    }
    if (method === 'GET' && e === 'pipelines') {
      const list = s.pipelines.filter((x) => x.mr === mr.iid).sort((x, y) => y.id - x.id)
      return paged(
        res,
        q,
        list.map(({ mr: _, duration: __, ...x }) => x),
      )
    }
    return notFound(res)
  }

  if (c === 'pipelines') {
    if (method === 'GET' && !d) {
      const ref = q.get('ref')
      return paged(
        res,
        q,
        s.pipelines.filter((x) => !ref || x.ref === ref).sort((x, y) => y.id - x.id),
      )
    }
    const pl = s.pipelines.find((x) => String(x.id) === d)
    if (!pl) return notFound(res)
    if (method === 'GET' && !e) return send(res, 200, pl)
    if (method === 'GET' && e === 'jobs') return paged(res, q, s.jobs[pl.id] ?? [])
  }

  if (c === 'jobs' && d && e === 'trace' && method === 'GET') {
    const t = s.traces[Number(d)]
    return t === undefined ? notFound(res) : sendText(res, t)
  }

  if (c === 'issues') {
    if (!d && method === 'POST') {
      if (!body?.title) return send(res, 400, { message: 'title is missing' })
      const iid = Math.max(...s.issues.map((i) => i.iid)) + 1
      const i = {
        id: s.nextId++,
        iid,
        project_id: p.id,
        title: body.title,
        description: body.description ?? null,
        state: 'opened',
        author: s.users[0],
        assignees: (body.assignee_ids ?? []).map((id: number) => s.users.find((u) => u.id === id)).filter(Boolean),
        labels: body.labels ? String(body.labels).split(',') : [],
        confidential: !!body.confidential,
        web_url: `${p.web_url}/-/issues/${iid}`,
        created_at: '2026-09-29T10:00:00.000Z',
        updated_at: '2026-09-29T10:00:00.000Z',
      }
      s.issues.push(i)
      return send(res, 201, i)
    }
    const i = s.issues.find((x) => String(x.iid) === d)
    if (!i) return notFound(res)
    if (method === 'GET' && !e) return send(res, 200, i)
    if (e === 'notes') {
      const list = (s.notes[`issue:${i.iid}`] ??= [])
      if (method === 'GET') {
        const sorted = [...list].sort((x, y) => (q.get('sort') === 'asc' ? 1 : -1) * x.created_at.localeCompare(y.created_at))
        return paged(res, q, sorted)
      }
      if (method === 'POST') {
        const n = { id: s.nextId++, body: body.body, author: s.users[0], created_at: '2026-09-29T10:00:00.000Z', system: false }
        list.push(n)
        return send(res, 201, n)
      }
    }
    if (method === 'POST' && e === 'discussions' && f && g === 'notes') {
      const n = { id: s.nextId++, body: body.body, author: s.users[0], created_at: '2026-09-29T10:00:00.000Z', system: false }
      return send(res, 201, n)
    }
  }
  return notFound(res)
}
