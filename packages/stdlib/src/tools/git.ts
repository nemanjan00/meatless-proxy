import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ConflictError, NotFoundError, ValidationError, type Json } from '@mp/core'
import {
  assertPushAllowed,
  isLocalRepoUrl,
  localBranchSubject,
  localRepoSlug,
  mirrorKey,
  type Author,
  type Divergence,
  type GitAuth,
  type GitCache,
} from '@mp/git'
import type { Session } from '@mp/sessions'
import type { ToolContext, ToolResult } from '@mp/tools'
import { Roles, clip, fail, ok, str, worktreesOf, type Kit, type RefWorktreeMeta, type WorktreeMeta } from '../kit.ts'
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

/**
 * Where a checkout can be reached, returned by git.checkout in place of its path on the harness's disk:
 * models took that path for one of their files (fs.share, attachments) and it isn't.
 */
export const CHECKOUT_NOTE =
  'Work on it with git.* (by this repository) and in an environment (env.up/env.exec) at /workspace, or /repos/<name> for every checkout of the session. It is not in your filesystem (fs.*, attachments, fs.share): to share or attach a file from it, copy it into your filesystem first (in an environment, /files is your filesystem root).'

/** Git's words for "this key may not read that repository". */
const ACCESS_DENIED =
  /permission denied \(publickey|could not read from remote repository|access denied|repository not found|not found or you don't have permission|authentication failed/i

/** A clone or fetch that failed for lack of access, explained, with what to do instead. */
export function accessFailure(err: unknown, url: string, hasKey: boolean): string | undefined {
  const text = err instanceof Error ? err.message : String(err)
  if (!ACCESS_DENIED.test(text)) return undefined
  return [
    `You don't have access to ${url}.`,
    hasKey
      ? "Your SSH key isn't accepted there: your account on the git host is likely not a member of this project."
      : 'You have no SSH key set up for git.',
    "Ask an admin to add your git host account to the project (the harness can't grant it). Meanwhile, if you have the git host's tools (e.g. mcp.gitlab.get_file, mcp.gitlab.list_tree), read the files through them, or ask a colleague who has access to do the part that needs the checkout.",
  ].join(' ')
}

/** What git.push says after pushing to a repository the harness hosts (a local project). */
export const LOCAL_REVIEW_NOTE =
  "This repository is hosted by the harness: there are no merge requests. Tell the requester the branch is ready for review; a person with a merge role reviews and merges it on the project's page in the web UI. You can't merge it yourself. This session is told when it is merged or deleted."

/** git.read_file: the most lines one call returns. */
const READ_MAX_LINES = 2000

/** git.read_file and projects.read_file: the most characters one call returns. */
const READ_MAX_CHARS = 30000

/**
 * What a file read returns: the whole content when it is small and no range was asked for, else numbered
 * lines of the range (at most READ_MAX_LINES) and where to go on.
 */
export function readView(content: string, offset?: unknown, limit?: unknown): Record<string, Json> {
  if (offset === undefined && limit === undefined && content.length <= READ_MAX_CHARS) return { size: content.length, content }
  const lines = content.split('\n')
  const start = Math.max(1, Math.floor(Number(offset) || 1))
  const count = Math.min(Math.max(1, Math.floor(Number(limit) || READ_MAX_LINES)), READ_MAX_LINES)
  const slice = lines.slice(start - 1, start - 1 + count)
  let text = slice.map((l, i) => `${start + i}\t${l}`).join('\n')
  if (text.length > READ_MAX_CHARS) text = clip(text, READ_MAX_CHARS)
  const end = start + slice.length - 1
  return {
    totalLines: lines.length,
    lines: slice.length ? `${start}-${end}` : 'none',
    content: text,
    ...(end < lines.length ? { next: `offset ${end + 1} reads on (${lines.length - end} lines left)` } : {}),
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

/** The repo instructions a tool result hands over. */
export const instructionView = (i: AgentInstructions) => ({
  file: i.file,
  content: i.content,
  ...(i.truncated ? { truncated: true } : {}),
  ...(i.includes ? { includes: i.includes } : {}),
})

/** Remembers instruction files handed to a session for a checkout (session meta `agentInstructions`). */
export const rememberInstructions = (kit: Kit, sessionId: string, key: string, files: string[]) =>
  kit.patchMeta(sessionId, (m) => {
    const all = { ...((m.agentInstructions as Record<string, string[]>) ?? {}) }
    all[key] = [...new Set([...(all[key] ?? []), ...files])]
    return { ...m, agentInstructions: all as unknown as Json }
  })

/** What git.checkout says when it was asked for a ref but the session already has a checkout of the repository. */
export const refNotAppliedNote = (w: WorktreeMeta, ref: string) =>
  `Already checked out on your branch ${w.branch} (from ${w.base ?? w.baseSha.slice(0, 12)}); ref ${ref} was not applied: git.checkout never switches an existing checkout. To read ${ref}, use projects.read_file / projects.list_files { projectId, ref }, or env.up { repos: [{ project, ref }] } for a read-only copy in an environment (git log/show/diff work there too). To build on top of ${ref}, start a new session (sessions.create) and git.checkout { projectId, ref } there.`

/** How old the last fetch may be before git.status (and git.checkout of an existing checkout) fetch again to tell whether the base moved. */
export const BEHIND_FETCH_MS = 5 * 60_000

/** What git.status, git.commit, git.push and git.sync say while a merge from git.sync is in progress. */
export const MERGE_GUIDANCE =
  'A merge from git.sync is in progress. Fix the conflicting files (between the <<<<<<< and >>>>>>> markers) with git.edit_file or in the environment, then git.commit to finish the merge; git.sync { abort: true } to back out.'

/** What git.status and git.checkout say when the base branch or the session's own remote branch has commits the checkout lacks. */
export function behindNote(d: Divergence): string | undefined {
  const n = (k: number) => `${k} new commit${k === 1 ? '' : 's'}`
  const parts: string[] = []
  if (d.base && d.base.behind > 0)
    parts.push(
      `your base ${d.base.ref} has ${n(d.base.behind)} since you branched (as of the last fetch): git.sync to bring them in`,
    )
  if (d.remote && d.remote.behind > 0)
    parts.push(
      `your branch ${d.remote.ref} on the remote has ${n(d.remote.behind)} you don't have (pushed from elsewhere): git.sync merges them`,
    )
  return parts.length ? `${parts.join('; ')}.` : undefined
}

/** A project's repository by index, with its mirror key. */
async function projectRepo(kit: Kit, projectId: string, index: number) {
  const project = await kit.deps.directory.projects.require(projectId)
  const repo = project.data.repositories?.[index]
  if (!repo) return { failure: fail(`project ${project.data.name} has no repository #${index}`) }
  return { project, repo, key: mirrorKey(repo.url) }
}

/** Fetches a repository for an employee: local repositories need no key. An access problem is a failure, explained. */
async function fetchFor(kit: Kit, git: GitCache, url: string, employeeId: string, projectName: string) {
  const auth = isLocalRepoUrl(url) ? undefined : await gitAuthFor(kit.deps, employeeId)
  try {
    await git.fetch(url, auth)
  } catch (err) {
    const why = accessFailure(err, url, !!auth)
    if (why) return { failure: fail(why, { project: projectName }) }
    throw err
  }
  return { auth }
}

/**
 * The session's own checkout of a project repository (git.checkout, and env.up for repositories it isn't
 * checked out yet): a worktree on a new branch of its own, from `ref` or the default branch. An existing
 * checkout of the repository is returned as it is (`existing`), whatever `ref` says.
 */
export async function checkoutRepo(
  kit: Kit,
  git: GitCache,
  fs: WorktreeFs,
  ctx: ToolContext,
  o: { projectId: string; repoIndex?: number; ref?: string },
): Promise<
  | { failure: ToolResult }
  | { w: WorktreeMeta; existing: boolean; projectName: string; subdir?: string; root?: AgentInstructions | null }
> {
  const { deps } = kit
  const session = await kit.ownSession(undefined, ctx)
  const index = o.repoIndex ?? 0
  const found = await projectRepo(kit, o.projectId, index)
  if ('failure' in found) return { failure: found.failure! }
  const { project, repo, key } = found
  const existing = worktreesOf(session).find((w) => w.key === key)
  if (existing) return { w: existing, existing: true, projectName: project.data.name }
  const emp = await kit.employee(ctx.employeeId)
  const branch = branchFor(emp, session.data.slug)
  const path = join(deps.config.worktreesRoot, session.id, key)
  const fetched = await fetchFor(kit, git, repo.url, ctx.employeeId, project.data.name)
  if ('failure' in fetched) return { failure: fetched.failure! }
  const { auth } = fetched
  // Without a ref, the remote's own default branch (origin/HEAD), not a guessed `main`.
  const ref = o.ref ?? repo.defaultBranch
  const info = await git.createWorktree(repo.url, {
    path,
    ...(ref ? { ref } : {}),
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
    ...(ref ? { base: ref } : {}),
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
  if (root) await rememberInstructions(kit, session.id, key, [root.file, ...(root.includes ?? [])])
  return { w, existing: false, projectName: project.data.name, ...(repo.path ? { subdir: repo.path } : {}), root }
}

/** A ref's directory name under the session's worktrees: readable, and unique per ref. */
const refDirName = (ref: string) =>
  `${
    ref
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+/, '')
      .slice(0, 60) || 'ref'
  }-${createHash('sha256').update(ref).digest('hex').slice(0, 8)}`

/**
 * A read-only worktree of one ref of a project repository (detached, no branch of its own), for reading
 * another branch next to the session's checkouts in an environment. Made fresh each time (a branch moves),
 * and recorded in `session.meta.refWorktrees`. Nothing is ever committed or pushed from it.
 */
export async function refWorktree(
  kit: Kit,
  git: GitCache,
  ctx: ToolContext,
  o: { projectId: string; repoIndex?: number; ref: string },
): Promise<{ failure: ToolResult } | { r: RefWorktreeMeta; projectName: string }> {
  const session = await kit.ownSession(undefined, ctx)
  const index = o.repoIndex ?? 0
  const found = await projectRepo(kit, o.projectId, index)
  if ('failure' in found) return { failure: found.failure! }
  const { project, repo, key } = found
  const ref = o.ref.trim()
  if (!ref || ref.startsWith('-')) return { failure: fail(`not a ref: ${JSON.stringify(o.ref)}`) }
  const fetched = await fetchFor(kit, git, repo.url, ctx.employeeId, project.data.name)
  if ('failure' in fetched) return { failure: fetched.failure! }
  const path = join(kit.deps.config.worktreesRoot, session.id, REF_WORKTREES_DIR, key, refDirName(ref))
  // A branch moves: start from where it is now.
  await git.removeWorktree(repo.url, path).catch(() => {})
  let info: Awaited<ReturnType<GitCache['createWorktree']>>
  try {
    info = await git.createWorktree(repo.url, { path, ref, ...(fetched.auth ? { auth: fetched.auth } : {}) })
  } catch (err) {
    if (err instanceof NotFoundError)
      return { failure: fail(`${project.data.name} has no branch or commit ${ref}: projects.branches lists its branches`) }
    throw err
  }
  const r: RefWorktreeMeta = { key, projectId: project.id, repoIndex: index, url: repo.url, path: info.path, ref, sha: info.head }
  await kit.patchMeta(session.id, (m) => ({
    ...m,
    refWorktrees: [
      ...((m.refWorktrees as unknown as RefWorktreeMeta[] | undefined) ?? []).filter((x) => !(x.key === key && x.ref === ref)),
      r,
    ] as unknown as Json,
  }))
  return { r, projectName: project.data.name }
}

/** Git auth for a checkout's remote: none for a local project. */
const authForCheckout = async (kit: Kit, w: WorktreeMeta, employeeId: string) =>
  isLocalRepoUrl(w.url) ? undefined : await gitAuthFor(kit.deps, employeeId)

/** Updates one of the session's checkouts in its meta. */
const patchWorktree = (kit: Kit, sessionId: string, key: string, fn: (w: WorktreeMeta) => WorktreeMeta) =>
  kit.patchMeta(sessionId, (m) => ({
    ...m,
    worktrees: ((m.worktrees as unknown as WorktreeMeta[] | undefined) ?? []).map((w) =>
      w.key === key ? fn(w) : w,
    ) as unknown as Json,
  }))

/**
 * Whether a checkout is behind its base or its own remote branch, fetching first when the last fetch is older than
 * BEHIND_FETCH_MS (so a status call rarely hits the network). Never fails: a fetch or compare that doesn't work just
 * leaves the note out.
 */
async function behindOf(kit: Kit, git: GitCache, w: WorktreeMeta, employeeId: string): Promise<string | undefined> {
  try {
    const last = await git.lastFetch(w.url)
    if (last === null || kit.deps.clock.now() - last > BEHIND_FETCH_MS) {
      await git.fetch(w.url, await authForCheckout(kit, w, employeeId)).catch(() => {})
    }
    return behindNote(await git.divergence(w.path, w.base ? { base: w.base } : {}))
  } catch {
    return undefined
  }
}

/** Where read-only ref worktrees live under a session's worktrees directory (not a valid host name, so no checkout's key). */
const REF_WORKTREES_DIR = 'refs@'

export function registerGitTools(kit: Kit, git: GitCache, fs: WorktreeFs): void {
  const { deps } = kit

  /** Instruction files already handed to a session, per checkout (session meta `agentInstructions`). */
  const loadedInstructions = async (sessionId: string, key: string): Promise<Set<string>> => {
    const s = await deps.sessions.require(sessionId)
    const all = (s.data.meta?.agentInstructions ?? {}) as Record<string, string[]>
    return new Set(all[key] ?? [])
  }
  /** Nested AGENTS.md files this call reaches for the first time, as extra output fields. */
  const newInstructions = async (sessionId: string, w: WorktreeMeta, rel: string, isDirectory: boolean) => {
    const found = await nestedInstructions(fs, w.path, rel, await loadedInstructions(sessionId, w.key), { isDirectory })
    if (!found.length) return {}
    await rememberInstructions(
      kit,
      sessionId,
      w.key,
      found.map((f) => f.file),
    )
    return { instructions: { note: INSTRUCTIONS_NOTE, files: found.map(instructionView) } }
  }

  const worktree = async (ctx: ToolContext, repo?: string, sessionId?: string) => {
    const s = await kit.ownSession(sessionId, ctx)
    return worktreeFor(s, repo)
  }

  kit.tool(
    {
      name: 'git.checkout',
      description:
        "Get your own checkout of a project repository: a worktree of the local mirror on a new branch of your own (from the default branch or ref). Calling it again returns the existing checkout and doesn't switch it: to read another branch use projects.read_file { ref }, or env.up { repos: [{ project, ref }] } for a read-only copy of it in an environment. Edit with git.write_file, then git.commit and git.push; changes reach production only through a pull request.",
      effect: 'idempotent',
      params: {
        properties: {
          projectId: { type: 'string' },
          repo: { type: 'number', description: "Index into the project's repositories. Default 0." },
          ref: {
            type: 'string',
            description:
              'Branch or commit your new branch starts from. Default: the default branch. Ignored when you already have a checkout.',
          },
        },
        required: ['projectId'],
      },
    },
    async (a, ctx) => {
      const r = await checkoutRepo(kit, git, fs, ctx, {
        projectId: String(a.projectId ?? ''),
        repoIndex: a.repo ?? 0,
        ...(str(a.ref) ? { ref: str(a.ref)! } : {}),
      })
      if ('failure' in r) return r.failure
      const { w } = r
      if (r.existing) {
        const behind = await behindOf(kit, git, w, ctx.employeeId)
        return ok({
          key: w.key,
          branch: w.branch,
          head: w.baseSha,
          existing: true,
          where: CHECKOUT_NOTE,
          ...(str(a.ref) ? { note: refNotAppliedNote(w, str(a.ref)!) } : {}),
          ...(behind ? { behind } : {}),
        })
      }
      return ok({
        key: w.key,
        branch: w.branch,
        head: w.baseSha,
        where: CHECKOUT_NOTE,
        ...(r.subdir ? { subdir: r.subdir } : {}),
        ...(r.root ? { instructions: { note: INSTRUCTIONS_NOTE, files: [instructionView(r.root)] } } : {}),
      })
    },
  )

  kit.tool(
    {
      name: 'git.status',
      description:
        'Uncommitted changes in your checkout, a merge in progress (from git.sync) with its conflicting files, and whether your base branch has new commits (git.sync brings them in).',
      effect: 'read',
      params: { properties: { repo: repoProp } },
    },
    async (a, ctx) => {
      const w = await worktree(ctx, a.repo)
      const st = await git.status(w.path)
      if (st.merging)
        return ok({
          key: w.key,
          branch: w.branch,
          clean: false,
          files: st.files.slice(0, 200),
          merging: true,
          conflicts: st.conflicts.slice(0, 200),
          note: MERGE_GUIDANCE,
        })
      const behind = await behindOf(kit, git, w, ctx.employeeId)
      return ok({ key: w.key, branch: w.branch, clean: st.clean, files: st.files.slice(0, 200), ...(behind ? { behind } : {}) })
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
        'Commit the changes in your checkout to your branch, as you (your git identity), with trailers linking the commit to this session and the requester. Everything by default; paths commits only those files or directories (the rest stays uncommitted). During a merge from git.sync it finishes the merge (everything, no paths) once the conflicts are fixed. Write a tidy message: a short subject line, then why.',
      effect: 'idempotent',
      params: {
        properties: {
          message: { type: 'string' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only these files or directories (relative to the repository root). Default: everything.',
          },
          repo: repoProp,
        },
        required: ['message'],
      },
    },
    async (a, ctx) => {
      const message = str(a.message)
      if (!message) return fail('message is required')
      const w = await worktree(ctx, a.repo)
      let paths: string[] | undefined
      if (a.paths !== undefined && a.paths !== null) {
        if (!Array.isArray(a.paths) || !a.paths.length || a.paths.some((p: unknown) => typeof p !== 'string'))
          return fail('paths must be a non-empty list of file or directory paths')
        // Outside the checkout or inside .git: DeniedError, as for the file tools.
        paths = [...new Set((a.paths as string[]).map((p) => safeRelPath(w.path, p) || '.'))]
      }
      const before = await git.status(w.path)
      if (before.merging && paths)
        return fail(
          'a merge from git.sync is in progress: a merge commit includes everything, so call git.commit without paths to finish it (or git.sync { abort: true } to back out)',
          { conflicts: before.conflicts },
        )
      let sha: string | null
      try {
        sha = await git.commitAll(w.path, {
          message,
          author: await authorFor(deps, ctx.employeeId),
          trailers: trailersFor(ctx.sessionId, ctx.requesterId),
          ...(paths ? { paths } : {}),
        })
      } catch (err) {
        if (err instanceof ValidationError || err instanceof ConflictError) {
          const markers = /conflict markers/.test(err.message)
          return fail(
            markers ? `${err.message}: fix them with git.edit_file (or in the environment), then git.commit again` : err.message,
            before.merging ? { conflicts: before.conflicts, note: MERGE_GUIDANCE } : {},
          )
        }
        throw err
      }
      if (!sha) return ok({ key: w.key, branch: w.branch, sha: null, note: 'nothing to commit' })
      if (before.merging && w.pendingBaseSha) {
        const base = w.pendingBaseSha
        await patchWorktree(kit, ctx.sessionId, w.key, ({ pendingBaseSha: _, ...rest }) => ({ ...rest, baseSha: base }))
      }
      const after = paths ? await git.status(w.path) : null
      return ok({
        key: w.key,
        branch: w.branch,
        sha,
        ...(before.merging ? { note: 'merge finished: git.push when you are ready' } : {}),
        ...(after?.files.length ? { uncommitted: after.files.slice(0, 200) } : {}),
      })
    },
  )

  kit.tool(
    {
      name: 'git.sync',
      description:
        'Bring new commits into your branch: fetches, then merges (never rebases) your own branch from the remote if it moved (pushed from elsewhere), then your base branch (the default branch, or the ref you checked out from). Merge commits are by you. Your branch stays pushable with a normal git.push. Needs no uncommitted changes. On conflicts the merge is left in progress with conflict markers in the files: fix them, then git.commit; abort: true backs out (git merge --abort).',
      effect: 'idempotent',
      params: {
        properties: {
          repo: repoProp,
          abort: { type: 'boolean', description: 'Abort the merge in progress instead (git merge --abort).' },
        },
      },
    },
    async (a, ctx) => {
      const w = await worktree(ctx, a.repo)
      if (a.abort === true) {
        const aborted = await git.abortMerge(w.path)
        if (w.pendingBaseSha) await patchWorktree(kit, ctx.sessionId, w.key, ({ pendingBaseSha: _, ...rest }) => rest)
        return ok({
          key: w.key,
          branch: w.branch,
          aborted,
          ...(aborted ? { note: 'merge aborted: your branch is back where it was' } : { note: 'no merge in progress' }),
        })
      }
      const st = await git.status(w.path)
      if (st.merging) return fail(`a merge is already in progress. ${MERGE_GUIDANCE}`, { conflicts: st.conflicts })
      if (!st.clean)
        return fail('you have uncommitted changes: commit them (git.commit) first, then git.sync', {
          files: st.files.slice(0, 50),
        })
      const auth = await authForCheckout(kit, w, ctx.employeeId)
      let r: Awaited<ReturnType<GitCache['sync']>>
      try {
        r = await git.sync(w.path, {
          ...(w.base ? { base: w.base } : {}),
          author: await authorFor(deps, ctx.employeeId),
          trailers: trailersFor(ctx.sessionId, ctx.requesterId),
          ...(auth ? { auth } : {}),
        })
      } catch (err) {
        const why = accessFailure(err, w.url, !!auth)
        if (why) return fail(why)
        if (err instanceof ValidationError || err instanceof ConflictError) return fail(err.message)
        throw err
      }
      const baseFrom = (from: string) => !!r.divergence.base && from.endsWith(`/${r.divergence.base.ref}`)
      const baseMerge = r.merged.find((m) => baseFrom(m.from))
      if (baseMerge) await patchWorktree(kit, ctx.sessionId, w.key, (x) => ({ ...x, baseSha: baseMerge.sha }))
      if (r.conflict && baseFrom(r.conflict.from)) {
        const sha = r.conflict.sha
        await patchWorktree(kit, ctx.sessionId, w.key, (x) => ({ ...x, pendingBaseSha: sha }))
      }
      const merged = r.merged.map((m) => ({ from: m.from, commits: m.commits, mode: m.mode }))
      const where = {
        head: r.head,
        ...(r.divergence.base ? { base: r.divergence.base } : {}),
        ...(r.divergence.remote ? { remote: r.divergence.remote } : {}),
      }
      if (r.conflict)
        return ok({
          key: w.key,
          branch: w.branch,
          merged,
          conflict: { from: r.conflict.from, files: r.conflict.files.slice(0, 200) },
          guidance:
            'fix them with git.edit_file or in the environment, then git.commit to finish the merge; git.sync { abort: true } to back out',
          ...where,
        })
      const notes: string[] = []
      if (!merged.length) notes.push('already up to date: nothing new on the remote')
      if (!r.divergence.base && w.base)
        notes.push(`your checkout started from ${w.base}, which is not a branch of the remote: there is no base to merge from`)
      if (r.divergence.remote && r.divergence.remote.ahead > 0) notes.push('git.push to publish your branch')
      return ok({ key: w.key, branch: w.branch, merged, ...where, ...(notes.length ? { note: notes.join('; ') } : {}) })
    },
  )

  kit.tool(
    {
      name: 'git.push',
      description:
        "Push your branch to the remote so you can open a pull request (with the task system or git host tools). Only your own branches can be pushed; protected branches (main, releases) never. For a project hosted by the harness (a local project) there's no pull request: a person merges the branch in the web UI.",
      effect: 'idempotent',
      params: { properties: { repo: repoProp, branch: { type: 'string', description: 'Default: your checkout branch.' } } },
    },
    async (a, ctx) => {
      const w = await worktree(ctx, a.repo)
      const branch = str(a.branch) ?? w.branch
      assertPushAllowed(branch, deps.config.pushPolicy)
      const st = await git.status(w.path)
      if (st.merging) return fail(`can't push while a merge is in progress. ${MERGE_GUIDANCE}`, { conflicts: st.conflicts })
      const slug = localRepoSlug(w.url)
      try {
        await git.push(w.path, branch, deps.config.pushPolicy, slug ? undefined : await gitAuthFor(deps, ctx.employeeId))
      } catch (err) {
        if (err instanceof ConflictError) {
          const behind = /rejected|fast-forward|fetch first/.test(err.message)
          return fail(
            behind
              ? `${err.message}. Your branch on the remote has commits you don't have: git.sync merges them, then git.push again (never force).`
              : err.message,
          )
        }
        throw err
      }
      if (!slug) return ok({ key: w.key, pushed: branch, url: w.url })
      // A local project: no merge request to open. A person merges it in the web UI; this session hears about it.
      const name = branch.replace(/^refs\/heads\//, '')
      await deps.events.subscriptions.subscribe(ctx.sessionId, localBranchSubject(slug, name), {
        primary: true,
        types: ['branch.*'],
        actor: kit.actor(ctx),
      })
      return ok({
        key: w.key,
        pushed: name,
        url: w.url,
        review: LOCAL_REVIEW_NOTE,
      })
    },
  )

  kit.tool(
    {
      name: 'git.read_file',
      description:
        'Read a file in your checkout (path relative to the repository root). For a big file, read the part you need with offset and limit (lines, numbered in the result); find where to look first with env.exec grep -n.',
      effect: 'read',
      params: {
        properties: {
          path: { type: 'string' },
          offset: { type: 'number', description: 'First line to read (1-based).' },
          limit: { type: 'number', description: `How many lines. Default: to the end, at most ${READ_MAX_LINES}.` },
          repo: repoProp,
          sessionId: { type: 'string' },
        },
        required: ['path'],
      },
    },
    async (a, ctx) => {
      const w = await worktree(ctx, a.repo, a.sessionId)
      const rel = safeRelPath(w.path, a.path)
      if (!rel) return fail('path is a directory')
      const content = await fs.read(w.path, rel)
      const extra = await newInstructions(ctx.sessionId, w, rel, false)
      return ok({ path: rel, ...readView(content, a.offset, a.limit), ...extra })
    },
  )

  kit.tool(
    {
      name: 'git.edit_file',
      description:
        'Change part of a file in your checkout: replace an exact piece of text (old, copied from the file with its indentation) with new. old must appear exactly once, unless replaceAll is true; include enough surrounding lines to make it unique. Cheaper and safer than rewriting the file with git.write_file. Commit with git.commit.',
      effect: 'idempotent',
      params: {
        properties: {
          path: { type: 'string' },
          old: { type: 'string', description: 'The exact text to replace.' },
          new: { type: 'string', description: 'The text to put in its place (may be empty).' },
          replaceAll: { type: 'boolean', description: 'Replace every occurrence.' },
          repo: repoProp,
        },
        required: ['path', 'old', 'new'],
      },
    },
    async (a, ctx) => {
      const w = await worktree(ctx, a.repo)
      const rel = safeRelPath(w.path, a.path)
      if (!rel) return fail('path is a directory')
      const oldText = String(a.old ?? '')
      const newText = String(a.new ?? '')
      if (!oldText) return fail('old is empty: to create or replace a whole file, use git.write_file')
      if (oldText === newText) return fail('old and new are the same')
      const content = await fs.read(w.path, rel).catch(() => null)
      if (content === null) return fail(`no file ${rel}: create it with git.write_file`)
      const count = content.split(oldText).length - 1
      if (count === 0) return fail('old was not found in the file: read the part again and copy it exactly, with its indentation')
      if (count > 1 && a.replaceAll !== true)
        return fail(`old appears ${count} times: add surrounding lines to make it unique, or set replaceAll`)
      const next = a.replaceAll === true ? content.split(oldText).join(newText) : content.replace(oldText, () => newText)
      await fs.write(w.path, rel, next)
      const at = content.slice(0, content.indexOf(oldText)).split('\n').length
      return ok({ key: w.key, path: rel, replaced: a.replaceAll === true ? count : 1, line: at, size: next.length })
    },
  )

  kit.tool(
    {
      name: 'git.write_file',
      description:
        'Create or replace a file in your checkout (path relative to the repository root). Commit with git.commit. A file starting with #! (a script, a CLI entry point) is made executable; executable: true or false says so explicitly.',
      effect: 'idempotent',
      params: {
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          executable: {
            type: 'boolean',
            description: 'Set (true) or clear (false) the executable bit. Default: set for #! files, else unchanged.',
          },
          repo: repoProp,
        },
        required: ['path', 'content'],
      },
    },
    async (a, ctx) => {
      const w = await worktree(ctx, a.repo)
      const rel = safeRelPath(w.path, a.path)
      if (!rel) return fail('path is a directory')
      const content = String(a.content)
      await fs.write(w.path, rel, content)
      const executable = typeof a.executable === 'boolean' ? a.executable : content.startsWith('#!') ? true : undefined
      if (executable !== undefined && fs.setExecutable) await fs.setExecutable(w.path, rel, executable)
      return ok({
        key: w.key,
        path: rel,
        size: content.length,
        ...(executable ? { executable: true } : {}),
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
