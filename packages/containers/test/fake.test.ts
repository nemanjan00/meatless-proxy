import { ConflictError, ManualClock, NotFoundError, ValidationError } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { ExecAbortedError, TIMEOUT_EXIT_CODE, fakeRuntime } from '../src/index.ts'

const spec = { name: 'ses-1', image: 'node:22', labels: { session: 'ses_1' } }

describe('fakeRuntime environments', () => {
  it('creates, gets, lists and destroys environments', async () => {
    const clock = new ManualClock()
    const rt = fakeRuntime({ clock })
    const env = await rt.createEnv(spec)
    expect(env).toMatchObject({ name: 'ses-1', status: 'running', createdAt: clock.iso() })
    expect(env.labels).toEqual({ session: 'ses_1', 'mp.env': 'ses-1', 'mp.managed': 'true' })
    expect(await rt.getEnv(env.id)).toEqual(env)
    const other = await rt.createEnv({ name: 'ses-2', image: 'node:22' })
    expect((await rt.listEnvs()).map((e) => e.id)).toEqual([env.id, other.id])
    expect((await rt.listEnvs({ session: 'ses_1' })).map((e) => e.id)).toEqual([env.id])
    expect(await rt.listEnvs({ session: 'nope' })).toEqual([])
    await rt.destroyEnv(env.id)
    await rt.destroyEnv(env.id)
    expect(await rt.getEnv(env.id)).toBeNull()
    expect(rt.envs().map((e) => e.info.id)).toEqual([other.id])
    expect(rt.created).toHaveLength(2)
  })

  it('validates specs and rejects duplicate names', async () => {
    const rt = fakeRuntime()
    await expect(rt.createEnv({ name: 'x' })).rejects.toBeInstanceOf(ValidationError)
    await rt.createEnv(spec)
    await expect(rt.createEnv(spec)).rejects.toBeInstanceOf(ConflictError)
  })

  it('can fail the next create', async () => {
    const rt = fakeRuntime()
    rt.failNextCreate(new Error('boom'))
    await expect(rt.createEnv(spec)).rejects.toThrow('boom')
    await expect(rt.createEnv(spec)).resolves.toBeTruthy()
  })

  it('returns copies, not internal state', async () => {
    const rt = fakeRuntime()
    const env = await rt.createEnv(spec)
    env.labels.session = 'changed'
    expect((await rt.getEnv(env.id))!.labels.session).toBe('ses_1')
  })

  it('keeps logs with tail', async () => {
    const rt = fakeRuntime()
    const env = await rt.createEnv(spec)
    expect(await rt.logs(env.id)).toBe('')
    rt.appendLog(env.id, 'a\nb\n')
    rt.appendLog(env.id, 'c\n')
    expect(await rt.logs(env.id)).toBe('a\nb\nc\n')
    expect(await rt.logs(env.id, { tail: 2 })).toBe('b\nc\n')
    expect(await rt.logs(env.id, { tail: 0 })).toBe('')
    await expect(rt.logs('env_missing')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('fakeRuntime exec', () => {
  it('records calls and answers 0 by default', async () => {
    const rt = fakeRuntime()
    const env = await rt.createEnv(spec)
    const r = await rt.exec(env.id, ['ls', '-la'], { env: { A: '1' }, workdir: '/src', timeoutMs: 1000 })
    expect(r).toEqual({ exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 0 })
    expect(rt.calls).toMatchObject([{ envId: env.id, cmd: ['ls', '-la'], env: { A: '1' }, workdir: '/src', timeoutMs: 1000 }])
  })

  it('scripts responses by regex, string and predicate; later rules win', async () => {
    const rt = fakeRuntime()
    const env = await rt.createEnv(spec)
    rt.on(/npm test/, { exitCode: 1, stdout: 'failing\n', stderr: 'err\n' })
    rt.on('npm run build', { stdout: 'built' })
    rt.on(
      (cmd) => cmd[0] === 'echo',
      (call) => ({ stdout: call.cmd.slice(1).join(' ') }),
    )
    expect(await rt.exec(env.id, ['sh', '-c', 'npm test'])).toMatchObject({ exitCode: 1, stdout: 'failing\n', stderr: 'err\n' })
    expect(await rt.exec(env.id, ['sh', '-c', 'npm run build'])).toMatchObject({ exitCode: 0, stdout: 'built' })
    expect((await rt.exec(env.id, ['echo', 'hi', 'there'])).stdout).toBe('hi there')
    rt.on(/npm test/, { exitCode: 0, stdout: 'ok' })
    expect(await rt.exec(env.id, ['npm', 'test'])).toMatchObject({ exitCode: 0, stdout: 'ok' })
  })

  it('uses the default response option and async responders', async () => {
    const rt = fakeRuntime({ defaultResponse: async () => ({ exitCode: 127, stderr: 'not found' }) })
    const env = await rt.createEnv(spec)
    expect(await rt.exec(env.id, ['nope'])).toMatchObject({ exitCode: 127, stderr: 'not found' })
  })

  it('streams output through onOutput in order', async () => {
    const rt = fakeRuntime()
    const env = await rt.createEnv(spec)
    rt.on(/test/, {
      chunks: [
        { stream: 'stdout', text: 'a' },
        { stream: 'stderr', text: 'x' },
        { stream: 'stdout', text: 'b' },
      ],
    })
    const seen: string[] = []
    const r = await rt.exec(env.id, ['test'], { onOutput: (c) => seen.push(`${c.stream}:${c.text}`) })
    expect(seen).toEqual(['stdout:a', 'stderr:x', 'stdout:b'])
    expect(r).toMatchObject({ stdout: 'ab', stderr: 'x' })
  })

  it('simulates timeouts', async () => {
    const rt = fakeRuntime()
    const env = await rt.createEnv(spec)
    rt.on(/slow/, { delayMs: 50, stdout: 'partial' })
    rt.on(/stuck/, { hang: true, stdout: 'never' })
    rt.on(/quick/, { delayMs: 5, stdout: 'done' })
    expect(await rt.exec(env.id, ['slow'], { timeoutMs: 10 })).toMatchObject({
      timedOut: true,
      exitCode: TIMEOUT_EXIT_CODE,
      stdout: 'partial',
      durationMs: 10,
    })
    expect(await rt.exec(env.id, ['stuck'], { timeoutMs: 10 })).toMatchObject({ timedOut: true, stdout: '' })
    expect(await rt.exec(env.id, ['quick'], { timeoutMs: 100 })).toMatchObject({ timedOut: false, stdout: 'done', durationMs: 5 })
    await expect(rt.exec(env.id, ['stuck'])).rejects.toBeInstanceOf(ValidationError)
  })

  it('aborts on signal', async () => {
    const rt = fakeRuntime()
    const env = await rt.createEnv(spec)
    rt.on(/stuck/, { hang: true })
    const ac = new AbortController()
    const p = rt.exec(env.id, ['stuck'], { signal: ac.signal })
    setTimeout(() => ac.abort(), 5)
    await expect(p).rejects.toBeInstanceOf(ExecAbortedError)
    await expect(rt.exec(env.id, ['ls'], { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(ExecAbortedError)
  })

  it('throws scripted errors, and fails on missing or stopped environments', async () => {
    const rt = fakeRuntime()
    const env = await rt.createEnv(spec)
    rt.on(/boom/, { error: new Error('daemon gone') })
    await expect(rt.exec(env.id, ['boom'])).rejects.toThrow('daemon gone')
    await expect(rt.exec('env_missing', ['ls'])).rejects.toBeInstanceOf(NotFoundError)
    await expect(rt.exec(env.id, [])).rejects.toBeInstanceOf(ValidationError)
    rt.stop(env.id)
    expect((await rt.getEnv(env.id))!.status).toBe('stopped')
    await expect(rt.exec(env.id, ['ls'])).rejects.toBeInstanceOf(ConflictError)
  })

  it('runs concurrent execs independently', async () => {
    const rt = fakeRuntime()
    const env = await rt.createEnv(spec)
    rt.on(/sleep (\d+)/, (call) => ({ delayMs: Number(call.cmd[1]), stdout: call.cmd[1] }))
    const results = await Promise.all([rt.exec(env.id, ['sleep', '20']), rt.exec(env.id, ['sleep', '1'])])
    expect(results.map((r) => r.stdout)).toEqual(['20', '1'])
  })
})
