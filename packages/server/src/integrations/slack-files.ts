import { errorMessage, isMpError, type Json, type Logger } from '@mp/core'
import { encodeContent, type FilesService, sniffFile } from '@mp/files'
import { SLACK_FILE_MAX_BYTES, type SlackIntegration } from '@mp/integration-slack'
import type { ToolHandler, ToolResult } from '@mp/tools'
import type { IntegrationInstance } from './instances.ts'

/** Text files up to this size come back inline too. */
export const SLACK_TEXT_INLINE_MAX_BYTES = 64 * 1024
/** Longest inline text, in characters. */
const TEXT_INLINE_MAX_CHARS = 16_000

/** A file name safe as one path segment: letters, digits, `.`, `_` and `-`, at most 100 characters. */
export function safeFileName(name: string): string {
  const clean = name
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-100)
  return clean || 'file'
}

/** Where a Slack file is saved in the employee's files. */
export const slackFilePath = (id: string, name: string) => `/slack/${id}-${safeFileName(name)}`

/**
 * `mcp.slack.get_file`, done by the server: the Slack integration downloads the file (Slack's
 * hosts only, at most 25 MB) and it's written into the calling employee's own files, so the bytes
 * never pass through the model. The model gets `{ path, name, mime, size }`, and the text of a
 * small text file.
 */
export function slackGetFileHandler(deps: {
  instanceFor(employeeId: string): Promise<IntegrationInstance>
  files: FilesService
  logger: Logger
}): ToolHandler {
  return async (args, ctx): Promise<ToolResult> => {
    const fileId = typeof args?.file_id === 'string' ? args.file_id.trim() : ''
    if (!fileId) return { output: { error: 'file_id is required, e.g. F0123ABCD' }, isError: true }
    const instance = await deps.instanceFor(ctx.employeeId)
    if (!instance.hasToken)
      return { output: { error: "Slack isn't set up for this employee: set the SLACK_BOT_TOKEN secret" }, isError: true }
    const slack = instance.integration as SlackIntegration
    try {
      const file = await slack.downloadFile(fileId, { maxBytes: SLACK_FILE_MAX_BYTES, signal: ctx.signal })
      const info = sniffFile(file.bytes, file.name)
      const path = slackFilePath(file.id, file.name)
      const { content, encoding } = encodeContent(file.bytes)
      await deps.files.write(ctx.employeeId, path, content, {
        encoding,
        mime: info.mime,
        actor: { type: 'session', id: ctx.sessionId },
      })
      const out: Record<string, Json> = { path, name: file.name, mime: info.mime, size: file.bytes.byteLength }
      if (info.kind === 'image') out.view = `image.view { path: "${path}" }`
      if (info.text && file.bytes.byteLength <= SLACK_TEXT_INLINE_MAX_BYTES) {
        const text = new TextDecoder().decode(file.bytes)
        out.text = text.length > TEXT_INLINE_MAX_CHARS ? text.slice(0, TEXT_INLINE_MAX_CHARS) : text
        if (text.length > TEXT_INLINE_MAX_CHARS) out.truncated = true
      }
      return { output: out }
    } catch (err) {
      deps.logger.warn('slack get_file failed', { fileId, err: errorMessage(err) })
      return {
        output: { error: isMpError(err) ? err.code : 'error', message: errorMessage(err) },
        isError: true,
      }
    }
  }
}
