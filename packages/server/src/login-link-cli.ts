import { parseArgs } from 'node:util'
import { errorMessage } from '@mp/core'
import { findContact, createLoginLink } from './auth/sessions.ts'
import { configFromEnv } from './env.ts'
import { buildServices } from './services.ts'

/**
 * Prints a one-time sign-in link for a person:
 * `npm run login-link -- --contact <contactId|email>`.
 * The link works once, for 15 minutes. Only its hash is stored.
 */
const { values } = parseArgs({ options: { contact: { type: 'string' } } })
if (!values.contact) {
  process.stderr.write('usage: npm run login-link -- --contact <contactId|email>\n')
  process.exit(2)
}
const config = configFromEnv()
const services = await buildServices({ ...config, LOG_LEVEL: 'warn' }, { stdlib: false })
let code = 0
try {
  const contactId = await findContact(services, values.contact)
  if (!contactId) throw new Error(`no contact ${values.contact}`)
  const link = await createLoginLink(services, contactId, { createdBy: 'cli' })
  process.stdout.write(`${link.url}\n`)
  process.stderr.write(`sign-in link for contact ${contactId}: works once, until ${link.expiresAt}\n`)
} catch (err) {
  process.stderr.write(`${errorMessage(err)}\n`)
  code = 1
} finally {
  await services.close()
}
process.exit(code)
