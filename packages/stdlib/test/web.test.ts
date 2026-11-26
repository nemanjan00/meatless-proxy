import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { htmlToText } from '../src/html-text.ts'
import type { FetchOptions, WebFetcher } from '../src/web-fetch.ts'
import { WebFetchError, fetchPublic } from '../src/web-fetch.ts'
import { stack } from './helpers.ts'

const PAGE = `<!doctype html><html><head><title>Refunds &amp; returns</title><style>.x{}</style></head><body>
<nav><a href="/">Home</a></nav>
<h1>Refunds</h1><p>Refunds take <b>5&nbsp;days</b>. See <a href="/terms">the terms</a>.</p>
<ul><li>Cards</li><li>PayPal</li></ul>
<table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$10</td></tr></table>
<script>alert('x')</script><img src="a.png" alt="A chart"><footer>© Example</footer></body></html>`

/** A fetcher that serves `pages` by URL, checking each URL as the real one does. */
const fake =
  (pages: Record<string, { type: string; body: string; status?: number }>, seen: string[] = []): WebFetcher =>
  async (url: string, opts: FetchOptions) => {
    const why = opts.check(new URL(url))
    if (why) throw new WebFetchError(why)
    seen.push(url)
    const p = pages[url]
    if (!p) throw new WebFetchError(`couldn't fetch ${url}: ENOTFOUND`)
    return { url, status: p.status ?? 200, contentType: p.type, body: new TextEncoder().encode(p.body), truncated: false }
  }

describe('html to text', () => {
  it('keeps the words, structure and links, and drops scripts, styles and chrome', () => {
    const { title, text } = htmlToText(PAGE, 'https://shop.example.com/help/refunds')
    expect(title).toBe('Refunds & returns')
    expect(text).toBe(
      [
        '# Refunds',
        '',
        'Refunds take 5 days. See the terms (https://shop.example.com/terms).',
        '',
        '- Cards',
        '- PayPal',
        '',
        'Plan | Price',
        'Pro | $10',
        '',
        '[image: A chart]',
      ].join('\n'),
    )
    expect(text).not.toMatch(/alert|Home|Example|\.x\{/)
  })

  it('keeps preformatted lines and decodes numeric entities', () => {
    expect(htmlToText('<p>a &#8594; b &#x2014; c</p><pre>line 1\n  line 2</pre>').text).toBe('a → b — c\n\nline 1\n line 2')
  })
})

describe('web.fetch', () => {
  it("reads a page as text on a direct network, and it's a read tool", async () => {
    const t = await stack()
    await t.directory.employees.update(t.employee.id, { network: 'direct' })
    t.deps.webFetch = fake({ 'https://shop.example.com/refunds': { type: 'text/html; charset=utf-8', body: PAGE } })
    const r = await t.out('web.fetch', { url: 'https://shop.example.com/refunds' })
    expect(r).toMatchObject({ status: 200, contentType: 'text/html', title: 'Refunds & returns', chars: expect.any(Number) })
    expect(r.text).toContain('Refunds take 5 days')
    expect(r.more).toBeUndefined()
    expect(t.tools.get('web.fetch')!.def.effect).toBe('read')
  })

  it('pages through long text with offset, and returns JSON as it is', async () => {
    const t = await stack()
    await t.directory.employees.update(t.employee.id, { network: 'direct' })
    const long = 'x'.repeat(2500)
    t.deps.webFetch = fake({
      'https://a.example.com/long.txt': { type: 'text/plain', body: long },
      'https://a.example.com/data': { type: 'application/json', body: '{"ok":true}' },
    })
    const first = await t.out('web.fetch', { url: 'https://a.example.com/long.txt', max_chars: 1000 })
    expect(first.text).toHaveLength(1000)
    expect(first.more).toMatch(/^1500 more characters: call again with offset 1000/)
    const next = await t.out('web.fetch', { url: 'https://a.example.com/long.txt', max_chars: 1000, offset: 2000 })
    expect(next.text).toHaveLength(500)
    expect(next.more).toBeUndefined()
    expect((await t.out('web.fetch', { url: 'https://a.example.com/data' })).text).toBe('{"ok":true}')
  })

  it('refuses files, pointing at an environment', async () => {
    const t = await stack()
    await t.directory.employees.update(t.employee.id, { network: 'direct' })
    t.deps.webFetch = fake({ 'https://a.example.com/r.pdf': { type: 'application/pdf', body: '%PDF' } })
    const r = await t.call('web.fetch', { url: 'https://a.example.com/r.pdf' })
    expect(r.isError).toBe(true)
    expect((r.output as { error: string }).error).toMatch(/application\/pdf file .*env\.exec: curl/)
  })

  it('follows the network setting: none refuses, an allowlist allows only its hosts', async () => {
    const t = await stack()
    const seen: string[] = []
    t.deps.webFetch = fake({ 'https://docs.example.com/a': { type: 'text/plain', body: 'hi' } }, seen)
    await t.directory.employees.update(t.employee.id, { network: 'none' })
    const none = await t.call('web.fetch', { url: 'https://docs.example.com/a' })
    expect((none.output as { error: string }).error).toContain("this employee's network setting is none")
    await t.directory.employees.update(t.employee.id, { network: { allow: ['docs.example.com'] } })
    expect((await t.out('web.fetch', { url: 'https://docs.example.com/a' })).text).toBe('hi')
    const other = await t.call('web.fetch', { url: 'https://evil.example.net/' })
    expect((other.output as { error: string }).error).toMatch(/evil\.example\.net isn't on your network allowlist/)
    expect(seen).toEqual(['https://docs.example.com/a'])
  })

  it('summarizes, or answers a question from the page, with the text it was given', async () => {
    const t = await stack()
    await t.directory.employees.update(t.employee.id, { network: 'direct' })
    t.deps.webFetch = fake({ 'https://shop.example.com/refunds': { type: 'text/html', body: PAGE } })
    const asked: { text: string; question?: string; source: string }[] = []
    t.deps.summarize = async ({ text, question, source }) => {
      asked.push({ text, ...(question ? { question } : {}), source })
      return question ? 'Five days.' : 'A refunds page.'
    }
    const s = await t.out('web.fetch', { url: 'https://shop.example.com/refunds', summarize: true })
    expect(s).toMatchObject({ summary: 'A refunds page.', title: 'Refunds & returns' })
    expect(s.text).toBeUndefined()
    const q = await t.out('web.fetch', { url: 'https://shop.example.com/refunds', summarize: 'how long do refunds take?' })
    expect(q.answer).toBe('Five days.')
    expect(asked[1]).toMatchObject({ question: 'how long do refunds take?', source: 'https://shop.example.com/refunds' })
    expect(asked[0]!.text).toContain('Refunds take 5 days')
    delete t.deps.summarize
    const off = await t.call('web.fetch', { url: 'https://shop.example.com/refunds', summarize: true })
    expect((off.output as { error: string }).error).toMatch(/summaries are off/)
  })

  it('a router context does not get it', async () => {
    const { ROUTER_EXCLUDED_TOOLS } = await import('../src/toolsets.ts')
    expect(ROUTER_EXCLUDED_TOOLS).toContain('web.**')
  })
})

describe('fetching public hosts only', () => {
  const all: FetchOptions = { check: () => null }

  it('refuses private, loopback and local addresses, and other schemes', async () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://localhost:3000/',
      'http://[::1]/',
      'http://10.0.0.5/',
      'http://169.254.169.254/latest',
    ])
      await expect(fetchPublic(url, all)).rejects.toThrow(/private address/)
    await expect(fetchPublic('file:///etc/passwd', all)).rejects.toThrow(/only http and https/)
    await expect(fetchPublic('https://user:pw@example.com/', all)).rejects.toThrow(/credentials/)
  })

  it('refuses a name that resolves to a private address, without connecting', async () => {
    let hits = 0
    const server = createServer((_q, s) => {
      hits++
      s.end('secret')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      // localhost.localtest.me-style names aren't needed: a .localhost name is refused by name, and
      // the lookup refuses what resolves to loopback.
      await expect(fetchPublic(`http://app.localhost:${port}/`, all)).rejects.toThrow(/private address/)
      expect(hits).toBe(0)
    } finally {
      server.close()
    }
  })

  it('checks every URL, the first one included', async () => {
    await expect(fetchPublic('https://example.com/', { check: () => 'not allowed here' })).rejects.toThrow('not allowed here')
  })
})
