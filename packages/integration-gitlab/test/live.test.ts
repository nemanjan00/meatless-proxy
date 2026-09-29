import { describe, expect, it } from 'vitest'
import { createGitlabIntegration } from '../src/index.ts'

// Opt-in: one harmless read (GET /user) against a real GitLab. Needs MP_LIVE_GITLAB=1 and
// GITLAB_TOKEN; GITLAB_BASE_URL is optional (default https://gitlab.com).
const live = process.env.MP_LIVE_GITLAB === '1'

describe.skipIf(!live)('GitLab live smoke test (MP_LIVE_GITLAB=1)', () => {
  it('reads the current user', { timeout: 30_000 }, async () => {
    const token = process.env.GITLAB_TOKEN
    if (!token) throw new Error('set GITLAB_TOKEN')
    const gitlab = createGitlabIntegration({
      secrets: { token, webhookSecret: 'unused' },
      ...(process.env.GITLAB_BASE_URL ? { baseUrl: process.env.GITLAB_BASE_URL } : {}),
      retry: { maxRetries: 1 },
    })
    const me = await gitlab.client.get('/user')
    expect(typeof me.username).toBe('string')
    expect(await gitlab.resolveUser!(me.username)).toMatchObject({ handle: { system: 'gitlab', id: me.username } })
  })
})
