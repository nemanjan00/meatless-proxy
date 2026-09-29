/**
 * The contract for a runtime's interactive processes and file copies (`spawn`, `copyIn`, `copyOut`,
 * `features`). Every `ContainerRuntime` that implements them must pass it:
 *
 *   runtimeContract('docker', () => dockerRuntime(...), { image: 'alpine:3' })
 *
 * The image needs `sh` and `cat`. Environments are named `contract-<random>` and destroyed afterwards.
 */
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { ContainerRuntime } from './types.ts'

export function runtimeContract(name: string, make: () => ContainerRuntime, opts: { image: string; timeoutMs?: number }) {
  const timeout = opts.timeoutMs ?? 60_000
  describe(`container runtime contract: ${name}`, () => {
    const created: { rt: ContainerRuntime; id: string }[] = []
    afterEach(async () => {
      for (const c of created.splice(0)) await c.rt.destroyEnv(c.id).catch(() => undefined)
    })
    const env = async () => {
      const rt = make()
      const info = await rt.createEnv({
        name: `contract-${randomBytes(4).toString('hex')}`,
        image: opts.image,
        tmpfs: { '/tmp': { sizeMb: 16 } },
        volumes: ['/work'],
      })
      created.push({ rt, id: info.id })
      return { rt, id: info.id }
    }
    const text = (s: string) => new TextEncoder().encode(s)

    it(
      'copies files and directories in and out, keeping modes and owners',
      async () => {
        const { rt, id } = await env()
        await rt.copyIn!(id, '/work', [
          { path: 'd', type: 'dir', mode: 0o755, uid: 1000, gid: 1000 },
          { path: 'd/a.txt', type: 'file', content: text('hello'), mode: 0o640, uid: 1000, gid: 1000 },
          { path: 'd/sub/b.bin', type: 'file', content: new Uint8Array([0, 1, 255]) },
        ])
        const out = await rt.copyOut!(id, '/work/d')
        const byPath = new Map(out.map((e) => [e.path, e]))
        expect(byPath.get('d')?.type).toBe('dir')
        expect(new TextDecoder().decode(byPath.get('d/a.txt')!.content)).toBe('hello')
        expect(byPath.get('d/a.txt')).toMatchObject({ mode: 0o640, uid: 1000, gid: 1000 })
        expect([...byPath.get('d/sub/b.bin')!.content!]).toEqual([0, 1, 255])
        const one = await rt.copyOut!(id, '/work/d/a.txt')
        expect(one.map((e) => e.path)).toEqual(['a.txt'])
        expect(await rt.copyOut!(id, '/work/missing')).toEqual([])
        // Replacing a file.
        await rt.copyIn!(id, '/work', [{ path: 'd/a.txt', type: 'file', content: text('bye') }])
        expect(new TextDecoder().decode((await rt.copyOut!(id, '/work/d/a.txt'))[0]!.content)).toBe('bye')
      },
      timeout,
    )

    it(
      'spawns a process with stdin, streams its output, and reports its exit',
      async () => {
        const { rt, id } = await env()
        let out = ''
        const p = await rt.spawn!(id, ['cat'], { onOutput: (c) => void (c.stream === 'stdout' && (out += c.text)) })
        await p.write('one\n')
        await p.write(text('two\n'))
        p.end()
        expect(await p.exited).toEqual({ exitCode: 0 })
        expect(out).toBe('one\ntwo\n')
        await expect(p.write('late')).rejects.toThrow()
      },
      timeout,
    )

    it(
      'kills a process that would never end',
      async () => {
        const { rt, id } = await env()
        const p = await rt.spawn!(id, ['cat'])
        await p.write('x\n')
        await p.kill()
        expect((await p.exited).exitCode).toBeNull()
        await p.kill()
      },
      timeout,
    )

    it(
      'reports its features',
      async () => {
        const f = await make().features!()
        expect(typeof f.volumeSubpath).toBe('boolean')
      },
      timeout,
    )
  })
}
