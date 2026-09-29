import { queueContract } from '@mp/queue/contract'
import { afterAll, describe } from 'vitest'
import { bullmqQueue } from '../src/index.ts'
import { deleteKeys, REDIS_URL, uniquePrefix } from './helpers.ts'

const prefix = uniquePrefix('contract')

describe.skipIf(!REDIS_URL)('bullmq adapter (needs REDIS_URL)', () => {
  afterAll(() => deleteKeys(REDIS_URL!, prefix))
  queueContract('bullmq', async ({ bus }) => bullmqQueue({ connection: REDIS_URL!, prefix, bus }), { timeScale: 1.5 })
})
