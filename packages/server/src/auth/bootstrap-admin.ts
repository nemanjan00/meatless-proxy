import type { ContactData } from '@mp/directory'
import type { StoredRecord } from '@mp/store'
import type { Services } from '../services.ts'
import { defineAuthKinds } from './access.ts'
import { contactByEmail, createLoginLink, hasSignedIn } from './sessions.ts'

export interface AdminBootstrap {
  adminId: string
  /** True when the admin contact was created now. */
  created: boolean
  /** A one-time sign-in link, when no admin has signed in yet. */
  link?: { url: string; expiresAt: string }
}

/**
 * Makes sure the deployment has an admin: when no person has `access: admin`,
 * the contact with `ADMIN_EMAIL` becomes one, or an "Admin" contact is created.
 * While no admin has ever signed in, each start logs a fresh one-time sign-in
 * link for the first admin (it works once, for 15 minutes).
 */
export async function ensureAdmin(s: Services): Promise<AdminBootstrap> {
  defineAuthKinds(s.records)
  const actor = { type: 'system' as const, id: 'bootstrap' }
  const email = s.config.ADMIN_EMAIL
  const admins = (
    await s.records.query<ContactData>('contact', {
      where: { access: 'admin', kind: 'person' },
      orderBy: { field: 'createdAt', dir: 'asc' },
      limit: 1000,
    })
  ).items.filter((c) => c.data.status !== 'left') as StoredRecord<ContactData>[]

  let admin = admins[0]
  let created = false
  if (!admin) {
    const byEmail = email ? await contactByEmail(s, email) : null
    if (byEmail && byEmail.data.status !== 'left') {
      admin = (await s.directory.contacts.update(byEmail.id, { access: 'admin' }, { actor })) as StoredRecord<ContactData>
    } else {
      admin = (await s.directory.contacts.create(
        {
          name: 'Admin',
          kind: 'person',
          access: 'admin',
          // Taggable as @admin in chat, unless someone has that handle already.
          ...((await s.directory.contacts.byHandle('mp', 'admin')) ? {} : { handles: [{ system: 'mp', id: 'admin' }] }),
          ...(email ? { email } : {}),
        },
        { actor },
      )) as StoredRecord<ContactData>
      created = true
    }
    s.logger.info('bootstrap: admin contact ready', { contactId: admin.id, created })
  }

  for (const a of admins.length ? admins : [admin]) if (await hasSignedIn(s, a.id)) return { adminId: admin.id, created }
  const link = await createLoginLink(s, admin.id, { createdBy: 'bootstrap' })
  s.logger.info('bootstrap: sign in as the admin with this one-time link (valid 15 minutes)', {
    url: link.url,
    contactId: admin.id,
    expiresAt: link.expiresAt,
  })
  return { adminId: admin.id, created, link: { url: link.url, expiresAt: link.expiresAt } }
}
