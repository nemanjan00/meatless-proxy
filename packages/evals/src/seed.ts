import type { ChecklistItem, Contact, Procedure, Project } from '@mp/directory'
import type { EvalContext } from './types.ts'

export interface Company {
  /** Owner of Payments. */
  ana: Contact
  /** The requester: an engineer on Payments. */
  ben: Contact
  /** Owner of Search. */
  cara: Contact
  payments: Project
  search: Project
}

/** A small company every scenario starts from: three people, two projects with owners, and a doc. */
export async function seedCompany(ctx: EvalContext): Promise<Company> {
  const { directory, docs } = ctx.services
  const ana = await directory.contacts.create({
    name: 'Ana Lopez',
    email: 'ana@example.com',
    role: 'Staff engineer',
    team: 'Payments',
    handles: [{ system: 'mp', id: 'ana' }],
  })
  const ben = await directory.contacts.create({
    name: 'Ben Ode',
    email: 'ben@example.com',
    role: 'Engineer',
    team: 'Payments',
    manager: ana.id,
    handles: [{ system: 'mp', id: 'ben' }],
    permissions: 'May ask about Payments and Search, and request access and equipment for himself.',
  })
  const cara = await directory.contacts.create({
    name: 'Cara Diaz',
    email: 'cara@example.com',
    role: 'Search lead',
    team: 'Search',
    handles: [{ system: 'mp', id: 'cara' }],
  })
  const payments = await directory.projects.create({
    name: 'Payments',
    aliases: ['billing'],
    status: 'active',
    description: 'Payments handles refunds, invoices and the billing ledger. It runs as Kotlin services on Postgres.',
    repositories: [{ url: 'https://git.example.com/payments.git', defaultBranch: 'main' }],
  })
  await directory.projects.setOwner(payments.id, ana.id)
  await directory.projects.addMember(payments.id, ben.id, 'member')
  const search = await directory.projects.create({
    name: 'Search',
    status: 'active',
    description: 'The search index behind the help center.',
  })
  await directory.projects.setOwner(search.id, cara.id)
  await docs.create({
    title: 'Payments overview',
    path: 'overview',
    owner: { kind: 'project', id: payments.id },
    body: `# Payments\n\nRefunds, invoices and the billing ledger. Owner: [[contact:${ana.id}|Ana Lopez]].\nDeploys go out on Tuesdays.\n`,
  })
  const company = { ana, ben, cara, payments, search }
  Object.assign(ctx.state, company)
  return company
}

/**
 * Creates a procedure with its procedure context: a session of the default
 * employee that has read the procedure, the way the harness builds one.
 */
export async function createProcedure(
  ctx: EvalContext,
  p: { name: string; applies: string; body: string; ownerId?: string; checklist?: ChecklistItem[]; projectIds?: string[] },
): Promise<{ procedure: Procedure; contextSessionId: string }> {
  const s = ctx.services
  const employee = await s.directory.employees.byHandle('meatless')
  if (!employee) throw new Error('the default employee is missing (bootstrap did not run)')
  const procedure = await s.directory.procedures.create({ ...p })
  const toolset = s.tools.allowed(await s.toolListsFor(employee.id)).map((t) => t.name)
  const contact = await s.directory.employees.contact(employee.id)
  const prompt = s.stdlib ? s.stdlib.employeePrompt({ employee, contact, now: s.clock.iso() }) : `You are ${employee.data.name}.`
  const context = await s.sessions.create({
    employeeId: employee.id,
    title: `Procedure: ${p.name}`,
    toolset,
    document: `Procedure context for [[procedure:${procedure.id}|${p.name}]].`,
    entries: [
      { kind: 'system', content: { text: prompt } },
      {
        kind: 'system',
        content: {
          text: `You are the context for the procedure "${p.name}" (${procedure.id}). Every fork of you carries out one instance of it.\n\nApplies when: ${p.applies}\n${p.ownerId ? `Owner: ${p.ownerId}\n` : ''}\n## Steps\n\n${p.body}`,
        },
      },
    ],
    links: [{ ref: { kind: 'procedure', id: procedure.id }, role: 'context_of' }],
    meta: { procedureId: procedure.id },
  })
  const updated = await s.directory.procedures.update(procedure.id, { contextSessionId: context.id })
  return { procedure: updated, contextSessionId: context.id }
}
