import { afterEach, describe, expect, it } from 'vitest'
import { testApp } from './helpers.ts'

let app: Awaited<ReturnType<typeof testApp>> | null = null
afterEach(async () => {
  await app?.close()
  app = null
})

describe('the HTTP server and the global Response', () => {
  it('leaves Request and Response alone, so a fetch still answers with an instanceof Response', async () => {
    const { Request: NativeRequest, Response: NativeResponse } = globalThis
    app = await testApp({ http: true, workers: false })
    expect(globalThis.Request).toBe(NativeRequest)
    expect(globalThis.Response).toBe(NativeResponse)
    const res = await fetch(`http://127.0.0.1:${app.port}/healthz`)
    expect(res).toBeInstanceOf(Response)
    expect(res.ok).toBe(true)
  })
})
