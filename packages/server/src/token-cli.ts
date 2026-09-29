import { parseArgs } from 'node:util'
import { buildServices } from './services.ts'
import { configFromEnv } from './env.ts'
import { createMcpToken } from './tokens.ts'

/**
 * Creates a bearer token for the MCP server at /mcp:
 * `npm run token -- --contact <contactId> [--name laptop]`.
 * The token is printed once and only its hash is stored.
 */
const { values } = parseArgs({ options: { contact: { type: 'string' }, name: { type: 'string' } } })
if (!values.contact) {
  process.stderr.write('usage: npm run token -- --contact <contactId> [--name <label>]\n')
  process.exit(2)
}
const config = configFromEnv()
const services = await buildServices({ ...config, LOG_LEVEL: 'warn' }, { stdlib: false })
try {
  const t = await createMcpToken(services, values.contact, values.name)
  process.stdout.write(`${t.token}\n`)
  process.stderr.write(`token ${t.id} for contact ${t.contactId} created; it is shown only once\n`)
} finally {
  await services.close()
}
