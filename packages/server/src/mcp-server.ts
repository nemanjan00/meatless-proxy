import { randomUUID } from 'node:crypto'
import type { Message } from '@mp/chat'
import { errorMessage, isMpError, type BusMessage } from '@mp/core'
import type { Employee } from '@mp/directory'
import type { RunData } from '@mp/sessions'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import type { Services } from './services.ts'
import { contactForToken } from './tokens.ts'
import { accessOf } from './auth/access.ts'

/** What the harness pushes to connected MCP clients, as the `data` of `notifications/message`. */
export type HarnessNotification =
  | { type: 'chat.reply' | 'chat.mention'; channelId: string; threadId: string; messageId: string; author: string; text: string }
  | { type: 'work.finished'; runId: string; sessionId: string; state: string; text: string }
  | { type: 'approval.needed'; runId: string; sessionId: string; threadId?: string; text: string }

interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport
  server: McpServer
  contactId: string
  offs: (() => void)[]
}

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})
const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true })

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30) || 'x'

/**
 * The harness as an MCP server (docs/spec.md#the-harness-as-an-mcp-server):
 * streamable HTTP at `/mcp`, one MCP session per client, authenticated with a
 * per-contact bearer token. Every action is authored by that contact, and the
 * client is notified of replies, mentions, finished work and approvals.
 */
export class HarnessMcpServer {
  private sessions = new Map<string, McpSession>()

  constructor(private s: Services) {}

  get size() {
    return this.sessions.size
  }

  async handle(req: Request): Promise<Response> {
    const auth = req.headers.get('authorization') ?? ''
    const m = /^Bearer\s+(.+)$/i.exec(auth)
    const tokenContact = m ? await contactForToken(this.s.records, m[1]!.trim()) : null
    // Same rule as /api: AI employees and people who left can't sign in, whatever token they hold.
    const contactId = tokenContact && accessOf(await this.s.directory.contacts.get(tokenContact)) ? tokenContact : null
    if (!contactId) {
      return Response.json(
        { jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized: send Authorization: Bearer <token>' }, id: null },
        { status: 401, headers: { 'www-authenticate': 'Bearer' } },
      )
    }
    const sid = req.headers.get('mcp-session-id')
    if (sid) {
      const session = this.sessions.get(sid)
      if (!session)
        return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'session not found' }, id: null }, { status: 404 })
      if (session.contactId !== contactId)
        return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'forbidden' }, id: null }, { status: 403 })
      return session.transport.handleRequest(req)
    }
    if (req.method !== 'POST') {
      return Response.json(
        { jsonrpc: '2.0', error: { code: -32000, message: 'no session: initialize first' }, id: null },
        { status: 400 },
      )
    }
    const server = this.buildServer(contactId)
    const session: McpSession = { server, contactId, offs: [], transport: undefined as never }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, session)
        session.offs = this.subscribe(session)
        this.s.logger.info('mcp client connected', { contactId, session: id })
      },
      onsessionclosed: (id) => this.drop(id),
    })
    session.transport = transport
    transport.onclose = () => {
      if (transport.sessionId) this.drop(transport.sessionId)
    }
    await server.connect(transport)
    return transport.handleRequest(req)
  }

  private drop(id: string) {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    for (const off of session.offs) off()
    void session.server.close().catch(() => {})
  }

  async close() {
    for (const id of [...this.sessions.keys()]) this.drop(id)
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  private buildServer(contactId: string): McpServer {
    const s = this.s
    const server = new McpServer(
      { name: 'meatless-proxy', version: '0.0.0' },
      {
        capabilities: { logging: {} },
        instructions:
          'Reach the AI employees of this company. Post in harness chat, ask an employee, look up sessions and docs, and check on work you started. Replies and finished work arrive as notifications/message.',
      },
    )
    const author = { kind: 'contact' as const, id: contactId }

    const channelOf = async (nameOrId: string) => {
      const ch = nameOrId.startsWith('chn_') ? await s.chat.getChannel(nameOrId) : await s.chat.channelByName(nameOrId)
      if (!ch) throw new Error(`no channel ${nameOrId}`)
      return ch
    }
    const safe =
      <A>(fn: (args: A) => Promise<ReturnType<typeof text>>) =>
      async (args: A) => {
        try {
          return await fn(args)
        } catch (e) {
          return fail(isMpError(e) || e instanceof Error ? e.message : errorMessage(e))
        }
      }
    const renderMessage = async (m: Message) => {
      const a = m.data.author
      let name = a.id
      if (a.kind === 'contact') name = (await s.directory.contacts.get(a.id))?.data.name ?? a.id
      else {
        const x = await s.sessions.get(a.id)
        if (x) name = `${(await s.directory.employees.get(x.data.employeeId))?.data.name ?? 'employee'} (${x.data.slug})`
      }
      return { id: m.id, threadId: m.data.threadId ?? m.id, author: name, text: m.data.text, at: m.data.createdAt }
    }

    server.registerTool(
      'chat_post',
      {
        description:
          'Post a message in a harness chat channel, or reply in a thread. Tag employees with @name to ask them to act.',
        inputSchema: {
          channel: z.string().describe('Channel name (e.g. requests) or id'),
          text: z.string().min(1),
          thread_id: z.string().optional().describe('Reply in this thread (the root message id)'),
        },
      },
      safe(async ({ channel, text: body, thread_id }) => {
        const ch = await channelOf(channel)
        const msg = await s.chat.post({ channelId: ch.id, author, text: body, ...(thread_id ? { threadId: thread_id } : {}) })
        return text({ messageId: msg.id, threadId: msg.data.threadId ?? msg.id, channelId: ch.id })
      }),
    )

    server.registerTool(
      'chat_read',
      {
        description: 'Read the latest messages of a channel, or a whole thread.',
        inputSchema: {
          channel: z.string().optional().describe('Channel name or id (for top-level messages)'),
          thread_id: z.string().optional().describe('Read this thread instead'),
          limit: z.number().int().min(1).max(200).optional(),
        },
      },
      safe(async ({ channel, thread_id, limit }) => {
        if (thread_id) return text(await Promise.all((await s.chat.thread(thread_id)).map(renderMessage)))
        if (!channel) throw new Error('give a channel or a thread_id')
        const ch = await channelOf(channel)
        return text(await Promise.all((await s.chat.messages(ch.id, { limit: limit ?? 30 })).map(renderMessage)))
      }),
    )

    server.registerTool(
      'ask',
      {
        description:
          'Ask an AI employee a question. It is posted in your direct thread with the employee, tagging it; the answer arrives as a notification (or read it with chat_read).',
        inputSchema: { employee: z.string().describe('Employee name or @handle'), question: z.string().min(1) },
      },
      safe(async ({ employee, question }) => {
        const emp = await s.directory.employees.byHandle(employee.replace(/^@/, ''))
        if (!emp) throw new Error(`no employee ${employee}`)
        const ch = await this.dmChannel(contactId, emp)
        const msg = await s.chat.post({ channelId: ch.id, author, text: `@${emp.key ?? slug(emp.data.name)} ${question}` })
        return text({
          threadId: msg.id,
          channelId: ch.id,
          note: `Asked ${emp.data.name}. You'll be notified when it replies in the thread.`,
        })
      }),
    )

    server.registerTool(
      'session_get',
      {
        description: "A session: its title, status, document, the latest run's state and output.",
        inputSchema: { id: z.string() },
      },
      safe(async ({ id }) => {
        const x = await s.sessions.require(id)
        const runs = await s.sessions.runs({ sessionId: id })
        const last = runs.at(-1)
        return text({
          id: x.id,
          title: x.data.title,
          slug: x.data.slug,
          status: x.data.status,
          employee: (await s.directory.employees.get(x.data.employeeId))?.data.name,
          document: x.data.document,
          lastRun: last
            ? { id: last.id, state: last.data.state, result: last.data.result, pauseReason: last.data.pauseReason }
            : null,
        })
      }),
    )

    server.registerTool(
      'sessions_search',
      {
        description: 'Search sessions by title and document.',
        inputSchema: { text: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
      },
      safe(async ({ text: q, limit }) => {
        const res = await s.sessions.searchSessions(q, { limit: limit ?? 10 })
        return text(res.items.map((x) => ({ id: x.id, title: x.data.title, slug: x.data.slug, status: x.data.status })))
      }),
    )

    server.registerTool(
      'docs_search',
      {
        description: 'Search documents (project, session and procedure docs).',
        inputSchema: { text: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
      },
      safe(async ({ text: q, limit }) => {
        const res = await s.records.query<{ title: string; body: string }>('doc', { text: q, limit: limit ?? 10 })
        return text(
          res.items.map((d) => {
            const i = d.data.body.toLowerCase().indexOf(q.toLowerCase())
            return { id: d.id, title: d.data.title, snippet: d.data.body.slice(Math.max(0, i - 60), Math.max(0, i) + 140) }
          }),
        )
      }),
    )

    server.registerTool(
      'docs_read',
      {
        description: 'Read a document by id, or one chapter of it.',
        inputSchema: { id: z.string(), chapter: z.string().optional() },
      },
      safe(async ({ id, chapter }) => {
        if (chapter) {
          const body = await s.docs.chapter(id, chapter)
          if (body === null) throw new Error(`no chapter ${chapter}`)
          return text(body)
        }
        const d = await s.docs.get(id)
        if (!d) throw new Error(`no document ${id}`)
        return text(`# ${d.data.title}\n\n${d.data.body}`)
      }),
    )

    server.registerTool(
      'my_work',
      { description: 'Runs and sessions working for you: what you asked for, its state and output.', inputSchema: {} },
      safe(async () => {
        const runs = await s.records.query<RunData>('run', {
          where: { requesterId: contactId },
          orderBy: { field: 'createdAt', dir: 'desc' },
          limit: 20,
        })
        const linked = await s.records.linked({ kind: 'contact', id: contactId }, { kind: 'session' })
        const sessionIds = new Set([...runs.items.map((r) => r.data.sessionId), ...linked.map((l) => l.record.id)])
        const sessions = []
        for (const id of sessionIds) {
          const x = await s.sessions.get(id)
          if (x) sessions.push({ id: x.id, title: x.data.title, slug: x.data.slug, status: x.data.status })
        }
        return text({
          runs: runs.items.map((r) => ({
            id: r.id,
            sessionId: r.data.sessionId,
            state: r.data.state,
            output: r.data.result?.output,
            at: r.createdAt,
          })),
          sessions,
        })
      }),
    )

    return server
  }

  /** The contact's direct-message channel with an employee (created on first use). */
  async dmChannel(contactId: string, emp: Employee) {
    const s = this.s
    const contact = await s.directory.contacts.require(contactId)
    const name = `dm-${slug(emp.key ?? emp.data.name)}-${slug(contact.data.name)}-${contactId.slice(-6).toLowerCase()}`
    const existing = await s.chat.channelByName(name)
    if (existing) return existing
    try {
      const ch = await s.chat.createChannel({
        name,
        topic: `${contact.data.name} and ${emp.data.name}`,
        createdBy: { kind: 'contact', id: contactId },
        members: [
          { kind: 'contact', id: contactId },
          { kind: 'employee', id: emp.id },
        ],
      })
      return await s.records.update('channel', ch.id, { dm: true })
    } catch (e) {
      if (isMpError(e, 'conflict')) {
        const again = await s.chat.channelByName(name)
        if (again) return again
      }
      throw e
    }
  }

  // ── Notifications out ─────────────────────────────────────────────────────

  private subscribe(session: McpSession): (() => void)[] {
    const s = this.s
    const contactId = session.contactId
    const notify = (data: HarnessNotification) =>
      session.server.server
        .notification({ method: 'notifications/message', params: { level: 'info', logger: 'meatless-proxy', data } })
        .catch((err) => s.logger.debug('mcp notification failed', { err: errorMessage(err) }))

    const onMessage = async (m: BusMessage<{ channelId: string; threadId: string | null; messageId: string }>) => {
      const msg = await s.chat.getMessage(m.payload.messageId)
      if (!msg || (msg.data.author.kind === 'contact' && msg.data.author.id === contactId)) return
      const rootId = msg.data.threadId ?? msg.id
      const mentioned = (msg.data.tags ?? []).some((t) => t.type === 'person' && t.contactId === contactId)
      let inThread = false
      if (msg.data.threadId) {
        const root = await s.chat.getMessage(rootId)
        inThread = root?.data.author.kind === 'contact' && root.data.author.id === contactId
        if (!inThread) {
          const mine = await s.records.query('message', { where: { threadId: rootId, 'author.id': contactId }, limit: 1 })
          inThread = mine.total > 0
        }
      }
      if (!mentioned && !inThread) return
      let authorName = msg.data.author.id
      if (msg.data.author.kind === 'contact')
        authorName = (await s.directory.contacts.get(msg.data.author.id))?.data.name ?? authorName
      else {
        const x = await s.sessions.get(msg.data.author.id)
        if (x) authorName = (await s.directory.employees.get(x.data.employeeId))?.data.name ?? authorName
      }
      await notify({
        type: inThread ? 'chat.reply' : 'chat.mention',
        channelId: msg.data.channelId,
        threadId: rootId,
        messageId: msg.id,
        author: authorName,
        text: msg.data.text,
      })
    }

    const onRunState = async (m: BusMessage<{ runId: string; sessionId: string; to: string }>) => {
      const { to } = m.payload
      if (!['completed', 'failed', 'cancelled', 'paused'].includes(to)) return
      const run = await s.sessions.getRun(m.payload.runId)
      if (!run) return
      let mine = run.data.requesterId === contactId
      if (!mine && to !== 'paused') {
        const links = await s.records.links({ touching: { kind: 'session', id: run.data.sessionId } })
        mine = links.some((l) => (l.from.id === contactId || l.to.id === contactId) && run.data.mode === 'continuing')
      }
      if (!mine) return
      const session = await s.sessions.get(run.data.sessionId)
      const title = session?.data.title ?? run.data.sessionId
      if (to === 'paused') {
        await notify({
          type: 'approval.needed',
          runId: run.id,
          sessionId: run.data.sessionId,
          text: `"${title}" is paused and needs you: ${run.data.pauseReason ?? 'no reason given'}`,
        })
        return
      }
      await notify({
        type: 'work.finished',
        runId: run.id,
        sessionId: run.data.sessionId,
        state: to,
        text: `"${title}" ${to}${run.data.result?.output ? `: ${run.data.result.output.slice(0, 500)}` : ''}`,
      })
    }

    const guard =
      <T>(fn: (m: BusMessage<T>) => Promise<void>) =>
      (m: BusMessage<T>) =>
        fn(m).catch((err) => s.logger.debug('mcp notification skipped', { err: errorMessage(err) }))
    return [s.bus.subscribe('chat.message', guard(onMessage)), s.bus.subscribe('run.state', guard(onRunState))]
  }
}
