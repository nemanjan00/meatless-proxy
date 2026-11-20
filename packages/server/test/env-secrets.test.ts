import { fakeRuntime } from '@mp/containers'
import { newId } from '@mp/core'
import { afterEach, describe, expect, it } from 'vitest'
import { reservedSecret } from '../src/env-secrets.ts'
import { testApp, type TestApp } from './helpers.ts'

/** env.up `secrets` through the real secret store (docs/spec.md "Secrets"): scopes, reserved names, masking in the UI. */

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

async function make() {
  const rt = fakeRuntime()
  const t = await testApp({ workers: false, overrides: { containers: rt } })
  apps.push(t)
  const s = t.a.services
  const employee = (await s.directory.employees.byHandle('meatless'))!
  const session = await s.sessions.create({ employeeId: employee.id, title: 'Publish the library' })
  const tool = async (name: string, args: unknown) => {
    const callId = newId('call')
    return s.tools.execute(name, args, {
      employeeId: employee.id,
      sessionId: session.id,
      runId: 'run_test',
      callId,
      idempotencyKey: `run_test:0:${callId}`,
      secrets: {},
      signal: new AbortController().signal,
      logger: s.logger,
      clock: s.clock,
      emit: () => {},
    })
  }
  return { t, s, rt, employee, session, tool }
}

describe('env.up secrets in the server', () => {
  it('reserves the integrations’ credentials and the SSH key', () => {
    for (const n of [
      'SSH_PRIVATE_KEY',
      'GITLAB_TOKEN',
      'GITLAB_HOOKS_TOKEN',
      'SLACK_BOT_TOKEN',
      'LINEAR_API_KEY',
      'MCP_DOCS_TOKEN',
    ])
      expect(reservedSecret(n), n).toBe(true)
    expect(reservedSecret('NPM_TOKEN')).toBe(false)
  })

  it('resolves a global secret, prefers the employee’s own, and masks it in the Environments page logs', async () => {
    const { t, s, rt, employee, tool } = await make()
    await s.secrets.set('NPM_TOKEN', 'npm_test_global_1', { type: 'global' })
    await s.directory.employees.update(employee.id, { envSecrets: ['NPM_TOKEN'] })
    const up = await tool('env.up', { image: 'node:22', secrets: ['NPM_TOKEN'] })
    expect(up.isError).toBeFalsy()
    const envId = (up.output as { envId: string }).envId
    expect(rt.created.at(-1)!.env).toMatchObject({ NPM_TOKEN: 'npm_test_global_1' })
    rt.appendLog(envId, 'using npm_test_global_1\n')
    const logs = await t.req('GET', `/api/environments/${envId}/logs`)
    expect(logs.body.logs).toBe('using [secret]\n')

    await s.secrets.set('NPM_TOKEN', 'npm_test_own_1', { type: 'employee', id: employee.id })
    await tool('env.up', { image: 'node:22', restart: true })
    expect(rt.created.at(-1)!.env).toMatchObject({ NPM_TOKEN: 'npm_test_own_1' })
  })

  it('never sets a reserved secret, even when an admin allows its name', async () => {
    const { s, rt, employee, tool } = await make()
    await s.secrets.set('GITLAB_TOKEN', 'glpat-test-1', { type: 'employee', id: employee.id })
    await s.directory.employees.update(employee.id, { envSecrets: ['GITLAB_TOKEN'] })
    const up = await tool('env.up', { image: 'node:22', secrets: ['GITLAB_TOKEN'] })
    expect(up.isError).toBe(true)
    expect(JSON.stringify(up.output)).toContain('no value for GITLAB_TOKEN')
    expect(rt.created).toHaveLength(0)
  })
})
