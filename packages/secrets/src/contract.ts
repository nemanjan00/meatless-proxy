/**
 * The secrets contract. Every implementation of `SecretStore` must pass it:
 *
 *   secretStoreContract('store', ({ clock }) => storeSecretStore({ store: memoryStore(), key: 'k', clock }))
 *
 * `make` must return a fresh, empty secret store each time.
 */
import { ManualClock, ValidationError } from '@mp/core'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SecretStore } from './types.ts'

export interface SecretContractContext {
  clock: ManualClock
}

export function secretStoreContract(name: string, make: (ctx: SecretContractContext) => Promise<SecretStore> | SecretStore) {
  describe(`secret store contract: ${name}`, () => {
    let secrets: SecretStore
    let clock: ManualClock

    beforeEach(async () => {
      clock = new ManualClock(Date.UTC(2026, 2, 1))
      secrets = await make({ clock })
    })

    it('sets and resolves a global secret', async () => {
      await secrets.set('LINEAR_TOKEN', 'lin-test-1234', { type: 'global' })
      expect(await secrets.resolve(['LINEAR_TOKEN'], {})).toEqual({ LINEAR_TOKEN: 'lin-test-1234' })
    })

    it('resolves the most specific scope: tool > project > employee > global', async () => {
      await secrets.set('TOKEN', 'global-value', { type: 'global' })
      await secrets.set('TOKEN', 'employee-value', { type: 'employee', id: 'emp_1' })
      await secrets.set('TOKEN', 'project-value', { type: 'project', id: 'prj_1' })
      await secrets.set('TOKEN', 'tool-value', { type: 'tool', name: 'mcp.linear' })
      const r = (ctx: object) => secrets.resolve(['TOKEN'], ctx).then((x) => x.TOKEN)
      expect(await r({ employeeId: 'emp_1', projectId: 'prj_1', tool: 'mcp.linear' })).toBe('tool-value')
      expect(await r({ employeeId: 'emp_1', projectId: 'prj_1', tool: 'other' })).toBe('project-value')
      expect(await r({ employeeId: 'emp_1', projectId: 'prj_2' })).toBe('employee-value')
      expect(await r({ employeeId: 'emp_2' })).toBe('global-value')
      expect(await r({})).toBe('global-value')
    })

    it('never leaks secrets from scopes outside the context', async () => {
      await secrets.set('DB_URL', 'postgres://example.invalid/a', { type: 'project', id: 'prj_a' })
      await secrets.set('KEY', 'employee-b-key', { type: 'employee', id: 'emp_b' })
      await secrets.set('T', 'tool-only', { type: 'tool', name: 'git' })
      expect(await secrets.resolve(['DB_URL', 'KEY', 'T'], { projectId: 'prj_b', employeeId: 'emp_a', tool: 'docker' })).toEqual(
        {},
      )
    })

    it('leaves missing names out and handles duplicates', async () => {
      await secrets.set('A_1', 'value-a', { type: 'global' })
      expect(await secrets.resolve(['A_1', 'MISSING', 'A_1'], {})).toEqual({ A_1: 'value-a' })
      expect(await secrets.resolve([], {})).toEqual({})
    })

    it('overwrites a value in the same scope and records who and when', async () => {
      await secrets.set('TOKEN', 'first-value', { type: 'project', id: 'p' }, 'ana')
      clock.advance(60_000)
      await secrets.set('TOKEN', 'second-value', { type: 'project', id: 'p' }, 'ben')
      expect(await secrets.resolve(['TOKEN'], { projectId: 'p' })).toEqual({ TOKEN: 'second-value' })
      expect(await secrets.list()).toEqual([
        { name: 'TOKEN', scope: { type: 'project', id: 'p' }, updatedAt: '2026-03-01T00:01:00.000Z', updatedBy: 'ben' },
      ])
    })

    it('lists metadata sorted, never values', async () => {
      await secrets.set('ZED', 'zed-secret-value', { type: 'global' })
      await secrets.set('ALPHA', 'alpha-secret-value', { type: 'tool', name: 'x' })
      await secrets.set('ALPHA', 'alpha-secret-value-2', { type: 'global' })
      const list = await secrets.list()
      expect(list.map((m) => [m.name, m.scope.type])).toEqual([
        ['ALPHA', 'global'],
        ['ALPHA', 'tool'],
        ['ZED', 'global'],
      ])
      expect(list[0]!.updatedBy).toBe('system')
      expect(JSON.stringify(list)).not.toContain('secret-value')
    })

    it('deletes, idempotently, only in the given scope', async () => {
      await secrets.set('TOKEN', 'global-value', { type: 'global' })
      await secrets.set('TOKEN', 'project-value', { type: 'project', id: 'p' })
      await secrets.delete('TOKEN', { type: 'project', id: 'p' })
      await secrets.delete('TOKEN', { type: 'project', id: 'p' })
      await secrets.delete('NEVER_SET', { type: 'global' })
      expect(await secrets.resolve(['TOKEN'], { projectId: 'p' })).toEqual({ TOKEN: 'global-value' })
      expect((await secrets.list()).map((m) => m.scope.type)).toEqual(['global'])
    })

    it('keeps values exactly, including unicode and empty strings', async () => {
      const value = 'päss wörd ✓ \n "quoted" \u0000 end'
      await secrets.set('WEIRD', value, { type: 'global' })
      await secrets.set('EMPTY', '', { type: 'global' })
      expect(await secrets.resolve(['WEIRD', 'EMPTY'], {})).toEqual({ WEIRD: value, EMPTY: '' })
    })

    it('rejects bad names and scopes', async () => {
      await expect(secrets.set('bad-name', 'v', { type: 'global' })).rejects.toBeInstanceOf(ValidationError)
      await expect(secrets.set('', 'v', { type: 'global' })).rejects.toBeInstanceOf(ValidationError)
      await expect(secrets.set('A:B', 'v', { type: 'global' })).rejects.toBeInstanceOf(ValidationError)
      await expect(secrets.set('OK', 'v', { type: 'project', id: '' })).rejects.toBeInstanceOf(ValidationError)
      await expect(secrets.set('OK', 'v', { type: 'tool', name: '' })).rejects.toBeInstanceOf(ValidationError)
      expect(await secrets.list()).toEqual([])
    })

    it('keeps scopes with similar ids apart', async () => {
      await secrets.set('T', 'employee-value', { type: 'employee', id: 'x' })
      await secrets.set('T', 'project-value', { type: 'project', id: 'x' })
      expect(await secrets.resolve(['T'], { employeeId: 'x' })).toEqual({ T: 'employee-value' })
      expect(await secrets.resolve(['T'], { projectId: 'x' })).toEqual({ T: 'project-value' })
    })

    it('handles concurrent writes', async () => {
      await Promise.all(Array.from({ length: 20 }, (_, i) => secrets.set(`S_${i % 5}`, `value-${i}`, { type: 'global' })))
      expect((await secrets.list()).map((m) => m.name)).toEqual(['S_0', 'S_1', 'S_2', 'S_3', 'S_4'])
    })
  })
}
