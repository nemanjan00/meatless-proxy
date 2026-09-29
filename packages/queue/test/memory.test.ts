import { queueContract } from '../src/contract.ts'
import { memoryQueue } from '../src/index.ts'

queueContract('memory', async ({ bus }) => memoryQueue({ bus }))
