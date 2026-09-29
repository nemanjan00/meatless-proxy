import { describeScenarios, memoryBackend, realBackend } from './scenarios.ts'

const DATABASE_URL = process.env.DATABASE_URL
const REDIS_URL = process.env.REDIS_URL

describeScenarios(memoryBackend, 'memory', '')
describeScenarios(
  DATABASE_URL && REDIS_URL ? realBackend(DATABASE_URL, REDIS_URL) : null,
  'postgres+bullmq',
  'set DATABASE_URL and REDIS_URL to run',
)
