import type { ContactData } from '@mp/directory'
import type { StoredRecord } from '@mp/store'
import type { Services } from '../services.ts'
import { errorMessage } from '@mp/core'
import { accessOf, defineAuthKinds } from './access.ts'
import { contactByEmail, createLoginLink, hasSignedIn } from './sessions.ts'

export interface AdminBootstrap {
  adminId: string
  /** True when the admin contact was created now. */
  created: boolean
  /** A one-time sign-in link, when no admin has signed in yet. */
  link?: { url: string; expiresAt: string }
}

/**
 * Makes sure the deployment has an admin, on every start:
 *
 * - `ADMIN_EMAIL` set: that person is an admin. An existing contact with the email is made one; else
 *   the "Admin" contact the first start created without an email gets it; else a new admin contact is
 *   created with it. Setting or changing `ADMIN_EMAIL` later therefore takes effect on the next start.
 *   It never demotes anyone.
 * - No `ADMIN_EMAIL` and no admin: an "Admin" contact is created.
 *
 * While the admin in question has never signed in, each start logs a fresh one-time sign-in link for
 * it (it works once, for 15 minutes).
 */
export async function ensureAdmin(s: Services): Promise<AdminBootstrap> {
  defineAuthKinds(s.records)
  const actor = { type: 'system' as const, id: 'bootstrap' }
  const email = s.config.ADMIN_EMAIL?.trim() || undefined
  const admins = (
    await s.records.query<ContactData>('contact', {
      where: { access: 'admin', kind: 'person' },
      orderBy: { field: 'createdAt', dir: 'asc' },
      limit: 1000,
    })
  ).items.filter((c) => accessOf(c as StoredRecord<ContactData>) === 'admin') as StoredRecord<ContactData>[] // not deactivated or left

  let admin: StoredRecord<ContactData> | undefined
  let created = false
  if (email) {
    const byEmail = await contactByEmail(s, email)
    if (byEmail?.data.deactivatedAt) {
      // An admin deactivated the ADMIN_EMAIL contact: respect it, change nothing, and use an active admin.
      admin = admins[0]
      s.logger.warn('bootstrap: the ADMIN_EMAIL contact is deactivated; not signing it in', { contactId: byEmail.id })
      if (!admin) return { adminId: byEmail.id, created }
    } else if (byEmail && byEmail.data.status !== 'left') {
      admin = byEmail
      if (byEmail.data.access !== 'admin') {
        admin = (await s.directory.contacts.update(byEmail.id, { access: 'admin' }, { actor })) as StoredRecord<ContactData>
        s.logger.info('bootstrap: ADMIN_EMAIL contact is now an admin', { contactId: admin.id })
      }
    } else {
      // The admin the first start created without an email takes it, instead of a second admin.
      const unclaimed = admins.find((a) => !a.data.email && a.data.name === 'Admin')
      if (unclaimed) {
        admin = (await s.directory.contacts.update(unclaimed.id, { email }, { actor })) as StoredRecord<ContactData>
        s.logger.info('bootstrap: gave the admin contact the ADMIN_EMAIL', { contactId: admin.id })
      }
    }
  } else admin = admins[0]

  if (!admin) {
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
    s.logger.info('bootstrap: admin contact ready', { contactId: admin.id, created })
  }

  // With ADMIN_EMAIL, the link is for that person; without, for the first admin, until any admin has signed in.
  const candidates = email ? [admin] : admins.length ? admins : [admin]
  for (const a of candidates) if (await hasSignedIn(s, a.id)) return { adminId: admin.id, created }
  // A sign-in link that can't be made (the contact was deactivated meanwhile) must never stop the harness from starting.
  let link: Awaited<ReturnType<typeof createLoginLink>>
  try {
    link = await createLoginLink(s, admin.id, { createdBy: 'bootstrap' })
  } catch (err) {
    s.logger.warn('bootstrap: could not make an admin sign-in link', { contactId: admin.id, err: errorMessage(err) })
    return { adminId: admin.id, created }
  }
  s.logger.info('bootstrap: sign in as the admin with this one-time link (valid 15 minutes)', {
    url: link.url,
    contactId: admin.id,
    ...(email ? { email } : {}),
    expiresAt: link.expiresAt,
  })
  return { adminId: admin.id, created, link: { url: link.url, expiresAt: link.expiresAt } }
}
