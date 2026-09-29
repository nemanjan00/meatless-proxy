import { errorMessage } from '@mp/core'
import { createApp } from './app.ts'
import { describeConfig } from './config.ts'
import { configFromEnv } from './env.ts'

/** Starts the harness: API, web UI, WebSocket, MCP server and workers, in one process. */
const config = configFromEnv()
const app = await createApp(config)
const log = app.services.logger
log.info('starting', describeConfig(config))
await app.start()

let signals = 0
const shutdown = (signal: string) => {
  signals++
  if (signals > 1) {
    log.warn('second signal: exiting now', { signal })
    process.exit(1)
  }
  log.info('signal received', { signal })
  app
    .stop()
    .then(() => process.exit(0))
    .catch((err) => {
      log.error('shutdown failed', { err: errorMessage(err) })
      process.exit(1)
    })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err: errorMessage(err) }))
