import { systemClock, silentLogger } from '@mp/core'
import type { GitAuth, GitCache } from '@mp/git'
import { describe, expect, it } from 'vitest'
import { employeeContext, employeeGit } from '../src/git-store.ts'

describe('the per-employee git store', () => {
  it("hands the employee's SSH key to the cache on every call that talks to the remote", async () => {
    const seen: { op: string; auth: GitAuth | undefined; root: string }[] = []
    const fake = (root: string) =>
      ({
        mirrorPath: (url: string) => `${root}/${url}`,
        ensureMirror: async (_url: string, auth?: GitAuth) => {
          seen.push({ op: 'ensureMirror', auth, root })
          return root
        },
        fetch: async (_url: string, auth?: GitAuth) => void seen.push({ op: 'fetch', auth, root }),
        createWorktree: async (_url: string, o: { auth?: GitAuth }) => {
          seen.push({ op: 'createWorktree', auth: o.auth, root })
          return { path: '/w', head: 'abc', branch: 'b' }
        },
        push: async (_p: string, _b: string, _policy: unknown, auth?: GitAuth) => void seen.push({ op: 'push', auth, root }),
      }) as unknown as GitCache
    const git = employeeGit({ root: '/stores', logger: silentLogger, clock: systemClock, make: (o) => fake(o.root) })
    const auth = { sshPrivateKey: 'KEY' }
    await employeeContext.run({ employeeId: 'emp_1' }, async () => {
      await git.ensureMirror('git@example.com:a/b.git', auth)
      await git.fetch('git@example.com:a/b.git', auth)
      await git.createWorktree('git@example.com:a/b.git', { path: '/w', auth })
      await git.push('/w', 'b', { protectedBranches: [] } as any, auth)
    })
    expect(seen.map((x) => [x.op, x.auth?.sshPrivateKey, x.root])).toEqual([
      ['ensureMirror', 'KEY', '/stores/emp_1'],
      ['fetch', 'KEY', '/stores/emp_1'],
      ['createWorktree', 'KEY', '/stores/emp_1'],
      ['push', 'KEY', '/stores/emp_1'],
    ])
  })
})
