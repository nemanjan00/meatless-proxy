import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { serveWeb } from '../src/http/static.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function web() {
  const dir = mkdtempSync(join(tmpdir(), 'mp-web-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>vegan</title>')
  writeFileSync(join(dir, 'assets', 'now-abc.js'), 'export const x = 1')
  writeFileSync(join(dir, 'version.json'), '{"version":"abc"}\n')
  const app = new Hono()
  expect(serveWeb(app, dir)).toBe(true)
  return app
}

describe('the web build', () => {
  it('serves pages as index.html, but a missing chunk as a 404 (a new deployment replaced it)', async () => {
    const app = web()
    const page = await app.request('/chat/chn_1')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<title>vegan</title>')
    const chunk = await app.request('/assets/now-abc.js')
    expect([chunk.status, chunk.headers.get('content-type'), chunk.headers.get('cache-control')]).toEqual([
      200,
      'text/javascript; charset=utf-8',
      'public, max-age=31536000, immutable',
    ])
    const gone = await app.request('/assets/now-old.js')
    expect(gone.status).toBe(404)
    expect(await gone.text()).not.toContain('<title>')
  })

  it('serves version.json uncached, so an open tab sees a new deployment', async () => {
    const res = await web().request('/version.json')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ version: 'abc' })
  })
})
