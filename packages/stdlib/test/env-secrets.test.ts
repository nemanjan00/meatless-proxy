import type { BusMessage } from '@mp/core'
import { describe, expect, it } from 'vitest'
import { promptForEmployee } from '../src/kit.ts'
import { stack } from './helpers.ts'

type Stack = Awaited<ReturnType<typeof stack>>
const lastSpec = (t: Stack) => t.containers.created.at(-1)!

/** A secret store with these values, recording what was asked for. */
function store(values: Record<string, string>) {
  const asked: { names: string[]; ctx: { employeeId: string; projectId?: string } }[] = []
  const envSecrets = async (names: string[], ctx: { employeeId: string; projectId?: string }) => {
    asked.push({ names, ctx })
    return Object.fromEntries(names.filter((n) => values[n] !== undefined).map((n) => [n, values[n]!]))
  }
  return { asked, envSecrets, values }
}

describe('env.up secrets', () => {
  it("sets an allowed secret's value in the environment, never in what the model sees, and records the use", async () => {
    const s = store({ NPM_TOKEN: 'npm_test_token_123' })
    const t = await stack({ envSecrets: s.envSecrets })
    await t.directory.employees.update(t.employee.id, { envSecrets: ['NPM_TOKEN'] })
    const used: BusMessage[] = []
    t.bus.subscribe('secret.used', (m) => void used.push(m))
    const up = await t.call('env.up', { image: 'node:22', secrets: ['NPM_TOKEN'], env: { CI: '1' } })
    expect(up.isError).toBeFalsy()
    expect(lastSpec(t).env).toMatchObject({ CI: '1', NPM_TOKEN: 'npm_test_token_123' })
    expect(JSON.stringify(up.output)).not.toContain('npm_test_token_123')
    expect(up.output).toMatchObject({ secrets: ['NPM_TOKEN'] })
    expect((up.output as { note: string }).note).toContain('$NPM_TOKEN')
    expect(used).toHaveLength(1)
    expect(used[0]!.payload).toMatchObject({
      names: ['NPM_TOKEN'],
      tool: 'env.up',
      envId: (up.output as { envId: string }).envId,
    })
    expect(JSON.stringify(used[0]!.payload)).not.toContain('npm_test_token_123')
  })

  it('masks the value in env.exec output and env.logs, also after the secret changes', async () => {
    const s = store({ NPM_TOKEN: 'npm_test_token_123' })
    const t = await stack({ envSecrets: s.envSecrets })
    await t.directory.employees.update(t.employee.id, { envSecrets: ['NPM_TOKEN'] })
    const up = await t.out('env.up', { image: 'node:22', secrets: ['NPM_TOKEN'] })
    t.containers.on('env', { stdout: 'NPM_TOKEN=npm_test_token_123\n', stderr: 'auth npm_test_token_123 failed' })
    const r = await t.out('env.exec', { cmd: ['env'] })
    expect(r.stdout).toBe('NPM_TOKEN=[secret]\n')
    expect(r.stderr).toBe('auth [secret] failed')
    // Rotated: the environment still has the old value, and both are masked.
    s.values.NPM_TOKEN = 'npm_test_token_456'
    t.containers.appendLog(up.envId, 'old npm_test_token_123 new npm_test_token_456\n')
    const logs = await t.out('env.logs', {})
    expect(logs.logs).toContain('old [secret] new [secret]')
  })

  it('refuses a secret the employee is not allowed, or that has no value, before anything starts', async () => {
    const s = store({ NPM_TOKEN: 'npm_test_token_123' })
    const t = await stack({ envSecrets: s.envSecrets })
    const denied = await t.call('env.up', { image: 'node:22', secrets: ['NPM_TOKEN'] })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.output)).toContain('NPM_TOKEN is not allowed in your environments')
    expect(s.asked).toEqual([])
    await t.directory.employees.update(t.employee.id, { envSecrets: ['NPM_TOKEN', 'PYPI_TOKEN'] })
    const unset = await t.call('env.up', { image: 'node:22', secrets: ['PYPI_TOKEN'] })
    expect(unset.isError).toBe(true)
    expect(JSON.stringify(unset.output)).toContain('no value for PYPI_TOKEN')
    const clash = await t.call('env.up', { image: 'node:22', secrets: ['NPM_TOKEN'], env: { NPM_TOKEN: 'x' } })
    expect(clash.isError).toBe(true)
    const bad = await t.call('env.up', { image: 'node:22', secrets: 'NPM_TOKEN' })
    expect(bad.isError).toBe(true)
    expect(t.containers.created).toHaveLength(0)
  })

  it('without the deployment giving secrets, says so', async () => {
    const t = await stack()
    await t.directory.employees.update(t.employee.id, { envSecrets: ['NPM_TOKEN'] })
    const r = await t.call('env.up', { image: 'node:22', secrets: ['NPM_TOKEN'] })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('gives environments no secrets')
  })

  it("keeps the session's secrets when env.exec starts the environment again, and drops one no longer allowed", async () => {
    const s = store({ NPM_TOKEN: 'npm_test_token_123', PYPI_TOKEN: 'pypi_test_token_1' })
    const t = await stack({ envSecrets: s.envSecrets })
    await t.directory.employees.update(t.employee.id, { envSecrets: ['NPM_TOKEN', 'PYPI_TOKEN'] })
    await t.out('git.checkout', { projectId: t.project.id })
    await t.out('env.up', { secrets: ['NPM_TOKEN', 'PYPI_TOKEN'] })
    // Gone, as an idle environment is stopped: env.exec starts the default one again.
    await t.out('env.down', {})
    await t.directory.employees.update(t.employee.id, { envSecrets: ['NPM_TOKEN'] })
    t.containers.on('true', { stdout: '' })
    await t.out('env.exec', { cmd: ['true'] })
    expect(lastSpec(t).env).toMatchObject({ NPM_TOKEN: 'npm_test_token_123' })
    expect(lastSpec(t).env?.PYPI_TOKEN).toBeUndefined()
    // [] asks for none.
    await t.out('env.up', { image: 'node:22', secrets: [], restart: true })
    expect(lastSpec(t).env?.NPM_TOKEN).toBeUndefined()
  })

  it('a running environment keeps its secrets: asking for others says how to restart', async () => {
    const s = store({ NPM_TOKEN: 'npm_test_token_123' })
    const t = await stack({ envSecrets: s.envSecrets })
    await t.directory.employees.update(t.employee.id, { envSecrets: ['NPM_TOKEN'] })
    await t.out('env.up', { image: 'node:22' })
    const again = await t.out('env.up', { image: 'node:22', secrets: ['NPM_TOKEN'] })
    expect(again.existing).toBe(true)
    expect(again.note).toContain('"restart":true')
    expect(t.containers.created).toHaveLength(1)
  })

  it('lists the allowed secrets in the prompt', async () => {
    const t = await stack()
    await t.directory.employees.update(t.employee.id, { envSecrets: ['NPM_TOKEN'] })
    const prompt = await promptForEmployee(t.deps, t.employee.id)
    expect(prompt).toContain('## Secrets for your environments')
    expect(prompt).toContain('NPM_TOKEN')
  })
})
