import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FILES_MOUNT } from '../src/tools/env.ts'
import { stack } from './helpers.ts'

describe('the employee’s files in its environments', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
  })
  const filesDir = async () => {
    const d = await mkdtemp(join(tmpdir(), 'mp-env-files-'))
    dirs.push(d)
    return d
  }

  it('mounts <filesDir>/<employee> at /files, creating it, and says what it is', async () => {
    const root = await filesDir()
    const t = await stack({ filesDir: root })
    const up = await t.out('env.up', { image: 'node:22' })
    const own = join(root, t.employee.id)
    expect(t.containers.created[0]!.mounts).toEqual([{ hostPath: own, containerPath: FILES_MOUNT }])
    expect((await stat(own)).isDirectory()).toBe(true)
    expect(up.files).toBe('/files')
    expect(up.note).toMatch(/\/files in an environment is your filesystem root \(\/files\/a\.zip is \/a\.zip for fs\.\*/)
  })

  it('keeps the checkout mounts and adds /files after them', async () => {
    const root = await filesDir()
    const t = await stack({ filesDir: root })
    await t.out('git.checkout', { projectId: t.project.id })
    await t.out('env.up', { image: 'node:22' })
    const mounts = t.containers.created[0]!.mounts!.map((m) => m.containerPath)
    expect(mounts[0]).toBe('/workspace')
    expect(mounts.at(-1)).toBe('/files')
    expect(t.containers.created[0]!.workdir).toBe('/workspace')
  })

  it('has no /files when the files are not on disk here', async () => {
    const t = await stack()
    const up = await t.out('env.up', { image: 'node:22' })
    expect(t.containers.created[0]!.mounts).toBeUndefined()
    expect(up.files).toBeUndefined()
    expect(up.note).not.toMatch(/\/files/)
  })

  it('tells the model in env.exec’s description', async () => {
    const t = await stack()
    expect(t.tools.list().find((d) => d.name === 'env.exec')?.description).toMatch(/\/files in it is your filesystem root/)
  })
})

describe('env.exec output', () => {
  it('keeps the start and the end of long output, and says how to read all of it', async () => {
    const t = await stack()
    await t.out('env.up', { image: 'node:22' })
    const long = `HEAD-${'a'.repeat(5000)}${'b'.repeat(5000)}-TAIL`
    t.containers.on('build', { stdout: long, stderr: `E-START${'x'.repeat(4000)}E-END` })
    const r = await t.out('env.exec', { cmd: ['build'] })
    expect(r.stdout.startsWith('HEAD-')).toBe(true)
    expect(r.stdout.endsWith('-TAIL')).toBe(true)
    expect(r.stdout).toContain(`[… ${long.length - 6000} characters left out …]`)
    expect(r.stdout.length).toBeLessThan(6100)
    expect(r.stderr.startsWith('E-START')).toBe(true)
    expect(r.stderr.endsWith('E-END')).toBe(true)
    expect(r.note).toBe(
      `output over ${long.length} characters: redirect it to a file (e.g. > /files/out.txt, or in /workspace) and read ranges with fs.read / git.read_file`,
    )
  })

  it('passes short output on whole, without a note', async () => {
    const t = await stack()
    await t.out('env.up', { image: 'node:22' })
    t.containers.on('ls', { stdout: 'a\nb\n' })
    const r = await t.out('env.exec', { cmd: ['ls'] })
    expect(r.stdout).toBe('a\nb\n')
    expect(r.note).toBeUndefined()
  })
})
