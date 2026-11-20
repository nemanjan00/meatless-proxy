import { afterEach, describe, expect, it } from 'vitest'
import { testApp, type TestApp } from './helpers.ts'

const apps: TestApp[] = []
afterEach(async () => {
  for (const t of apps.splice(0)) await t.close()
})

describe('renaming an employee through the records API', () => {
  it('renames its contact and moves its @handle, and refuses a name another employee has', async () => {
    const t = await testApp({ workers: false })
    apps.push(t)
    const s = t.a.services
    const bot = await s.directory.employees.create({ name: 'Billing Bot' })
    await s.directory.employees.create({ name: 'Other Bot' })
    const r = await t.req('PATCH', `/api/records/employee/${bot.id}`, { data: { name: 'Ledger', personality: 'Terse.' } })
    expect(r.status).toBe(200)
    const renamed = await s.directory.employees.require(bot.id)
    expect(renamed.data).toMatchObject({ name: 'Ledger', personality: 'Terse.' })
    const contact = await s.directory.contacts.require(bot.data.contactId)
    expect(contact.data.name).toBe('Ledger')
    expect(contact.data.handles).toContainEqual({ system: 'mp', id: 'ledger' })
    expect((await s.directory.employees.byHandle('ledger'))?.id).toBe(bot.id)

    const clash = await t.req('PATCH', `/api/records/employee/${bot.id}`, { data: { name: 'Other Bot' } })
    expect(clash.status).toBe(409)
    expect((await s.directory.employees.require(bot.id)).data.name).toBe('Ledger')
    // Other edits still go through as before.
    expect((await t.req('PATCH', `/api/records/employee/${bot.id}`, { data: { instructions: 'Be brief.' } })).status).toBe(200)
  })
})
