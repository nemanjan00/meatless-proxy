/**
 * Screenshots of every page of a running server, in dark and light, with a
 * report of console errors and horizontal overflow. Uses playwright-core with
 * a system Chromium (no browser download).
 *
 *   npx tsx packages/web/scripts/screenshots.ts [options]
 *
 *   --base http://localhost:3000   the server
 *   --out  <dir>                   where to write PNGs (default: packages/web/docs/screenshots)
 *   --only now,usage               only these shots
 *   --themes dark,light            default both
 *   --width 1440 --height 900      viewport (e.g. --width 390 for phones)
 *   --all                          every page (default: the README set)
 *   --chromium /usr/bin/chromium   the browser binary (or $CHROMIUM)
 *
 * Seed data first with scripts/seed-demo.ts.
 */
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createApiClient } from '@mp/api'
import { chromium, type Page } from 'playwright-core'

const { values: args } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:3000' },
    out: { type: 'string', default: fileURLToPath(new URL('../docs/screenshots', import.meta.url)) },
    only: { type: 'string' },
    themes: { type: 'string', default: 'dark,light' },
    width: { type: 'string', default: '1440' },
    height: { type: 'string', default: '900' },
    all: { type: 'boolean', default: false },
    chromium: { type: 'string', default: process.env.CHROMIUM ?? '/usr/bin/chromium' },
  },
})

const api = createApiClient({ baseUrl: args.base! })
const sessions = (await api.listSessions({ limit: 100 })).items
const router = sessions.find((s) => s.session.data.slug === 'router') ?? sessions[0]
const work = sessions.find((s) => s.session.data.slug !== 'router') ?? router
const first = async (kind: string) =>
  (await api.listRecords(kind, { orderBy: 'createdAt', dir: 'asc', limit: 1 })).items[0]?.id ?? ''
const channels = await api.channels()
const requests = channels.find((c) => c.channel.data.name === 'requests')?.channel.id ?? channels[0]?.channel.id ?? ''
const messages = requests ? await api.channelMessages(requests) : []
const thread = messages.at(-1)?.id ?? ''
const contacts = (await api.listRecords<{ name: string; kind?: string }>('contact', { limit: 100 })).items
const contact = contacts.find((c) => c.data.kind !== 'ai' && c.data.name !== 'Web user')?.id ?? ''

const r = router?.session.id ?? ''
const w = work?.session.id ?? ''
/** name → path, and whether it's in the README set. */
/** Interactions before a shot. */
const typeInComposer = (text: string) => async (page: Page) => {
  await page.getByRole('textbox', { name: 'Message', exact: true }).first().click()
  await page.keyboard.type(text)
}
const hoverLastMessage = async (page: Page) => {
  const msgs = page.getByTestId('chat-message')
  await msgs.nth(Math.max(0, (await msgs.count()) - 1)).hover()
}
const DM = channels.find((c) => c.channel.data.dm)?.channel.id ?? requests
const dmThread = (DM ? await api.channelMessages(DM) : [])[0]?.id ?? ''

/** name, path, in the README set, and an optional interaction. */
const SHOTS: [string, string, boolean, ((page: Page) => Promise<void>)?][] = [
  ['inbox', '/inbox', false],
  ['now', '/now', false],
  ['sessions', '/sessions', true],
  ['session-detail', `/sessions/${w}?tab=history`, true],
  ['session-history', `/sessions/${r}?tab=history`, true],
  ['entry-tree', `/sessions/${r}?tab=branches`, true],
  ['session-tree', `/sessions/${r}?tab=tree`, true],
  ['session-runs', `/sessions/${r}?tab=runs`, false],
  ['session-checklist', `/sessions/${w}?tab=checklist`, false],
  ['session-threads', `/sessions/${r}?tab=threads`, false],
  ['session-usage', `/sessions/${r}?tab=usage`, false],
  ['lineage', `/lineage/${w}`, true],
  ['triggers', '/triggers', true],
  ['events', '/events', false],
  ['chat', `/chat/${requests}/${thread}`, true],
  ['chat-autocomplete', `/chat/${requests}`, true, typeInComposer('Can you check this @')],
  [
    'chat-search',
    `/chat/${requests}`,
    true,
    async (page) => {
      await page.keyboard.press('/')
      await page.keyboard.type('release notes')
      await page.waitForTimeout(500)
    },
  ],
  ['chat-dm', `/chat/${DM}/${dmThread}`, true, hoverLastMessage],
  [
    'chat-new-message',
    `/chat/${requests}`,
    false,
    async (page) => {
      await page.getByRole('button', { name: 'New message' }).first().click()
    },
  ],
  ['projects', '/projects', false],
  ['project', `/projects/${await first('project')}`, true],
  ['procedures', '/procedures', false],
  ['procedure', `/procedures/${await first('procedure')}`, false],
  ['contacts', '/contacts', false],
  ['contact', `/contacts/${contact}`, false],
  ['memory', '/memory', false],
  ['skills', '/skills', false],
  ['files', `/files?path=${encodeURIComponent('/drafts/checkout-2.4-release-notes.md')}`, false],
  ['usage', '/usage', true],
  ['usage-24h', '/usage?range=24h', false],
  ['settings', '/settings', false],
]

const only = args.only ? new Set(args.only.split(',')) : null
const shots = SHOTS.filter(([name, , readme]) => (only ? only.has(name) : args.all || readme))
const width = Number(args.width)
const suffix = width === 1440 ? '' : `-${width}`
mkdirSync(args.out!, { recursive: true })

const browser = await chromium.launch({ executablePath: args.chromium })
const problems: string[] = []
for (const theme of args.themes!.split(',') as ('dark' | 'light')[]) {
  const context = await browser.newContext({ viewport: { width, height: Number(args.height) }, colorScheme: theme })
  const page = await context.newPage()
  let errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text().slice(0, 300)}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  for (const [name, path, , act] of shots) {
    errors = []
    await page.goto(`${args.base}${path}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)
    if (act) {
      await act(page)
      await page.waitForTimeout(400)
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    await page.screenshot({ path: `${args.out}/${name}-${theme}${suffix}.png` })
    if (errors.length) problems.push(`${name}-${theme}: ${errors.join(' | ')}`)
    if (overflow > 0) problems.push(`${name}-${theme}: scrolls horizontally by ${overflow}px`)
  }
  await context.close()
}
await browser.close()
console.log(problems.length ? problems.join('\n') : `ok: ${shots.length} pages, no console errors, no horizontal scroll`)
