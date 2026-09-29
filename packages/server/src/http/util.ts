import type { ApiErrorBody, ApiErrorCode } from '@mp/api'
import { MpError, ValidationError, type Logger } from '@mp/core'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/** A request problem the client can fix (malformed JSON, bad query parameter): 400. */
export class BadRequestError extends MpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('bad_request', message, details)
  }
}

const STATUS: Record<string, [number, ApiErrorCode]> = {
  bad_request: [400, 'bad_request'],
  validation: [422, 'validation'],
  unauthorized: [401, 'unauthorized'],
  denied: [403, 'denied'],
  not_found: [404, 'not_found'],
  conflict: [409, 'conflict'],
  limit: [429, 'denied'],
  unavailable: [503, 'unavailable'],
}

/**
 * Maps typed errors to HTTP responses (see `@mp/api` errors.ts): not found 404,
 * validation 422 (issues in `details`), conflict 409, denied 403, limit 429,
 * unavailable 503, anything else 500 with a generic message and no stack.
 */
export function errorResponse(err: unknown, logger: Logger): { status: number; body: { error: ApiErrorBody } } {
  if (err instanceof MpError) {
    const [status, code] = STATUS[err.code] ?? [500, 'internal']
    if (status >= 500) logger.error('request failed', { code: err.code, err: err.message })
    const details =
      err instanceof ValidationError
        ? { issues: err.issues, ...(err.details ?? {}) }
        : err.details && Object.keys(err.details).length
          ? err.details
          : undefined
    return {
      status,
      body: { error: { code, message: status === 500 ? 'internal error' : err.message, ...(details ? { details } : {}) } },
    }
  }
  logger.error('request failed', { err })
  return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } }
}

export function sendError(c: Context, err: unknown, logger: Logger) {
  const r = errorResponse(err, logger)
  return c.json(r.body, r.status as ContentfulStatusCode)
}

/** The JSON body, or a 400. An empty body is `{}`. */
export async function jsonBody<T = Record<string, unknown>>(c: Context): Promise<T> {
  const text = await c.req.text()
  if (!text.trim()) return {} as T
  try {
    const v = JSON.parse(text)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
    return v as T
  } catch {
    throw new BadRequestError('the request body must be a JSON object')
  }
}

/** An integer query parameter within bounds, or the default. */
export function intParam(v: string | undefined, name: string, def: number, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  if (v === undefined || v === '') return def
  const n = Number(v)
  if (!Number.isInteger(n) || n < min) throw new BadRequestError(`${name} must be an integer >= ${min}`)
  return Math.min(n, max)
}

export function boolParam(v: string | undefined): boolean {
  return v === 'true' || v === '1' || v === 'yes'
}

export function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new BadRequestError(`${name} is required`)
  return v
}
