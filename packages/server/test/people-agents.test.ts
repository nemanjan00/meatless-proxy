import { afterEach, describe, expect, it } from 'vitest'
import { testApp, type TestApp } from './helpers.ts'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

describe('People', () => {
  it('lists people and AI employees, not the local agents connected over MCP (unless asked for)', async () => {
    const t = await testApp({ workers: false })
    apps.push(t)
    const s = t.a.services
    const ana = await s.directory.contacts.create({ name: 'Ana Example', kind: 'person', access: 'member' })
    await s.directory.contacts.create({ name: 'ordinary-plum', kind: 'agent', sponsor: ana.id } as never)
    const names = async (q = '') => ((await t.req('GET', `/api/people${q}`)).body as any[]).map((p) => p.contact.data.name)
    expect(await names()).toContain('Ana Example')
    expect(await names()).not.toContain('ordinary-plum')
    expect(await names('?text=plum')).toEqual([])
    expect(await names('?type=agent')).toEqual(['ordinary-plum'])
  })
})
