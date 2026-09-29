import { createHmac, timingSafeEqual } from 'node:crypto'

/** How far a request timestamp may be from now: Slack's recommended 5 minutes. */
export const MAX_SIGNATURE_AGE_SECONDS = 300

/** The `X-Slack-Signature` value for a body: `v0=` + hex HMAC-SHA256 of `v0:<timestamp>:<body>`. */
export function signSlackRequest(signingSecret: string, timestamp: string | number, body: string): string {
  return `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`
}

export type SignatureCheck = { ok: true } | { ok: false; reason: 'missing' | 'stale' | 'mismatch' }

/**
 * Verifies a Slack request signature (v0), in constant time. Rejects a missing
 * signature or timestamp, and a timestamp more than 5 minutes from `nowMs`.
 */
export function verifySlackSignature(input: {
  signingSecret: string
  signature: string | undefined
  timestamp: string | undefined
  body: string
  nowMs: number
  maxAgeSeconds?: number
}): SignatureCheck {
  const { signature, timestamp } = input
  if (!signature || !timestamp || !input.signingSecret) return { ok: false, reason: 'missing' }
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'stale' }
  const age = Math.abs(Math.floor(input.nowMs / 1000) - Number(timestamp))
  if (age > (input.maxAgeSeconds ?? MAX_SIGNATURE_AGE_SECONDS)) return { ok: false, reason: 'stale' }
  const expected = Buffer.from(signSlackRequest(input.signingSecret, timestamp, input.body), 'utf8')
  const given = Buffer.from(signature, 'utf8')
  // Equal lengths first: timingSafeEqual throws otherwise. The length of a valid signature is public anyway.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'mismatch' }
  return { ok: true }
}
