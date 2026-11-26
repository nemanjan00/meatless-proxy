import { describe, expect, it } from 'vitest'
import { gitHint } from '../src/tools/env.ts'

describe('env.exec hints for git', () => {
  it('says how to get a repository when git over https has no credentials, or a copy is read-only', () => {
    expect(gitHint("fatal: could not read Username for 'https://gitlab.example.com': No such device or address")).toContain(
      'env.up { repos',
    )
    expect(gitHint("error: cannot open '/repos/app/.git/FETCH_HEAD': Read-only file system")).toContain('read-only')
    expect(gitHint('error: pathspec did not match')).toBeUndefined()
  })
})

describe('env.exec with no environment', () => {
  it('starts the default profile when there is no checkout, and runs a string through sh -c', async () => {
    const { stack } = await import('./helpers.ts')
    const t = await stack()
    const r = await t.call('env.exec', { cmd: 'curl -s https://example.com | wc -c' })
    expect(r.isError).toBeFalsy()
    expect(t.containers.created).toHaveLength(1)
    expect(t.containers.calls.at(-1)!.cmd).toEqual(['sh', '-c', 'curl -s https://example.com | wc -c'])
  })
})
