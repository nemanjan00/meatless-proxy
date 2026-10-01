import { NotFoundError } from '@mp/core'
import { globMatch } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLSET, ROUTER_EXCLUDED_TOOLS } from '../src/index.ts'
import { stack, type Stack } from './helpers.ts'

/**
 * A local repository like the ones the harness hosts: an empty main (only the first, empty commit) and the
 * work on a branch waiting for review. Files by ref, as `LocalRepos.readFile` and `tree` would return them.
 */
function fakeRepo(t: Stack, files: Record<string, Record<string, string>>) {
  const lp = t.deps.localProjects!
  const refOf = (ref?: string) => {
    const r = ref ?? 'main'
    if (!files[r]) throw new NotFoundError('ref', r)
    return r
  }
  lp.branches = async () => ({
    defaultBranch: 'main',
    branches: Object.keys(files)
      .filter((b) => b !== 'main')
      .map((name) => ({ name, sha: 'b2', ahead: 2, behind: 0, subject: 'Add docs', author: 'Bo', date: '2026-09-29T19:00:00Z' })),
  })
  lp.readFile = async (_slug, o) => {
    const ref = refOf(o.ref)
    const content = files[ref]![o.path]
    if (content === undefined) throw new NotFoundError('file', o.path)
    const size = Buffer.byteLength(content)
    if (o.maxBytes !== undefined && size > o.maxBytes)
      return { path: o.path, ref, size, binary: false, tooLarge: true, content: null }
    const binary = content.includes('\0')
    return { path: o.path, ref, size, binary, tooLarge: false, content: binary ? null : content }
  }
  lp.tree = async (_slug, o = {}) => {
    const ref = refOf(o.ref)
    const prefix = o.path ? `${o.path}/` : ''
    const names = Object.keys(files[ref]!).filter((p) => p.startsWith(prefix))
    if (o.path && !names.length) throw new NotFoundError('path', o.path)
    const entries = [...new Set(names.map((p) => p.slice(prefix.length).split('/')[0]!))].map((name) =>
      names.some((p) => p.startsWith(`${prefix}${name}/`)) ? { name, type: 'dir' as const } : { name, type: 'file' as const },
    )
    return { path: o.path ?? '', ref, entries }
  }
}

describe('projects.read_file and projects.list_files', () => {
  it('reads a file on a branch while main is empty, without a checkout', async () => {
    const t = await stack()
    const { projectId } = await t.out('projects.create_local', { name: 'Parser' })
    fakeRepo(t, { main: {}, 'mp/bo/docs': { 'README.md': '# Parser\n\nParses invoices.\n', 'src/index.ts': 'export {}\n' } })
    const r = await t.out('projects.read_file', { projectId, path: 'README.md', ref: 'mp/bo/docs' })
    expect(r).toMatchObject({
      project: 'Parser',
      path: 'README.md',
      ref: 'mp/bo/docs',
      content: '# Parser\n\nParses invoices.\n',
    })
    const ls = await t.out('projects.list_files', { projectId, ref: 'mp/bo/docs' })
    expect(ls.entries).toEqual(['README.md', 'src/'])
    expect((await t.out('projects.list_files', { projectId, ref: 'mp/bo/docs', path: 'src' })).entries).toEqual(['index.ts'])
    expect(t.git.worktrees()).toHaveLength(0)
  })

  it('says when main is empty and names the branches waiting for review', async () => {
    const t = await stack()
    const { projectId } = await t.out('projects.create_local', { name: 'Parser' })
    fakeRepo(t, { main: {}, 'mp/bo/docs': { 'README.md': '# Parser\n' } })
    const ls = await t.out('projects.list_files', { projectId })
    expect(ls.entries).toEqual([])
    expect(ls.hint).toBe('main is empty; work is on mp/bo/docs (ahead 2), waiting for review: pass ref')
    const r = await t.call('projects.read_file', { projectId, path: 'README.md' })
    expect(r.isError).toBe(true)
    expect(r.output).toMatchObject({ hint: expect.stringContaining('main is empty; work is on mp/bo/docs (ahead 2)') })
    // A file that isn't on a non-empty main: the branches to look at.
    fakeRepo(t, { main: { LICENSE: 'MIT' }, 'mp/bo/docs': { 'README.md': '# Parser\n' } })
    const missing = await t.call('projects.read_file', { projectId, path: 'README.md' })
    expect((missing.output as { hint: string }).hint).toMatch(
      /README\.md is not on main; branches waiting for review: mp\/bo\/docs/,
    )
    // No hint when a ref was given; an unknown ref is said plainly.
    const onRef = await t.call('projects.read_file', { projectId, path: 'nope.md', ref: 'mp/bo/docs' })
    expect(onRef.isError).toBe(true)
    expect((onRef.output as { hint?: string }).hint).toBeUndefined()
    const badRef = await t.call('projects.read_file', { projectId, path: 'README.md', ref: 'mp/nope' })
    expect(JSON.stringify(badRef.output)).toContain('no branch or commit mp/nope')
  })

  it('numbers lines of a range, flags binary files and caps big ones', async () => {
    const t = await stack()
    const { projectId } = await t.out('projects.create_local', { name: 'Parser' })
    const body = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n')
    fakeRepo(t, { main: { 'big.txt': body, 'logo.png': 'PNG\0\0data', 'huge.txt': 'x'.repeat(1_000_001) } })
    const part = await t.out('projects.read_file', { projectId, path: 'big.txt', offset: 10, limit: 2 })
    expect(part).toMatchObject({
      totalLines: 50,
      lines: '10-11',
      content: '10\tline 10\n11\tline 11',
      next: expect.stringMatching(/offset 12/),
    })
    expect(await t.out('projects.read_file', { projectId, path: 'logo.png' })).toMatchObject({ binary: true })
    expect((await t.out('projects.read_file', { projectId, path: 'logo.png' })).content).toBeUndefined()
    expect(await t.out('projects.read_file', { projectId, path: 'huge.txt' })).toMatchObject({ tooLarge: true })
  })

  it('points a project on a git host at its own tools', async () => {
    const t = await stack()
    const r = await t.call('projects.read_file', { projectId: t.project.id, path: 'README.md' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('mcp.gitlab.get_file')
    expect(JSON.stringify((await t.call('projects.list_files', { projectId: t.project.id })).output)).toContain(
      'mcp.gitlab.list_tree',
    )
    expect((await t.call('projects.read_file', { projectId: 'prj_nope', path: 'a' })).isError).toBe(true)
  })

  it('are in the default toolset and kept for routers (read-only)', () => {
    for (const name of ['projects.read_file', 'projects.list_files']) {
      expect(DEFAULT_TOOLSET).toContain(name)
      expect(ROUTER_EXCLUDED_TOOLS.some((p) => globMatch(p, name))).toBe(false)
    }
  })
})

describe('git.checkout with a ref on an existing checkout', () => {
  it("doesn't switch, and says the ref was not applied and how to read it", async () => {
    const t = await stack()
    const first = await t.out('git.checkout', { projectId: t.project.id })
    const again = await t.out('git.checkout', { projectId: t.project.id, ref: 'mp/bo/docs' })
    expect(again).toMatchObject({ existing: true, branch: first.branch, head: first.head })
    expect(again.note).toContain(
      `already checked out on your branch ${first.branch} (from main); ref mp/bo/docs was not applied`.replace(/^a/, 'A'),
    )
    expect(again.note).toContain('projects.read_file')
    expect(again.note).toContain('env.up { repos: [{ project, ref }] }')
    expect(t.git.worktrees()).toHaveLength(1)
    // Without a ref, no note.
    expect((await t.out('git.checkout', { projectId: t.project.id })).note).toBeUndefined()
  })
})
