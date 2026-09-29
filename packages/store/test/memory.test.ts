import { memoryStore } from '../src/index.ts'
import { storeContract } from '../src/contract.ts'

storeContract('memory', async ({ bus }) => memoryStore({ bus }))
