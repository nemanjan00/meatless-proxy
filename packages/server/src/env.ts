import { ConfigError, loadConfig, loadDotEnv, type Config } from './config.ts'

/**
 * Loads `.env` (development only: not when NODE_ENV is `production`) and
 * validates the configuration. On invalid configuration it prints the
 * problems (never values) and exits with status 1.
 */
export function configFromEnv(): Config {
  if (process.env.NODE_ENV !== 'production') loadDotEnv(process.env.DOTENV_PATH ?? '.env')
  try {
    return loadConfig(process.env)
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`)
      process.exit(1)
    }
    throw e
  }
}
