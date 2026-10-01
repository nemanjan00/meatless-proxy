/**
 * Git inside an environment, against a real Docker daemon and real git. Opt-in:
 * `MP_DOCKER_TEST=1 npx vitest run --project node packages/server/test/env-git-docker.test.ts`.
 *
 * An employee checks out a local project, commits and pushes its branch, then brings up one environment
 * with its own checkout and a read-only copy of the pushed branch (env.up repos). Inside, read-only git
 * works (log, show of another branch, status) because each worktree's gitdir (in the mirror) is mounted
 * read-only at the same path; committing inside fails, and the ref's copy can't be written.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@mp/core'
import { dockerRuntime } from '@mp/containers-docker'
import { gitCliCache, gitCliLocalRepos } from '@mp/git-cli'
import Docker from 'dockerode'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testApp, type TestApp } from './helpers.ts'

const ENABLED = process.env.MP_DOCKER_TEST === '1'
const PREFIX = `mp-gtest-${randomBytes(3).toString('hex')}-`
/** Has git; env.up overrides its entrypoint to keep it running. */
const IMAGE = 'alpine/git:latest'

describe.skipIf(!ENABLED)('git inside an environment with real Docker', () => {
  const docker = new Docker()
  let t: TestApp
  let dir: string
  let envId: string | undefined
  let tool: (name: string, args: unknown) => Promise<any>

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mp-env-git-'))
    // Keep the developer's git config, hooks and signing out of it.
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: dir,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    }
    const reposDir = join(dir, 'repos')
    t = await testApp({
      overrides: {
        git: gitCliCache({ root: join(dir, 'git'), env, localReposDir: reposDir }),
        localRepos: gitCliLocalRepos({ root: reposDir, env }),
        containers: dockerRuntime({ namePrefix: PREFIX }),
      },
    })
    const s = t.a.services
    const employee = (await s.directory.employees.byHandle('meatless'))!
    const ses = await s.sessions.create({ employeeId: employee.id, title: 'Read the docs' })
    tool = async (name, args) => {
      const callId = newId('call')
      const r = await s.tools.execute(name, args, {
        employeeId: employee.id,
        sessionId: ses.id,
        runId: 'run_docker',
        callId,
        idempotencyKey: `run_docker:0:${callId}`,
        secrets: {},
        signal: new AbortController().signal,
        logger: s.logger,
        clock: s.clock,
        emit: () => {},
      })
      if (r.isError && name !== 'env.exec') throw new Error(`${name}: ${JSON.stringify(r.output)}`)
      return r.output
    }
  }, 60_000)

  afterAll(async () => {
    if (envId) await t.a.services.containers!.destroyEnv(envId).catch(() => undefined)
    await t?.close()
    for (const c of await docker.listContainers({ all: true }))
      if (c.Names.some((n) => n.replace(/^\//, '').startsWith(PREFIX)))
        await docker
          .getContainer(c.Id)
          .remove({ force: true })
          .catch(() => undefined)
    for (const n of await docker.listNetworks())
      if (n.Name.startsWith(PREFIX))
        await docker
          .getNetwork(n.Id)
          .remove()
          .catch(() => undefined)
    // The containers ran as root and may have left files the test user can't remove: best effort.
    rmSync(dir, { recursive: true, force: true, maxRetries: 2 })
  }, 60_000)

  it('runs git log, show and status inside, and refuses commits there', async () => {
    const { projectId } = await tool('projects.create_local', { name: 'Docs demo' })
    const co = await tool('git.checkout', { projectId })
    await tool('git.write_file', { path: 'README.md', content: '# Docs demo\n\nLunch anyone?\n' })
    await tool('git.commit', { message: 'Add the README' })
    await tool('git.push', {})

    const up = await tool('env.up', { image: IMAGE, repos: [projectId, { project: projectId, ref: co.branch }] })
    envId = up.envId
    const copy = up.repos.find((r: any) => r.ref === co.branch)
    expect(copy).toMatchObject({ writable: false })
    const sh = (script: string) => tool('env.exec', { cmd: ['sh', '-c', script] })

    const log = await sh('git log --oneline -3')
    expect(log.exitCode, log.stderr).toBe(0)
    expect(log.stdout).toContain('Add the README')
    // Another branch, from the checkout: what failed with "not a git repository" before.
    const show = await sh(`git show origin/${co.branch}:README.md`)
    expect(show.exitCode, show.stderr).toBe(0)
    expect(show.stdout).toContain('Lunch anyone?')
    const status = await sh('git status --short && git branch -a')
    expect(status.exitCode, status.stderr).toBe(0)
    expect(status.stdout).toContain(co.branch)
    // The read-only copy of the branch: git works, writing doesn't.
    const inCopy = await sh(`cd ${copy.path} && git log --oneline -1 && cat README.md`)
    expect(inCopy.exitCode, inCopy.stderr).toBe(0)
    expect(inCopy.stdout).toContain('Lunch anyone?')
    expect((await sh(`touch ${copy.path}/new.txt`)).exitCode).not.toBe(0)

    // Commits go through git.commit: inside, the gitdir is read-only.
    const commit = await sh('echo x > note.txt && git add note.txt && git -c user.name=A -c user.email=a@example.com commit -m x')
    expect(commit.exitCode).not.toBe(0)
    expect(commit.stderr).toMatch(/read-only file system/i)
    // The file written in the checkout is there for git.commit to pick up.
    expect((await tool('git.status', {})).files.join(' ')).toContain('note.txt')
  }, 180_000)
})
