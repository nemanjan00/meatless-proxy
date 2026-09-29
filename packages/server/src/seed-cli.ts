import { bootstrap } from './bootstrap.ts'
import { buildServices } from './services.ts'
import { configFromEnv } from './env.ts'

/** Seeds the default employee, router session, channels and trigger (`npm run seed`). Idempotent. */
const config = configFromEnv()
const services = await buildServices(config)
try {
  const r = await bootstrap(services)
  services.logger.info(r.created ? 'seeded' : 'already seeded', { ...r })
} finally {
  await services.close()
}
