/**
 * Local projects (src/local-projects): repositories the harness hosts itself. Creating one, the
 * review page's data, merging (fast-forward, merge commit, conflicts), who may merge, that no
 * employee can, browsing, and attaching a remote. Real git in temp dirs; an employee's pushes are
 * made with a real git CLI cache pointed at the same repositories.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitCliCache, gitCliLocalRepos } from '@mp/git-cli'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalProjectForEmployee } from '../src/local-projects/index.ts'
import { createMcpToken } from '../src/tokens.ts'
import { type TestApp, testApp } from './helpers.ts'

let t: TestApp
let base: string
let reposDir: string
let gitEnv: Record<string, string>
let employeeId: string
let aiContactId: string
let member: Record<string, string>
let memberId: string
let viewer: Record<string, string>
let reviewerId: string
let reviewer: Record<string, string>
let n = 0

const policy = { allow: ['mp/**'], protected: ['main', 'master', 'production', 'release/**'] }
const bot = { name: 'Billing Bot', email: 'billing-bot@example.com' }
const git = (args: string[], cwd?: string) =>
  execFileSync('git', ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', ...args], {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
  }).trim()

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'mp-local-projects-'))
  reposDir = join(base, 'repos')
  gitEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: base,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  }
  t = await testApp({
    env: { LOCAL_REPOS_DIR: reposDir },
    overrides: { localRepos: gitCliLocalRepos({ root: reposDir, env: gitEnv }) },
  })
  const s = t.a.services
  const e = (await s.directory.employees.byHandle('meatless'))!
  employeeId = e.id
  aiContactId = e.data.contactId
  memberId = (await s.directory.contacts.create({ name: 'Mia', kind: 'person', email: 'mia@example.com' })).id
  member = await t.as(memberId, { access: 'member' })
  reviewerId = (await s.directory.contacts.create({ name: 'Rita Reviewer', kind: 'person', email: 'rita@example.com' })).id
  reviewer = await t.as(reviewerId, { access: 'member' })
  const vic = await s.directory.contacts.create({ name: 'Vic', kind: 'person' })
  viewer = await t.as(vic.id, { access: 'viewer' })
})
afterAll(async () => {
  await t.close()
  rmSync(base, { recursive: true, force: true })
})

/** A new local project (as the admin) with Rita as a reviewer. */
async function newProject() {
  const r = await t.req('POST', '/api/projects/local', {
    name: `Local ${++n}`,
    members: [{ contactId: reviewerId, role: 'reviewer' }],
  })
  expect(r.status).toBe(201)
  const url: string = r.body.project.data.repositories[0].url
  return { id: r.body.project.id as string, url, slug: url.slice('local:'.length) }
}

/** The employee's own git cache, like its runs use: pushes a branch with one file. */
async function push(url: string, branch: string, file: string, content: string) {
  const c = gitCliCache({ root: join(base, 'cache'), env: gitEnv, localReposDir: reposDir })
  await c.fetch(url)
  const path = join(base, 'wt', `${++n}`)
  await c.createWorktree(url, { path, newBranch: branch })
  await writeFile(join(path, file), content)
  const sha = await c.commitAll(path, { message: `add ${file}`, author: bot })
  await c.push(path, branch, policy)
  return { sha: sha!, path, cache: c }
}

describe('creating a local project', () => {
  it('admins create one: a repository with an empty commit on main, and the project on it', async () => {
    const r = await t.req('POST', '/api/projects/local', { name: 'Invoice Parser', description: 'Parses invoices.' })
    expect(r.status).toBe(201)
    expect(r.body.project.data).toMatchObject({
      name: 'Invoice Parser',
      description: 'Parses invoices.',
      repositories: [{ url: 'local:invoice-parser', defaultBranch: 'main' }],
    })
    expect(existsSync(join(reposDir, 'invoice-parser.git', 'HEAD'))).toBe(true)
    expect(git(['--git-dir', join(reposDir, 'invoice-parser.git'), 'log', '--format=%s', 'main'])).toBe(
      'Initial commit of Invoice Parser',
    )
    const local = await t.req('GET', `/api/projects/${r.body.project.id}/local`)
    expect(local.body).toMatchObject({ slug: 'invoice-parser', url: 'local:invoice-parser', defaultBranch: 'main', branches: [] })
    expect(local.body).toMatchObject({ canMerge: true, canAttachRemote: true })
  })

  it('refuses a taken name without leaving a repository, bad slugs, members, and local: urls elsewhere', async () => {
    await t.req('POST', '/api/projects/local', { name: 'Taken' })
    const again = await t.req('POST', '/api/projects/local', { name: 'Taken', slug: 'taken-2' })
    expect(again.status).toBe(409)
    expect(existsSync(join(reposDir, 'taken-2.git'))).toBe(false)
    for (const slug of ['../escape', 'a/b', '..', 'UPPER', '-x'])
      expect((await t.req('POST', '/api/projects/local', { name: `Slug ${slug}`, slug })).status, slug).toBe(422)
    expect(existsSync(join(base, 'escape.git'))).toBe(false)
    expect((await t.req('POST', '/api/projects/local', { name: 'By a member' }, member)).status).toBe(403)
    // Linking a local repository to a project is refused: they are made with the project.
    const linked = await t.req('POST', '/api/projects', { name: 'Linker', repositories: ['local:taken'] }, member)
    expect(linked.status).toBe(422)
  })

  it('a second project of the same name gets a free slug', async () => {
    const a = await t.req('POST', '/api/projects/local', { name: 'Same name?' })
    const s = t.a.services
    await s.records.delete('project', a.body.project.id)
    const b = await t.req('POST', '/api/projects/local', { name: 'Same name?' })
    expect(b.body.project.data.repositories[0].url).toBe('local:same-name-2')
  })

  it('employees create one through the stdlib dependency and become a member', async () => {
    const r = await createLocalProjectForEmployee(t.a.services, {
      name: 'Bot Project',
      employeeId,
      actor: { type: 'contact', id: aiContactId },
    })
    expect(r).toMatchObject({ name: 'Bot Project', url: 'local:bot-project', defaultBranch: 'main' })
    const people = await t.req('GET', `/api/projects/${r.projectId}/people`)
    expect(people.body.people).toEqual([expect.objectContaining({ contactId: aiContactId, roles: ['member'] })])
    expect(git(['--git-dir', join(reposDir, 'bot-project.git'), 'log', '--format=%an', 'main'])).toBe('Meatless')
  })
})

describe('review and merge', () => {
  it('lists pushed branches with the diff, and fast-forwards', async () => {
    const p = await newProject()
    const { sha } = await push(p.url, 'mp/meatless/refunds', 'refund.ts', 'export const refund = 1\n')
    const local = await t.req('GET', `/api/projects/${p.id}/local`, undefined, viewer)
    expect(local.body.branches).toEqual([expect.objectContaining({ name: 'mp/meatless/refunds', sha, ahead: 1, behind: 0 })])
    expect(local.body.canMerge).toBe(false)
    const cmp = await t.req('GET', `/api/projects/${p.id}/local/compare?branch=${encodeURIComponent('mp/meatless/refunds')}`)
    expect(cmp.body).toMatchObject({ ahead: 1, fastForward: true, files: [{ status: 'A', path: 'refund.ts' }] })
    expect(cmp.body.diff).toContain('+export const refund = 1')
    expect(cmp.body.commits.map((c: { subject: string }) => c.subject)).toEqual(['add refund.ts'])

    const m = await t.req('POST', `/api/projects/${p.id}/local/merge`, { branch: 'mp/meatless/refunds' }, reviewer)
    expect(m.status).toBe(200)
    expect(m.body).toEqual({ branch: 'mp/meatless/refunds', into: 'main', sha, mode: 'fast-forward' })
    expect(git(['--git-dir', join(reposDir, `${p.slug}.git`), 'rev-parse', 'main'])).toBe(sha)
    const again = await t.req('POST', `/api/projects/${p.id}/local/merge`, { branch: 'mp/meatless/refunds' }, reviewer)
    expect(again.status).toBe(422)
  })

  it('makes a merge commit when main moved on, by the person who merged', async () => {
    const p = await newProject()
    await push(p.url, 'mp/meatless/a', 'a.txt', 'a\n')
    await push(p.url, 'mp/meatless/b', 'b.txt', 'b\n')
    expect((await t.req('POST', `/api/projects/${p.id}/local/merge`, { branch: 'mp/meatless/a' })).body.mode).toBe('fast-forward')
    const m = await t.req('POST', `/api/projects/${p.id}/local/merge`, { branch: 'mp/meatless/b' }, reviewer)
    expect(m.body.mode).toBe('merge-commit')
    expect(git(['--git-dir', join(reposDir, `${p.slug}.git`), 'log', '-1', '--format=%an <%ae>', 'main'])).toBe(
      'Rita Reviewer <rita@example.com>',
    )
  })

  it('reports conflicts with the files and changes nothing', async () => {
    const p = await newProject()
    await push(p.url, 'mp/meatless/one', 'same.txt', 'one\n')
    await push(p.url, 'mp/meatless/two', 'same.txt', 'two\n')
    await t.req('POST', `/api/projects/${p.id}/local/merge`, { branch: 'mp/meatless/one' })
    const before = git(['--git-dir', join(reposDir, `${p.slug}.git`), 'rev-parse', 'main'])
    const m = await t.req('POST', `/api/projects/${p.id}/local/merge`, { branch: 'mp/meatless/two' })
    expect(m.status).toBe(409)
    expect(m.body.error.message).toMatch(/conflict/)
    expect(m.body.error.details).toMatchObject({ files: ['same.txt'] })
    expect(git(['--git-dir', join(reposDir, `${p.slug}.git`), 'rev-parse', 'main'])).toBe(before)
  })

  it('tells the pushing session: a branch.merged event on the branch subject', async () => {
    const p = await newProject()
    const { sha } = await push(p.url, 'mp/meatless/evt', 'e.txt', 'e\n')
    await t.req('POST', `/api/projects/${p.id}/local/merge`, { branch: 'mp/meatless/evt' }, reviewer)
    await t.settle()
    const events = await t.a.services.events.query({ source: 'local-git' })
    expect(events.map((e) => [e.data.type, e.data.subject])).toContainEqual([
      'branch.merged',
      { system: 'local-git', id: `${p.slug}/mp/meatless/evt` },
    ])
    const e = events.find((x) => x.data.subject?.id === `${p.slug}/mp/meatless/evt`)!
    expect(e.data).toMatchObject({
      actorContactId: reviewerId,
      payload: { branch: 'mp/meatless/evt', sha, mode: 'fast-forward' },
    })
  })

  it('deletes branches (not main), with the same permission', async () => {
    const p = await newProject()
    await push(p.url, 'mp/meatless/gone', 'g.txt', 'g\n')
    expect(
      (await t.req('POST', `/api/projects/${p.id}/local/branches/delete`, { branch: 'mp/meatless/gone' }, member)).status,
    ).toBe(403)
    expect((await t.req('POST', `/api/projects/${p.id}/local/branches/delete`, { branch: 'main' }, reviewer)).status).toBe(422)
    const d = await t.req('POST', `/api/projects/${p.id}/local/branches/delete`, { branch: 'mp/meatless/gone' }, reviewer)
    expect(d.status).toBe(200)
    expect(d.body.branches).toEqual([])
    await t.settle()
    const events = await t.a.services.events.query({ source: 'local-git', type: 'branch.deleted' })
    expect(events.some((e) => e.data.subject?.id === `${p.slug}/mp/meatless/gone`)).toBe(true)
  })

  it('404s for projects without a local repository', async () => {
    const r = await t.req('POST', '/api/projects', { name: 'Remote only', repositories: ['git@gitlab.example.com:acme/x.git'] })
    expect((await t.req('GET', `/api/projects/${r.body.project.id}/local`)).status).toBe(404)
    expect((await t.req('POST', `/api/projects/${r.body.project.id}/local/merge`, { branch: 'mp/x' })).status).toBe(404)
  })
})

describe('who may merge', () => {
  it('viewers, members without a merge role, and plain project members may not', async () => {
    const p = await newProject()
    await push(p.url, 'mp/meatless/perm', 'p.txt', 'p\n')
    const body = { branch: 'mp/meatless/perm' }
    expect((await t.req('POST', `/api/projects/${p.id}/local/merge`, body, viewer)).status).toBe(403)
    expect((await t.req('POST', `/api/projects/${p.id}/local/merge`, body, member)).status).toBe(403)
    // A member role on the project isn't enough.
    await t.req('POST', `/api/projects/${p.id}/people`, { contactId: memberId, role: 'member' })
    const denied = await t.req('POST', `/api/projects/${p.id}/local/merge`, body, member)
    expect(denied.status).toBe(403)
    expect(denied.body.error.message).toMatch(/owner, backup, reviewers/)
    expect(git(['--git-dir', join(reposDir, `${p.slug}.git`), 'rev-list', '--count', 'main'])).toBe('1')
    // Given a merge role by an admin, they may.
    await t.req('POST', `/api/projects/${p.id}/people`, { contactId: memberId, role: 'owner' })
    expect((await t.req('POST', `/api/projects/${p.id}/local/merge`, body, member)).status).toBe(200)
  })

  it("members can't hand themselves a merge role on a local project, by any route", async () => {
    const p = await newProject()
    const mine = await t.req('POST', `/api/projects/${p.id}/people`, { contactId: memberId, role: 'owner' }, member)
    expect(mine.status).toBe(403)
    const link = await t.req(
      'POST',
      `/api/records/contact/${memberId}/links`,
      { to: { kind: 'project', id: p.id }, role: 'reviewer' },
      member,
    )
    expect(link.status).toBe(403)
    // Plain membership is still theirs to give.
    expect((await t.req('POST', `/api/projects/${p.id}/people`, { contactId: memberId, role: 'member' }, member)).status).toBe(
      200,
    )
    // Someone who can merge there may give the role.
    expect((await t.req('POST', `/api/projects/${p.id}/people`, { contactId: memberId, role: 'backup' }, reviewer)).status).toBe(
      200,
    )
  })

  it("members can't point a project they own at a local repository", async () => {
    const p = await newProject()
    const own = await t.req('POST', '/api/projects', { name: `Mine ${++n}`, owner: { contactId: memberId } }, member)
    expect(own.status).toBe(201)
    const patch = await t.req(
      'PATCH',
      `/api/records/project/${own.body.project.id}`,
      { data: { repositories: [{ url: p.url }] } },
      member,
    )
    expect(patch.status).toBe(403)
    const create = await t.req(
      'POST',
      '/api/records/project',
      { data: { name: `Rec ${++n}`, repositories: [{ url: p.url }] } },
      member,
    )
    expect(create.status).toBe(403)
    // Editing other fields of a local project, with its repositories unchanged, is fine.
    const same = await t.req(
      'PATCH',
      `/api/records/project/${p.id}`,
      { data: { description: 'Better.', repositories: [{ url: p.url, defaultBranch: 'main' }] } },
      member,
    )
    expect(same.status).toBe(200)
  })

  it('an employee can never merge: AI contacts never sign in, even as an owner, and no tool merges', async () => {
    const p = await newProject()
    await push(p.url, 'mp/meatless/self', 's.txt', 's\n')
    await t.req('POST', `/api/projects/${p.id}/people`, { employeeId, role: 'owner' })
    const { token } = await createMcpToken(t.a.services, aiContactId, 'test')
    const headers = { authorization: `Bearer ${token}` }
    for (const [method, path] of [
      ['POST', `/api/projects/${p.id}/local/merge`],
      ['POST', `/api/projects/${p.id}/local/branches/delete`],
      ['POST', `/api/projects/${p.id}/local/remote`],
      ['POST', '/api/projects/local'],
    ] as const) {
      const r = await t.req(method, path, { branch: 'mp/meatless/self', url: 'file:///tmp/x.git', name: 'x' }, headers)
      expect(r.status, path).toBe(401)
    }
    expect(git(['--git-dir', join(reposDir, `${p.slug}.git`), 'rev-list', '--count', 'main'])).toBe('1')
    const tools = t.a.services.tools.list().map((x) => x.name)
    expect(tools).toContain('projects.create_local')
    // GitLab's MR tools open and discuss merge requests; none merges (it has no merge tool on purpose).
    expect(tools.filter((x) => /merge(?!_request)|accept/i.test(x))).toEqual([])
  })
})

describe('browsing main', () => {
  it('lists directories and reads files, refusing paths outside the repository', async () => {
    const p = await newProject()
    await push(p.url, 'mp/meatless/docs', 'README.md', '# Hello\n')
    await t.req('POST', `/api/projects/${p.id}/local/merge`, { branch: 'mp/meatless/docs' })
    const tree = await t.req('GET', `/api/projects/${p.id}/local/tree`, undefined, viewer)
    expect(tree.body).toMatchObject({ path: '', ref: 'main', entries: [{ name: 'README.md', type: 'file', size: 8 }] })
    const file = await t.req('GET', `/api/projects/${p.id}/local/file?path=README.md`, undefined, viewer)
    expect(file.body).toMatchObject({ content: '# Hello\n', binary: false })
    expect((await t.req('GET', `/api/projects/${p.id}/local/file?path=${encodeURIComponent('../../etc/passwd')}`)).status).toBe(
      422,
    )
    expect((await t.req('GET', `/api/projects/${p.id}/local/file?path=nope`)).status).toBe(404)
  })
})

describe('attaching a remote', () => {
  it('pushes every branch to an empty remote and makes it the repository (admins only)', async () => {
    const p = await newProject()
    const { sha } = await push(p.url, 'mp/meatless/wip', 'w.txt', 'w\n')
    const remote = join(base, `remote-${++n}.git`)
    mkdirSync(remote)
    git(['init', '--quiet', '--bare', '-b', 'main', remote])
    const url = `file://${remote}`
    expect((await t.req('POST', `/api/projects/${p.id}/local/remote`, { url }, reviewer)).status).toBe(403)
    const bad = await t.req('POST', `/api/projects/${p.id}/local/remote`, {
      url: 'https://oauth2@gitlab.example.com/a/b.git',
    })
    expect(bad.status).toBe(422)
    expect(bad.body.error.message).toMatch(/credentials/)
    const r = await t.req('POST', `/api/projects/${p.id}/local/remote`, { url })
    expect(r.status).toBe(200)
    expect(r.body.branches.sort()).toEqual(['main', 'mp/meatless/wip'])
    expect(r.body.project.data.repositories).toEqual([{ url, defaultBranch: 'main', previousUrl: p.url }])
    expect(git(['--git-dir', remote, 'rev-parse', 'refs/heads/mp/meatless/wip'])).toBe(sha)
    // It is a remote project now: no local review page; the local repository is kept.
    expect((await t.req('GET', `/api/projects/${p.id}/local`)).status).toBe(404)
    expect(existsSync(join(reposDir, `${p.slug}.git`, 'HEAD'))).toBe(true)
  })

  it('refuses a remote with other history, clearly', async () => {
    const p = await newProject()
    const remote = join(base, `busy-${++n}.git`)
    const seed = join(base, `seed-${n}`)
    git(['init', '--quiet', '--bare', '-b', 'main', remote])
    git(['init', '--quiet', '-b', 'main', seed])
    await writeFile(join(seed, 'x'), 'x')
    git(['add', '-A'], seed)
    git(['commit', '--quiet', '-m', 'theirs'], seed)
    git(['push', '--quiet', remote, 'main'], seed)
    const r = await t.req('POST', `/api/projects/${p.id}/local/remote`, { url: `file://${remote}` })
    expect(r.status).toBe(409)
    expect(r.body.error.message).toMatch(/other history/)
    // Nothing changed on the project.
    expect((await t.req('GET', `/api/projects/${p.id}/local`)).status).toBe(200)
  })
})
