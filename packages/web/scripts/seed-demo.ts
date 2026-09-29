/**
 * Seeds a small, fake company into a running server through the HTTP API, for
 * screenshots and manual testing: contacts, projects with owners, members, docs
 * and egress allowlists, a procedure with a checklist, skills, memories, a file
 * and an extra trigger. Nothing here calls a model.
 *
 *   MP_TOKEN=mpt_… npx tsx packages/web/scripts/seed-demo.ts http://localhost:3000
 *
 * MP_TOKEN is an admin's API token (`npm run token -- --contact <admin id>`, or
 * Settings → API tokens). The admin becomes "Dana Whitfield".
 *
 * Only fake names and example.com addresses.
 */
import { createApiClient, type ApiRecord, type EmployeeData } from '@mp/api'

const base = process.argv[2] ?? 'http://localhost:3000'
const token = process.env.MP_TOKEN
if (!token) throw new Error("set MP_TOKEN to an admin's API token")
const api = createApiClient({ baseUrl: base, headers: { authorization: `Bearer ${token}` } })

const employees = await api.listRecords<EmployeeData>('employee')
const employee = employees.items[0]
if (!employee) throw new Error('no employee: start the server with MP_BOOTSTRAP=1')

// The signed-in admin posts in the screenshots: give them a name.
const me = await api.me()
const web = await api.getRecord<{ name: string; kind: string }>('contact', me.contactId)
const dana = await api.updateRecord(
  'contact',
  web.id,
  {
    name: 'Dana Whitfield',
    role: 'Head of Payments',
    team: 'Payments',
    email: 'dana@example.com',
    handles: [
      { system: 'mp', id: 'web' },
      { system: 'mp', id: 'dana' },
    ],
    permissions: 'Can approve refunds and Checkout releases.',
  },
  web.version,
)

const contact = (data: Record<string, unknown>) => api.createRecord('contact', { kind: 'person', status: 'active', ...data })
const tomas = await contact({
  name: 'Tomás Ortega',
  role: 'Backend engineer',
  team: 'Payments',
  email: 'tomas@example.com',
  manager: dana.id,
  handles: [{ system: 'mp', id: 'tomas' }],
})
const priya = await contact({
  name: 'Priya Raman',
  role: 'Support lead',
  team: 'Customer Support',
  email: 'priya@example.com',
  handles: [{ system: 'mp', id: 'priya' }],
  permissions: 'Can ask for refunds up to $500 and for Help Center changes.',
})
const leo = await contact({
  name: 'Leo Brandt',
  role: 'Site reliability engineer',
  team: 'Platform',
  email: 'leo@example.com',
  handles: [{ system: 'mp', id: 'leo' }],
})
const mia = await contact({
  name: 'Mia Chen',
  role: 'Product manager',
  team: 'Customer Support',
  email: 'mia@example.com',
  handles: [{ system: 'mp', id: 'mia' }],
})

const checkout = await api.createRecord('project', {
  name: 'Checkout',
  aliases: ['checkout-service', 'pay'],
  description: 'The payment flow: cart totals, card payments, refunds and daily payouts to merchants.',
  status: 'active',
  repositories: [{ url: 'https://git.example.com/shop/checkout.git', defaultBranch: 'main' }],
  egress: { allow: ['registry.npmjs.org', 'git.example.com:443', 'payments-sandbox.example.com:443'] },
  links: [{ system: 'chat', ref: '#requests' }],
})
const help = await api.createRecord('project', {
  name: 'Help Center',
  aliases: ['support site'],
  description: 'The public help site and the support team’s macros.',
  status: 'maintenance',
  repositories: [{ url: 'https://git.example.com/shop/help-center.git', defaultBranch: 'main' }],
  egress: { allow: ['registry.npmjs.org', 'cdn.example.com:443'] },
})

const link = (from: ApiRecord, to: ApiRecord, role: string) =>
  api.createLink(from.kind, from.id, { kind: to.kind, id: to.id }, role)
await link(dana, checkout, 'owner')
await link(tomas, checkout, 'member')
await link(leo, checkout, 'reviewer')
await link(priya, help, 'owner')
await link(mia, help, 'member')
await link(priya, checkout, 'stakeholder')

await api.createRecord('doc', {
  title: 'Checkout overview',
  path: 'overview',
  owner: { kind: 'project', id: checkout.id },
  body: [
    '# Checkout',
    '',
    `Owned by [[contact:${dana.id}]]; [[contact:${tomas.id}]] does most of the backend work and [[contact:${leo.id}]] reviews infrastructure changes.`,
    '',
    '## Payouts',
    '',
    'Payouts to merchants run daily at 06:00 UTC. A failed payout is retried twice, then it lands in the payouts queue for a person.',
    '',
    '## Refunds',
    '',
    `Refunds above $500 follow the refund procedure and need an approval from [[contact:${dana.id}]].`,
  ].join('\n'),
})
await api.createRecord('doc', {
  title: 'Runbook: failed payouts',
  path: 'runbooks/failed-payouts',
  owner: { kind: 'project', id: checkout.id },
  body: '# Failed payouts\n\n1. Check the payouts queue.\n2. Retry once by hand.\n3. If it fails again, post in #requests with the payout id.\n',
})
await api.createRecord('doc', {
  title: 'Help Center overview',
  path: 'overview',
  owner: { kind: 'project', id: help.id },
  body: `# Help Center\n\nMaintained by [[contact:${priya.id}]]. Articles are markdown in the repository; a merge to main publishes them.\n`,
})

await api.createRecord('procedure', {
  name: 'Refund above $500',
  applies: 'A customer asks for a refund of more than $500.',
  ownerId: dana.id,
  approvals: [{ contactId: dana.id }],
  body: [
    '1. Look up the order and the original payment.',
    '2. Check that the order is within the 30-day refund window.',
    `3. Ask [[contact:${dana.id}]] for approval in the thread.`,
    '4. Issue the refund and reply to the customer.',
  ].join('\n'),
  checklist: [
    { text: 'Order and payment found', required: true },
    { text: 'Within the 30-day window', required: true },
    { text: 'Approval from the Checkout owner', required: true, review: true },
    { text: 'Customer notified', required: false },
  ],
  skills: ['refund-lookup'],
  projectIds: [checkout.id],
})

await api.createRecord('skill', {
  name: 'refund-lookup',
  description: 'Find an order, its payment and earlier refunds in Checkout.',
  body: '# Refund lookup\n\nSearch by order id first, then by customer email. Earlier refunds are listed on the payment.\n',
  scope: { type: 'project', projectId: checkout.id },
})
await api.createRecord('skill', {
  name: 'release-notes',
  description: 'Write short release notes from a list of merged changes.',
  body: '# Release notes\n\nGroup changes into New, Improved and Fixed. One line each, in plain words, no ticket ids.\n',
  scope: { type: 'company' },
})

await api.createRecord('memory', {
  summary: 'Payouts run daily at 06:00 UTC',
  kind: 'fact',
  content: `Confirmed by [[contact:${leo.id}]]. The job is retried twice before it needs a person.`,
  scope: { type: 'project', id: checkout.id },
  source: { contactId: leo.id },
  verified: new Date().toISOString(),
})
await api.createRecord('memory', {
  summary: 'Priya prefers short bullet-point summaries',
  kind: 'preference',
  content: 'Keep updates to three bullets or fewer, with the decision first.',
  scope: { type: 'contact', id: priya.id },
  source: { contactId: priya.id },
})

await api.writeFile(
  employee.id,
  '/notes/checkout-2.4.md',
  '# Checkout 2.4\n\nMerged since 2.3:\n\n- Apple Pay on the payment page\n- Faster cart totals for large carts\n- Fix: refunds of partially shipped orders used the wrong amount\n',
)
await api.writeFile(employee.id, '/drafts/weekly-summary.md', '# Weekly summary\n\n_Draft._\n')

await api.createRecord('trigger', {
  name: 'Support tickets: new',
  employeeId: employee.id,
  enabled: true,
  priority: 0,
  match: { source: 'webhook', type: 'ticket.created' },
  target: { type: 'router' },
  fork: false,
  mode: 'ephemeral',
  fired: 0,
})

await api.createChannel({
  name: 'payments',
  topic: 'Checkout, refunds and payouts.',
  members: [{ type: 'employee', id: employee.id, label: '' }],
})
const dm = await api.createChannel({
  name: `dm-${employee.key ?? 'employee'}-dana`,
  dm: true,
  members: [{ type: 'employee', id: employee.id, label: '' }],
})

console.log(JSON.stringify({ employee: employee.id, dana: dana.id, checkout: checkout.id, help: help.id, dm: dm.id }))
