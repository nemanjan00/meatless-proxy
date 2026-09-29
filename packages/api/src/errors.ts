/**
 * Error responses. Every non-2xx response has the body `{ error: ApiErrorBody }`.
 * The server maps the typed errors of @mp/core to these codes and statuses.
 */
export type ApiErrorCode =
  | 'bad_request'
  | 'validation'
  | 'unauthorized'
  | 'denied'
  | 'not_found'
  | 'conflict'
  | 'unavailable'
  | 'internal'

export const ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  validation: 422,
  unauthorized: 401,
  denied: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  internal: 500,
}

export interface ApiErrorBody {
  code: ApiErrorCode
  message: string
  /** e.g. validation issues, or the current version on a conflict. */
  details?: unknown
}

/** Thrown by the client for non-2xx responses and network failures (`status` 0). */
export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError'
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

/** The code for an HTTP status, for responses without a well-formed error body. */
export function codeForStatus(status: number): ApiErrorCode {
  const hit = (Object.entries(ERROR_STATUS) as [ApiErrorCode, number][]).find(([, s]) => s === status)
  if (hit) return hit[0]
  return status >= 500 ? 'internal' : 'bad_request'
}
