import { storeContract } from '@mp/store/contract'
import pg from 'pg'
import { afterAll, describe } from 'vitest'
import { createTestSchema, postgresStore, type TestSchema } from '../src/index.ts'

const url = process.env.DATABASE_URL

describe.skipIf(!url)('postgres store contract', () => {
  const pool = new pg.Pool({ connectionString: url, max: 12 })
  const schemas: TestSchema[] = []

  afterAll(async () => {
    for (const s of schemas) await s.drop()
    await pool.end()
  })

  storeContract('postgres', async ({ bus }) => {
    const s = await createTestSchema(pool, 'mp_test_contract')
    schemas.push(s)
    return postgresStore({ pool, schema: s.schema, bus })
  })
})
