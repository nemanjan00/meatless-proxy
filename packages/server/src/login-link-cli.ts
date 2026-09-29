import { parseArgs } from 'node:util'
import { errorMessage } from '@mp/core'
import type { ContactData } from '@mp/directory'
import { ACCESS_LEVELS, type Access, defineAuthKinds } from './auth/access.ts'
import { createLoginLink, findContact } from './auth/sessions.ts'
import { configFromEnv } from './env.ts'
import { buildServices } from './services.ts'

const USAGE = `usage:
  npm run login-link -- --contact <contact id | email>        sign in as an existing person
  npm run login-link -- --admin                                sign in as the first admin
  npm run login-link -- --contact <email> --create [--name "Full Name"] [--access admin|member|viewer]
                                                               create the person first (default access: member)
`

/**
 * Prints a one-time sign-in link for a person. The link works once, for 15
 * minutes, and only its hash is stored.
 */
const { values } = parseArgs({
  options: {
    contact: { type: 'string' },
    admin: { type: 'boolean' },
    create: { type: 'boolean' },
    name: { type: 'string' },
    access: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})
if (values.help || (!values.contact && !values.admin)) {
  process.stderr.write(USAGE)
  process.exit(values.help ? 0 : 2)
}
if (values.access && !(ACCESS_LEVELS as readonly string[]).includes(values.access)) {
  process.stderr.write(`--access must be one of ${ACCESS_LEVELS.join(', ')}\n`)
  process.exit(2)
}

const config = configFromEnv()
const services = await buildServices({ ...config, LOG_LEVEL: 'warn' }, { stdlib: false })
let code = 0
try {
  defineAuthKinds(services.records)
  let contactId: string | null = null

  if (values.admin) {
    const admins = await services.records.query<ContactData>('contact', {
      where: { access: 'admin', kind: 'person' },
      orderBy: { field: 'createdAt', dir: 'asc' },
      limit: 1,
    })
    contactId = admins.items[0]?.id ?? null
    if (!contactId)
      throw new Error(
        'there is no admin yet: start the server once (it creates one), or use --contact <email> --create --access admin',
      )
  } else {
    contactId = await findContact(services, values.contact!)
    if (!contactId && values.create) {
      const email = values.contact!.includes('@') ? values.contact! : undefined
      if (!email) throw new Error('--create needs an email for --contact')
      const access: Access = (values.access as Access | undefined) ?? 'member'
      const created = await services.directory.contacts.create(
        { name: values.name ?? email.split('@')[0]!, kind: 'person', email, access } as ContactData,
        { actor: { type: 'system', id: 'cli' } },
      )
      contactId = created.id
      process.stderr.write(`created ${email} (${access}), contact ${contactId}\n`)
    } else if (contactId && values.access) {
      await services.records.update('contact', contactId, { access: values.access })
      process.stderr.write(`set access to ${values.access}\n`)
    }
    if (!contactId) {
      throw new Error(
        `no contact ${values.contact}.\n` +
          `  Create it:        npm run login-link -- --contact ${values.contact} --create --access admin\n` +
          '  Or sign in as the first admin: npm run login-link -- --admin\n' +
          "  (the server also logs a one-time admin link on start, until an admin has signed in: look for 'sign in as the admin')",
      )
    }
  }

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
