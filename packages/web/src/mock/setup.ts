import {
  type ApiRecord,
  ApiRequestError,
  type ChannelData,
  type ContactData,
  type EmployeeData,
  type EmployeeIntegrations,
  type IntegrationSetupStatus,
  type IntegrationsOverview,
  type Json,
  type ProjectData,
  type SetupApi,
  type SetupResult,
  type SetupStep,
  type SshKeyInfo,
  type TriggerData,
} from '@mp/api'
import { EMP, type MockDb, mockId } from './data.ts'
import { mockRepoKey } from './projects.ts'

/** What the setup mock borrows from the mock API. */
export interface MockSetupHelpers {
  db: MockDb
  iso(): string
  delay<T>(v: T): Promise<T>
  write<T extends Record<string, unknown>>(kind: string, id: string, data: T): ApiRecord<T>
  get<T>(kind: string, id: string): ApiRecord<T> | undefined
  all<T>(kind: string): ApiRecord<T>[]
}

const MOCK_PUBLIC_URL = 'https://mp.example.com'

/** What the demo GitLab account can reach. payments-api is the Payments project's repository already. */
const GITLAB_PROJECTS = [
  {
    id: 1,
    path: 'acme/payments-api',
    name: 'payments-api',
    description: 'The payments API.',
    web: 'https://git.example.com/acme/payments-api',
    http: 'https://git.example.com/acme/payments-api.git',
    ssh: 'git@git.example.com:acme/payments-api.git',
  },
  {
    id: 2,
    path: 'acme/invoices',
    name: 'Invoices service',
    description: 'Invoice PDFs and the monthly run.',
    web: 'https://git.example.com/acme/invoices',
    http: 'https://git.example.com/acme/invoices.git',
    ssh: 'git@git.example.com:acme/invoices.git',
  },
  {
    id: 3,
    path: 'acme/infra',
    name: 'infra',
    description: 'Clusters and deploy tooling.',
    web: 'https://git.example.com/acme/infra',
    http: 'https://git.example.com/acme/infra.git',
    ssh: 'git@git.example.com:acme/infra.git',
  },
] as const
const SCOPES = 'app_mentions:read, channels:history, channels:read, chat:write, im:history, reactions:write, users:read'

/** A fake, stable public key per employee (never a real key). */
function fakeKey(seed: string, n: number) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let h = 2166136261 ^ n
  let body = ''
  for (let i = 0; i < 43; i++) {
    h = Math.imul(h ^ (seed.charCodeAt(i % seed.length) + i), 16777619)
    body += alphabet[(h >>> 0) % 64]
  }
  return {
    publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${body} ${seed}@meatless-proxy`,
    fingerprint: `SHA256:${body.split('').reverse().join('')}`,
  }
}

type Stage = Record<string, Record<string, SetupStep['status']>>

/**
 * Setup state per employee: the demo employee has Slack connected, GitLab needing attention
 * (a token that expires soon, its SSH key not added, Maintainer on one project) and Linear
 * not set up.
 */
const INITIAL: Record<string, Stage> = {
  [EMP.billing]: {
    slack: { app: 'done', tokens: 'done', events: 'done', channels: 'done', routing: 'done' },
    gitlab: {
      instance: 'done',
      account: 'done',
      token: 'warning',
      'ssh-key': 'todo',
      projects: 'warning',
      webhooks: 'done',
      routing: 'todo',
    },
    linear: { 'api-key': 'todo', webhook: 'todo', routing: 'todo' },
  },
  [EMP.infra]: {
    slack: { app: 'done', tokens: 'done', events: 'todo', channels: 'todo', routing: 'todo' },
    gitlab: {
      instance: 'done',
      account: 'done',
      token: 'done',
      'ssh-key': 'done',
      projects: 'done',
      webhooks: 'done',
      routing: 'done',
    },
    linear: { 'api-key': 'done', webhook: 'todo', routing: 'todo' },
  },
}

const blank = (): Stage => ({
  slack: { app: 'todo', tokens: 'todo', events: 'todo', channels: 'todo', routing: 'todo' },
  gitlab: {
    instance: 'done',
    account: 'todo',
    token: 'todo',
    'ssh-key': 'todo',
    projects: 'todo',
    webhooks: 'todo',
    routing: 'todo',
  },
  linear: { 'api-key': 'todo', webhook: 'todo', routing: 'todo' },
})

const TOKEN_OF: Record<string, string> = { slack: 'tokens', gitlab: 'token', linear: 'api-key' }
const LABEL: Record<string, string> = { slack: 'Slack', gitlab: 'GitLab', linear: 'Linear' }
const SECRETS: Record<string, { name: string; label: string; placeholder: string }[]> = {
  slack: [
    { name: 'SLACK_BOT_TOKEN', label: 'Bot User OAuth Token', placeholder: 'xoxb-…' },
    { name: 'SLACK_SIGNING_SECRET', label: 'Signing Secret', placeholder: '32 hex characters' },
  ],
  gitlab: [
    { name: 'GITLAB_TOKEN', label: 'Personal access token (api scope)', placeholder: 'glpat-…' },
    { name: 'GITLAB_BASE_URL', label: 'Instance URL (self-hosted only)', placeholder: 'https://gitlab.com' },
  ],
  linear: [
    { name: 'LINEAR_API_KEY', label: 'Personal API key', placeholder: 'lin_api_…' },
    { name: 'LINEAR_WEBHOOK_SECRET', label: 'Webhook signing secret', placeholder: 'lin_wh_…' },
  ],
}

const s = (id: string, title: string, status: SetupStep['status'], detail: string, data?: Record<string, Json>): SetupStep => ({
  id,
  title,
  status,
  detail,
  ...(data ? { data } : {}),
})

/** The setup API over the mock database (see packages/api/src/setup.ts). */
export function createMockSetupApi(h: MockSetupHelpers): SetupApi {
  const stages = new Map<string, Stage>()
  const keys = new Map<string, SshKeyInfo>()
  let rotations = 0
  const stageOf = (id: string) => {
    let st = stages.get(id)
    if (!st) {
      st = structuredClone(INITIAL[id] ?? blank())
      stages.set(id, st)
    }
    return st
  }
  const employee = (id: string) => {
    const e = h.get<EmployeeData>('employee', id)
    if (!e) throw new ApiRequestError(404, 'not_found', `employee ${id} not found`)
    return e
  }
  const handleOf = (e: ApiRecord<EmployeeData>) => e.key ?? e.data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const keyOf = (id: string): SshKeyInfo => {
    let k = keys.get(id)
    if (!k) {
      const e = employee(id)
      const { publicKey, fingerprint } = fakeKey(handleOf(e), 0)
      k = { publicKey, fingerprint, createdAt: e.createdAt }
      keys.set(id, k)
    }
    return k
  }
  const hookUrl = (name: string, id: string) => `${MOCK_PUBLIC_URL}/webhooks/${name}/${id}`

  /** The harness project with a repository of this GitLab project, and whether the employee is on it. */
  const addedOf = (employeeId: string, g: (typeof GITLAB_PROJECTS)[number]) => {
    const keys = new Set([g.ssh, g.http].map(mockRepoKey))
    const p = h
      .all<ProjectData>('project')
      .find((x) =>
        (x.data.repositories ?? []).some((r) => keys.has(mockRepoKey(r.url)) || (r.httpUrl && keys.has(mockRepoKey(r.httpUrl)))),
      )
    if (!p) return null
    const contactId = h.get<EmployeeData>('employee', employeeId)?.data.contactId
    return { projectId: p.id, name: p.data.name, linked: h.db.links.some((l) => l.from.id === contactId && l.to.id === p.id) }
  }
  /** The GitLab projects the demo account reaches, with their access and whether each is a harness project yet. */
  const gitlabProjects = (employeeId: string, warn: boolean) =>
    GITLAB_PROJECTS.map((g) => {
      const maintainer = warn && g.id === 3
      return {
        id: g.id,
        path: g.path,
        webUrl: g.web,
        accessLevel: maintainer ? 40 : 30,
        role: maintainer ? 'Maintainer' : 'Developer',
        defaultBranch: 'main',
        protected: true,
        added: addedOf(employeeId, g),
        warnings: maintainer ? ['Maintainer: it could merge or push to protected branches. Developer is recommended.'] : [],
      }
    })
  /** "Add as project": a harness project with the repository, or only a link when the harness has it already. */
  const addGitlabProjects = (employeeId: string, ids: unknown[]) => {
    const contactId = h.get<EmployeeData>('employee', employeeId)?.data.contactId
    if (!contactId) throw new ApiRequestError(404, 'not_found', 'employee not found')
    const created: string[] = []
    const linked: string[] = []
    const already: string[] = []
    for (const g of GITLAB_PROJECTS.filter((x) => ids.map(String).includes(String(x.id)))) {
      const a = addedOf(employeeId, g)
      const link = (projectId: string) =>
        h.db.links.push({
          id: mockId('lnk', ++h.db.seq),
          from: { kind: 'contact', id: contactId },
          to: { kind: 'project', id: projectId },
          role: 'member',
          data: {},
          createdAt: h.iso(),
        })
      if (a?.linked) already.push(g.path)
      else if (a) {
        link(a.projectId)
        linked.push(g.path)
      } else {
        const pid = mockId('pro', `g${++h.db.seq}`)
        h.write<ProjectData>('project', pid, {
          name: g.name,
          description: g.description,
          status: 'active',
          repositories: [{ url: g.ssh, httpUrl: g.http, defaultBranch: 'main' }],
        })
        link(pid)
        created.push(g.path)
      }
    }
    const parts = [
      created.length ? `Added ${created.length} project${created.length === 1 ? '' : 's'}: ${created.join(', ')}.` : '',
      linked.length
        ? `Linked it to ${linked.length} existing project${linked.length === 1 ? '' : 's'}: ${linked.join(', ')}.`
        : '',
      already.length ? `Already added: ${already.join(', ')}.` : '',
    ].filter(Boolean)
    return parts.join(' ') || 'Nothing to add.'
  }

  const stepsOf = (id: string, name: string): SetupStep[] => {
    const e = employee(id)
    const handle = handleOf(e)
    const st = stageOf(id)[name]!
    const minsAgo = (m: number) => new Date(h.db.now() - m * 60_000).toISOString()
    if (name === 'slack') {
      const manifest = slackManifestOf(e.data.name, handle, hookUrl('slack', id))
      return [
        s(
          'app',
          'Create the Slack app',
          st.app!,
          st.app === 'done'
            ? `The app is created; Slack sends its events to ${hookUrl('slack', id)}.`
            : 'Create the app from the manifest, then install it to the workspace.',
          {
            requestUrl: hookUrl('slack', id),
            createUrl: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`,
          },
        ),
        st.tokens === 'done'
          ? s('tokens', 'Install it and paste the tokens', 'done', `Signed in as @${handle} in Example Corp.`, {
              botUser: handle,
              team: 'Example Corp',
              teamUrl: 'https://example-corp.slack.com/',
              missingScopes: [],
              signingSecret: true,
            })
          : s('tokens', 'Install it and paste the tokens', 'todo', 'Paste the bot token and the signing secret.'),
        st.events === 'done'
          ? s('events', 'Events reach the harness', 'done', 'The last signed request from Slack arrived 4 minutes ago.', {
              lastAt: minsAgo(4),
              requestUrl: hookUrl('slack', id),
            })
          : s(
              'events',
              'Events reach the harness',
              'todo',
              'No signed request from Slack yet. Under Event Subscriptions, retry the request URL.',
              { requestUrl: hookUrl('slack', id) },
            ),
        st.channels === 'done'
          ? s('channels', 'Invite it to channels', 'done', 'In 3 channels. DMs to the app work without an invite.', {
              channels: [
                { id: 'C01', name: 'payments', private: false },
                { id: 'C02', name: 'billing-alerts', private: false },
                { id: 'C03', name: 'finance-ops', private: true },
              ],
              invite: `/invite @${handle}`,
            })
          : s(
              'channels',
              'Invite it to channels',
              'todo',
              `It isn’t in any channel yet. Run /invite @${handle} in each channel it should read or post in.`,
              {
                channels: [],
                invite: `/invite @${handle}`,
              },
            ),
        routing(
          st.routing!,
          'Slack',
          'Slack: mentions and DMs',
          'The recommended trigger sends mentions and DMs to the router context.',
        ),
      ]
    }
    if (name === 'gitlab') {
      const key = keyOf(id)
      const connected = st.token !== 'todo'
      return [
        s(
          'instance',
          'GitLab instance',
          'done',
          'gitlab.com. For a self-hosted instance, set its URL below or GITLAB_BASE_URL on the server.',
          {
            baseUrl: 'https://gitlab.com',
            source: 'default',
            adminUsersUrl: 'https://gitlab.com/admin/users/new',
            serviceAccountsDocs: 'https://docs.gitlab.com/user/profile/service_accounts/',
          },
        ),
        connected
          ? s('account', 'A service account for the employee', 'done', `@${handle}, a service account.`, {
              username: handle,
              name: `${e.data.name} (AI)`,
              avatarUrl: null,
              serviceAccount: true,
            })
          : s(
              'account',
              'A service account for the employee',
              'todo',
              'Create an account for the employee, then paste its token below.',
            ),
        st.token === 'warning'
          ? s('token', 'Paste its access token', 'warning', 'The token expires in 12 days (2026-10-11): rotate it.', {
              scopes: ['api'],
              expiresAt: '2026-10-11',
              daysLeft: 12,
            })
          : st.token === 'done'
            ? s('token', 'Paste its access token', 'done', 'Works, with the api scope; expires 2027-06-30.', {
                scopes: ['api'],
                expiresAt: '2027-06-30',
              })
            : s('token', 'Paste its access token', 'todo', 'A personal access token of the account, with the api scope.'),
        s(
          'ssh-key',
          'Add its SSH key',
          st['ssh-key']!,
          st['ssh-key'] === 'done'
            ? `On @${handle} as “meatless-proxy ${handle}”.`
            : connected
              ? `Not on @${handle} yet. Add it, so the employee can push over SSH.`
              : 'Needs a working token, or add the key by hand.',
          { publicKey: key.publicKey, fingerprint: key.fingerprint, title: `meatless-proxy ${handle}` },
        ),
        st.projects === 'todo'
          ? s('projects', 'Give it access to projects', 'todo', 'Needs a working token.')
          : s(
              'projects',
              'Give it access to projects',
              st.projects!,
              st.projects === 'warning'
                ? '1 of 3 projects need attention.'
                : 'Developer on 3 projects, with protected default branches.',
              { projects: gitlabProjects(id, st.projects === 'warning') as unknown as Json },
            ),
        s(
          'webhooks',
          'Webhooks',
          st.webhooks!,
          st.webhooks === 'done'
            ? 'The last event arrived 12 minutes ago.'
            : 'The harness registers them on every GitLab repository of the projects the employee is on. Link a repository to one of its projects.',
          {
            url: hookUrl('gitlab', id),
            provisioning: true,
            reason: null,
            lastReceivedAt: st.webhooks === 'done' ? minsAgo(12) : null,
            hooks:
              st.webhooks === 'done'
                ? [
                    {
                      project: 'example/invoices',
                      status: 'ok',
                      error: null,
                      url: hookUrl('gitlab', id),
                      lastOkAt: minsAgo(300),
                      lastReceivedAt: minsAgo(55),
                    },
                    {
                      project: 'example/payments-api',
                      status: 'ok',
                      error: null,
                      url: hookUrl('gitlab', id),
                      lastOkAt: minsAgo(300),
                      lastReceivedAt: minsAgo(12),
                    },
                  ]
                : [],
          },
        ),
        routing(
          st.routing!,
          'GitLab',
          `GitLab: issues assigned to @${handle}`,
          'The recommended trigger sends open issues assigned to it to the router context.',
        ),
      ]
    }
    return [
      st['api-key'] === 'done'
        ? s('api-key', 'Paste its API key', 'done', `Signed in as ${handle} in Example Corp.`, {
            viewerId: 'lin-1',
            name: e.data.name,
            organization: 'Example Corp',
          })
        : s('api-key', 'Paste its API key', 'todo', 'A personal API key of the employee’s own Linear member.'),
      st.webhook === 'done'
        ? s('webhook', 'Webhook', 'done', 'The last signed event arrived 2 minutes ago.', { url: hookUrl('linear', id) })
        : s(
            'webhook',
            'Webhook',
            'todo',
            'Create the webhook here (Linear admins), or by hand with the URL below, then paste its signing secret.',
            {
              url: hookUrl('linear', id),
              secretSet: false,
              resourceTypes: ['Issue', 'Comment', 'IssueLabel', 'Reaction'],
            },
          ),
      routing(
        st.routing!,
        'Linear',
        `Linear: issues assigned to ${e.data.name}`,
        'The recommended trigger sends issues assigned to it to the router context.',
      ),
    ]
  }

  const routing = (status: SetupStep['status'], label: string, name: string, recommended: string) =>
    status === 'done'
      ? s('routing', 'Route events to the employee', 'done', `${name} routes ${label} events to it.`, {
          triggers: [{ id: 'trg_mock', name }],
        })
      : s('routing', 'Route events to the employee', 'todo', `No trigger takes ${label} events yet.`, {
          recommended,
        })

  const statusOf = (id: string, name: string): IntegrationSetupStatus => {
    const steps = stepsOf(id, name)
    const st = stageOf(id)[name]!
    const tokenSet = st[TOKEN_OF[name]!] !== 'todo'
    const actions: string[] = []
    const open = (step: string) => st[step] !== 'done'
    if (name === 'slack' && tokenSet && open('routing')) actions.push('add-trigger')
    if (name === 'gitlab' && tokenSet) {
      if (open('ssh-key')) actions.push('add-ssh-key')
      actions.push('add-projects')
      actions.push('register-webhooks')
      if (open('routing')) actions.push('add-trigger')
    }
    if (name === 'linear' && tokenSet) {
      if (open('webhook')) actions.push('create-webhook')
      if (open('routing')) actions.push('add-trigger')
    }
    return {
      name,
      label: LABEL[name]!,
      enabled: true,
      state: !tokenSet ? 'not_set_up' : steps.every((x) => x.status === 'done') ? 'connected' : 'needs_attention',
      steps,
      secrets: SECRETS[name]!.map((f) => ({ ...f, set: f.name === 'GITLAB_BASE_URL' ? false : tokenSet, global: false })),
      actions,
      checkedAt: h.iso(),
    }
  }

  const all = (id: string): EmployeeIntegrations => {
    employee(id)
    return {
      employeeId: id,
      publicUrl: MOCK_PUBLIC_URL,
      integrations: ['slack', 'gitlab', 'linear'].map((n) => statusOf(id, n)),
      checkedAt: h.iso(),
    }
  }

  const result = (id: string, name: string, message: string): Promise<SetupResult> =>
    h.delay({ ok: true, message, integration: statusOf(id, name) })

  const reject = (status: number, code: 'validation' | 'conflict' | 'not_found', message: string) =>
    Promise.reject(new ApiRequestError(status, code, message))

  return {
    async createEmployee(body) {
      const name = body.name?.trim()
      if (!name) return reject(422, 'validation', 'name is required')
      const handle = (body.handle?.trim() || name)
        .toLowerCase()
        .replace(/^@/, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
      if (!handle) return reject(422, 'validation', 'employee name must contain letters or digits')
      if (h.all<EmployeeData>('employee').some((e) => e.key === handle))
        return reject(409, 'conflict', `an employee named ${handle} already exists`)
      h.db.seq++
      const contactId = mockId('con', `9${h.db.seq}`)
      h.write<ContactData>('contact', contactId, {
        name,
        kind: 'ai',
        ...(body.role ? { role: body.role } : {}),
        ...(body.description ? { bio: body.description } : {}),
        handles: [{ system: 'mp', id: handle }],
      })
      const id = mockId('emp', `9${h.db.seq}`)
      const routerSessionId = mockId('ses', `9${h.db.seq}`)
      const rec = h.write<EmployeeData>('employee', id, {
        name,
        contactId,
        ...(body.personality ? { personality: body.personality } : {}),
        ...(body.model ? { model: body.model } : {}),
        tools: { allow: ['**'], deny: [] },
        routerSessionId,
      })
      rec.key = handle
      const channels: Record<string, string> = {}
      for (const ch of h.all<ChannelData>('channel')) if (ch.data.name === 'general') channels.general = ch.id
      const requests = mockId('chn', `9${h.db.seq}`)
      h.write<ChannelData>('channel', requests, {
        name: `requests-${handle}`,
        topic: `Ask ${name} for something: each new message is a request.`,
        members: [{ kind: 'employee', id }],
      } as unknown as ChannelData)
      channels[`requests-${handle}`] = requests
      const triggerId = mockId('trg', `9${h.db.seq}`)
      h.write<TriggerData>('trigger', triggerId, {
        name: `#requests-${handle}: new requests`,
        employeeId: id,
        enabled: true,
        match: { source: 'chat', type: 'message.*', where: { 'payload.channelId': requests } },
        target: { type: 'router' },
      } as unknown as TriggerData)
      return h.delay({ employee: rec, routerSessionId, channels, triggerId })
    },

    employeeSshKey: async (id) => h.delay(keyOf(id)),
    async rotateSshKey(id) {
      const e = employee(id)
      const k = fakeKey(handleOf(e), ++rotations)
      keys.set(id, { ...k, createdAt: h.iso() })
      const st = stageOf(id).gitlab!
      st['ssh-key'] = 'todo'
      return h.delay({ employeeId: id, publicKey: k.publicKey })
    },

    employeeIntegrations: async (id) => h.delay(all(id)),

    async setIntegrationSecrets(id, name, values) {
      const st = stageOf(id)[name]
      if (!st) return reject(404, 'not_found', `integration ${name} not found`)
      const bad = (msg: string) => reject(422, 'validation', msg)
      if (name === 'slack') {
        const t = values.SLACK_BOT_TOKEN
        if (t !== undefined && !t.startsWith('xoxb-'))
          return bad(
            'That isn’t a bot token: use the Bot User OAuth Token (xoxb-…) from OAuth & Permissions, never a user token.',
          )
        if (t?.includes('bad')) return bad('Slack rejected the bot token (invalid_auth). It was not saved.')
        if (t) st.tokens = st.app = st.channels = 'done'
        return result(id, name, t ? `Connected as @${handleOf(employee(id))} in Example Corp.` : 'Signing secret saved.')
      }
      if (name === 'gitlab') {
        const t = values.GITLAB_TOKEN
        if (t?.includes('bad')) return bad('GitLab rejected the token (401). It was not saved.')
        if (t?.includes('read')) return bad('The token needs the api scope (it has read_api). It was not saved.')
        if (t) {
          st.account = st.token = 'done'
          st.projects = 'done'
        }
        return result(id, name, t ? `Connected as @${handleOf(employee(id))}.` : 'Instance URL saved.')
      }
      const k = values.LINEAR_API_KEY
      if (k?.includes('bad')) return bad('Linear rejected the API key. It was not saved.')
      if (k) st['api-key'] = 'done'
      if (values.LINEAR_WEBHOOK_SECRET) st.webhook = 'todo'
      return result(id, name, k ? `Connected as ${handleOf(employee(id))}.` : 'Signing secret saved.')
    },

    async integrationAction(id, name, action, input) {
      const st = stageOf(id)[name]
      if (!st) return reject(404, 'not_found', `integration ${name} not found`)
      if (action === 'add-trigger') {
        const was = st.routing
        st.routing = 'done'
        return result(
          id,
          name,
          was === 'done' ? 'Already routed.' : `Added the trigger: ${LABEL[name]} events now go to the router context.`,
        )
      }
      if (name === 'gitlab' && action === 'add-ssh-key') {
        if (id === EMP.support)
          return reject(
            409,
            'conflict',
            'GitLab says this key is already in use on another account. Remove it there (or rotate this employee’s key), then add it again.',
          )
        const was = st['ssh-key']
        st['ssh-key'] = 'done'
        const handle = handleOf(employee(id))
        return result(
          id,
          name,
          was === 'done' ? `The key is already on @${handle}.` : `Added the key to @${handle} as “meatless-proxy ${handle}”.`,
        )
      }
      if (name === 'gitlab' && action === 'add-projects') {
        const ids = input?.projects
        if (!Array.isArray(ids) || !ids.length) return reject(422, 'validation', 'Pick the GitLab projects to add.')
        return result(id, name, addGitlabProjects(id, ids))
      }
      if (name === 'gitlab' && action === 'register-webhooks') {
        st.webhooks = 'done'
        return result(id, name, 'Webhooks are in place on 2 projects.')
      }
      if (name === 'linear' && action === 'create-webhook') {
        st.webhook = 'done'
        return result(id, name, 'Registered the webhook; its signing secret is saved.')
      }
      return reject(404, 'not_found', `${LABEL[name]} action ${action} not found`)
    },

    async slackManifest(id) {
      const e = employee(id)
      const manifest = slackManifestOf(e.data.name, handleOf(e), hookUrl('slack', id))
      return h.delay({
        manifest,
        createUrl: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`,
        requestUrl: hookUrl('slack', id),
      })
    },

    async integrationsStatus() {
      const TOKEN: Record<string, string> = { slack: 'SLACK_BOT_TOKEN', gitlab: 'GITLAB_TOKEN', linear: 'LINEAR_API_KEY' }
      const HOOK: Record<string, string> = {
        slack: 'SLACK_SIGNING_SECRET',
        gitlab: 'GITLAB_WEBHOOK_SECRET',
        linear: 'LINEAR_WEBHOOK_SECRET',
      }
      const hasSecret = (name: string, id: string) =>
        h.db.secrets.some(
          (x) => x.name === name && (x.scope.type === 'global' || (x.scope.type === 'employee' && x.scope.id === id)),
        )
      const hooks = h.all<{
        employeeId: string
        gitlabProject: string
        status: 'ok' | 'error'
        error?: string
        lastAttemptAt: string
      }>('gitlab_hook')
      const employees = h.all<EmployeeData>('employee').map((e) => {
        const st = stageOf(e.id)
        return {
          id: e.id,
          name: e.data.name,
          integrations: Object.fromEntries(
            ['slack', 'gitlab', 'linear'].map((n) => [
              n,
              {
                token: st[n]![TOKEN_OF[n]!] !== 'todo' || hasSecret(TOKEN[n]!, e.id),
                webhookSecret:
                  hasSecret(HOOK[n]!, e.id) ||
                  (n === 'slack' ? st.slack!.events === 'done' : st[n]!.webhook === 'done' || st[n]!.webhooks === 'done'),
              },
            ]),
          ),
          gitlabHooks: hooks
            .filter((x) => x.data.employeeId === e.id)
            .map((x) => ({
              gitlabProject: x.data.gitlabProject,
              projectIds: [],
              status: x.data.status,
              lastAttemptAt: x.data.lastAttemptAt,
              ...(x.data.error ? { error: x.data.error } : {}),
            })),
        }
      })
      return h.delay({
        enabled: ['slack', 'linear', 'gitlab'],
        gitlabHooks: { enabled: true, provisioningToken: true, lastRunAt: h.iso() },
        employees,
      } satisfies IntegrationsOverview)
    },
  }
}

function slackManifestOf(name: string, handle: string, requestUrl: string): Json {
  return {
    display_information: { name, description: `${name}, an AI employee (meatless-proxy)`, background_color: '#1f2937' },
    features: { bot_user: { display_name: handle, always_online: true } },
    oauth_config: { scopes: { bot: SCOPES.split(', ') } },
    settings: { event_subscriptions: { request_url: requestUrl, bot_events: ['app_mention', 'message.channels', 'message.im'] } },
  }
}
