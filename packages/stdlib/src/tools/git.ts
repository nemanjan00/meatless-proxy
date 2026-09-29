import { join } from 'node:path'
import { NotFoundError, ValidationError, type Json } from '@mp/core'
import { assertPushAllowed, mirrorKey, type Author, type GitAuth, type GitCache } from '@mp/git'
import type { Session } from '@mp/sessions'
import type { ToolContext } from '@mp/tools'
import { Roles, clip, fail, ok, str, worktreesOf, type Kit, type WorktreeMeta } from '../kit.ts'
import type { StdlibDeps, WorktreeFs } from '../types.ts'
import { INSTRUCTIONS_NOTE, nestedInstructions, rootInstructions, type AgentInstructions } from '../agent-instructions.ts'
import { safeRelPath } from '../worktree-fs.ts'

const repoProp = {
  type: 'string',
  description: 'Which checkout: its key (host/path), or a project id. Optional when the session has only one.',
}

/** The branch a session works on: `<prefix>/<session slug>`. */
export function branchFor(
  employee: { key: string | null; data: { name: string; git?: { branchPrefix?: string } } },
  slug: string,
) {
  const prefix = (employee.data.git?.branchPrefix || `mp/${employee.key ?? employee.data.name.toLowerCase()}`).replace(/\/+$/, '')
  return `${prefix}/${slug}`
}

export function worktreeFor(session: Session, repo: string | undefined): WorktreeMeta {
  const all = worktreesOf(session)
  if (!all.length) throw new ValidationError('this session has no checkout yet: call git.checkout first')
  if (!repo) {
    if (all.length > 1) throw new ValidationError(`several checkouts: pass repo (one of ${all.map((w) => w.key).join(', ')})`)
    return all[0]!
  }
  const w = all.find((x) => x.key === repo || x.projectId === repo || x.url === repo)
  if (!w) throw new NotFoundError('checkout', repo)
  return w
}

/** The commit author for an employee: its git identity, else its contact. */
export async function authorFor(deps: Pick<StdlibDeps, 'directory'>, employeeId: string): Promise<Author> {
  const emp = await deps.directory.employees.require(employeeId)
  const contact = await deps.directory.contacts.get(emp.data.contactId)
  return {
    name: emp.data.git?.name || contact?.data.name || emp.data.name,
    email: emp.data.git?.email || contact?.data.email || `${emp.key ?? emp.id}@users.noreply.invalid`,
  }
}

/** Git auth for an employee: its own SSH key (`StdlibDeps.sshKeyFor`), or none. */
export async function gitAuthFor(deps: Pick<StdlibDeps, 'sshKeyFor'>, employeeId: string): Promise<GitAuth | undefined> {
  const key = await deps.sshKeyFor?.(employeeId)
  return key ? { sshPrivateKey: key } : undefined
}

export function trailersFor(sessionId: string, requesterId?: string): Record<string, string> {
  return { Session: sessionId, ...(requesterId ? { 'Requested-by': requesterId } : {}) }
}

export function registerGitTools(kit: Kit, git: GitCache, fs: WorktreeFs): void {
  const { deps } = kit
  const { directory } = deps

  /** Instruction files already handed to a session, per checkout (session meta `agentInstructions`). */
  const loadedInstructions = async (sessionId: string, key: string): Promise<Set<string>> => {
    const s = await deps.sessions.require(sessionId)
    const all = (s.data.meta?.agentInstructions ?? {}) as Record<string, string[]>
    return new Set(all[key] ?? [])
  }
  const rememberInstructions = (sessionId: string, key: string, files: string[]) =>
    kit.patchMeta(sessionId, (m) => {
      const all = { ...((m.agentInstructions as Record<string, string[]>) ?? {}) }
      all[key] = [...new Set([...(all[key] ?? []), ...files])]
      return { ...m, agentInstructions: all as unknown as Json }
    })
  const view = (i: AgentInstructions) => ({
    file: i.file,
    content: i.content,
    ...(i.truncated ? { truncated: true } : {}),
    ...(i.includes ? { includes: i.includes } : {}),
  })
  /** Nested AGENTS.md files this call reaches for the first time, as extra output fields. */
  const newInstructions = async (sessionId: string, w: WorktreeMeta, rel: string, isDirectory: boolean) => {
    const found = await nestedInstructions(fs, w.path, rel, await loadedInstructions(sessionId, w.key), { isDirectory })
    if (!found.length) return {}
    await rememberInstructions(
      sessionId,
      w.key,
      found.map((f) => f.file),
    )
    return { instructions: { note: INSTRUCTIONS_NOTE, files: found.map(view) } }
  }

  const worktree = async (ctx: ToolContext, repo?: string, sessionId?: string) => {
    const s = await kit.ownSession(sessionId, ctx)
    return worktreeFor(s, repo)
  }

  kit.tool(
    {
      name: 'git.checkout',
      description:
        'Get your own checkout of a project repository: a worktree of the local mirror on a new branch of your own (from the default branch or ref). Calling it again returns the existing checkout. Edit with git.write_file, then git.commit and git.push; changes reach production only through a pull request.',
      effect: 'idempotent',
      params: {
        properties: {
          projectId: { type: 'string' },
          repo: { type: 'number', description: "Index into the project's repositories. Default 0." },
          ref: { type: 'string', description: 'Branch or commit to start from. Default: the default branch.' },
        },
        required: ['projectId'],
      },
    },
    async (a, ctx) => {
      const session = await kit.ownSession(undefined, ctx)
      const project = await directory.projects.require(a.projectId)
      const index = a.repo ?? 0
      const repo = project.data.repositories?.[index]
      if (!repo) return fail(`project ${project.data.name} has no repository #${index}`)
      const key = mirrorKey(repo.url)
      const existing = worktreesOf(session).find((w) => w.key === key)
      if (existing) return ok({ ...(existing as unknown as Record<string, Json>), existing: true })
      const emp = await kit.employee(ctx.employeeId)
      const branch = branchFor(emp, session.data.slug)
      const path = join(deps.config.worktreesRoot, session.id, key)
      const auth = await gitAuthFor(deps, ctx.employeeId)
      await git.fetch(repo.url, auth)
      const info = await git.createWorktree(repo.url, {
        path,
        ref: a.ref ?? repo.defaultBranch ?? 'main',
        newBranch: branch,
        ...(auth ? { auth } : {}),
      })
      const w: WorktreeMeta = {
        key,
        projectId: project.id,
        repoIndex: index,
        url: repo.url,
        path: info.path,
        branch: info.branch ?? branch,
        baseSha: info.head,
      }
      await kit.patchMeta(session.id, (m) => ({
        ...m,
        worktrees: [...((m.worktrees as Json[]) ?? []), w as unknown as Json],
      }))
      await deps.records.link(
        { kind: 'session', id: session.id },
        { kind: 'project', id: project.id },
        Roles.worksOn,
        {},
        { actor: kit.actor(ctx) },
      )
      // The repo's instructions for coding agents (AGENTS.md, else CLAUDE.md), handed over once, with the checkout.
      const root = await rootInstructions(fs, w.path)
      if (root) await rememberInstructions(session.id, key, [root.file, ...(root.includes ?? [])])
      return ok({
        key,
        path: w.path,
        branch: w.branch,
        head: info.head,
        ...(repo.path ? { subdir: repo.path } : {}),
        ...(root ? { instructions: { note: INSTRUCTIONS_NOTE, files: [view(root)] } } : {}),
      })
    },
  )

  kit.tool(
    {
      name: 'git.status',
      description: 'Uncommitted changes in your checkout.',
      effect: 'read',
      params: { properties: { repo: repoProp } },
    },
    async (a, ctx) => {
      const w = await worktree(ctx, a.repo)
      const st = await git.status(w.path)
      return ok({ key: w.key, branch: w.branch, clean: st.clean, files: st.files.slice(0, 200) })
    },
  )

  kit.tool(
    {
      name: 'git.diff',
      description:
        "The diff of your checkout: every change since it was created (committed or not), or since base. sessionId: read another of your sessions' checkout (for reviews).",
      effect: 'read',
      params: { properties: { repo: repoProp, base: { type: 'string' }, sessionId: { type: 'string' } } },
    },
    async (a, ctx) => {
      const w = await worktree(ctx, a.repo, a.sessionId)
      const diff = await git.diff(w.path, a.base ?? w.baseSha)
      return ok({ key: w.key, branch: w.branch, diff: clip(diff, 20000) })
    },
  )

  kit.tool(
    {
      name: 'git.log',
      description: 'Recent commits on your checkout.',
      effect: 'read',
      params: { properties: { repo: repoProp, limit: { type: 'number' } } },
    },
    async (a, ctx) => {
      const w = await worktree(ctx, a.repo)
      const log = await git.log(w.path, Math.min(Math.max(1, a.limit ?? 10), 50))
      return ok({
        key: w.key,
        branch: w.branch,
        commits: log.map((c) => ({ sha: c.sha.slice(0, 12), subject: c.subject, author: c.author })),
      })
    },
  )

  kit.tool(
    {
      name: 'git.commit',
      description:
        'Commit every change in your checkout to your branch, as you (your git identity), with trailers linking the commit to this session and the requester. Write a tidy message: a short subject line, then why.',
      effect: 'idempotent',
      params: { properties: { message: { type: 'string' }, repo: repoProp }, required: ['message'] },
    },
    async (a, ctx) => {
      const message = str(a.message)
      if (!message) return fail('message is required')
      const w = await worktree(ctx, a.repo)
      const sha = await git.commitAll(w.path, {
        message,
        author: await authorFor(deps, ctx.employeeId),
        trailers: trailersFor(ctx.sessionId, ctx.requesterId),
      })
      return ok(
        sha ? { key: w.key, branch: w.branch, sha } : { key: w.key, branch: w.branch, sha: null, note: 'nothing to commit' },
      )
    },
  )

  kit.tool(
    {
      name: 'git.push',
      description:
        'Push your branch to the remote so you can open a pull request (with the task system or git host tools). Only your own branches can be pushed; protected branches (main, releases) never.',
      effect: 'idempotent',
      params: { properties: { repo: repoProp, branch: { type: 'string', description: 'Default: your checkout branch.' } } },
    },
    async (a, ctx) => {
      const w = await worktree(ctx, a.repo)
      const branch = str(a.branch) ?? w.branch
      assertPushAllowed(branch, deps.config.pushPolicy)
      await git.push(w.path, branch, deps.config.pushPolicy, await gitAuthFor(deps, ctx.employeeId))
      return ok({ key: w.key, pushed: branch, url: w.url })
    },
  )

  kit.tool(
    {
      name: 'git.read_file',
      description: 'Read a file in your checkout (path relative to the repository root).',
      effect: 'read',
      params: { properties: { path: { type: 'string' }, repo: repoProp, sessionId: { type: 'string' } }, required: ['path'] },
    },
    async (a, ctx) => {
      const w = await worktree(ctx, a.repo, a.sessionId)
      const rel = safeRelPath(w.path, a.path)
      if (!rel) return fail('path is a directory')
      const content = await fs.read(w.path, rel)
      return ok({
        path: rel,
        size: content.length,
        content: clip(content, 30000),
        ...(await newInstructions(ctx.sessionId, w, rel, false)),
      })
    },
  )

  kit.tool(
    {
      name: 'git.write_file',
      description: 'Create or replace a file in your checkout (path relative to the repository root). Commit with git.commit.',
      effect: 'idempotent',
      params: {
        properties: { path: { type: 'string' }, content: { type: 'string' }, repo: repoProp },
        required: ['path', 'content'],
      },
    },
    async (a, ctx) => {
      const w = await worktree(ctx, a.repo)
      const rel = safeRelPath(w.path, a.path)
      if (!rel) return fail('path is a directory')
      await fs.write(w.path, rel, String(a.content))
      return ok({
        key: w.key,
        path: rel,
        size: String(a.content).length,
        ...(await newInstructions(ctx.sessionId, w, rel, false)),
      })
    },
  )

  kit.tool(
    {
      name: 'git.list_files',
      description: 'List a directory of your checkout (default: the repository root).',
      effect: 'read',
      params: { properties: { path: { type: 'string' }, repo: repoProp, sessionId: { type: 'string' } } },
    },
    async (a, ctx) => {
      const w = await worktree(ctx, a.repo, a.sessionId)
      const rel = safeRelPath(w.path, a.path)
      const entries = await fs.list(w.path, rel)
      return ok({
        path: rel || '.',
        entries: entries.slice(0, 500).map((e) => (e.type === 'dir' ? `${e.name}/` : e.name)),
        ...(entries.length > 500 ? { note: `showing 500 of ${entries.length}` } : {}),
        ...(rel ? await newInstructions(ctx.sessionId, w, rel, true) : {}),
      })
    },
  )
}
