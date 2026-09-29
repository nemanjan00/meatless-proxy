import { errorMessage, type Logger } from '@mp/core'
import type { ChatAttachments } from '@mp/chat'
import { type FileStorage, prepareImage, sha256Hex } from '@mp/files'
import { knownVisionModel, type ImageRef, type ModelClient } from '@mp/model'
import type { WorkerHandle } from '@mp/queue'
import type { LoadedImage } from '@mp/runner'
import type { Config } from './config.ts'

/** Whether the model can see images, and why we think so. */
export interface VisionSettings {
  enabled: boolean
  /** `config` (MODEL_VISION), `provider` (its model list), or `name` (a known vision model). */
  source: 'config' | 'provider' | 'name'
  /** Images are downscaled to this many pixels on the longest side. */
  maxSide: number
  /** Images over this many bytes (after downscaling) aren't sent. */
  maxBytes: number
}

/**
 * MODEL_VISION: `on` or `off` as configured; `auto` asks the provider (its `/models` list, with a
 * few seconds' patience) and falls back to the model's name.
 */
export async function resolveVision(
  config: Pick<Config, 'MODEL_VISION' | 'MODEL_IMAGE_MAX_SIDE' | 'MODEL_IMAGE_MAX_BYTES'>,
  model: ModelClient,
  logger: Logger,
  opts: { timeoutMs?: number } = {},
): Promise<VisionSettings> {
  const limits = { maxSide: config.MODEL_IMAGE_MAX_SIDE, maxBytes: config.MODEL_IMAGE_MAX_BYTES }
  if (config.MODEL_VISION !== 'auto') return { enabled: config.MODEL_VISION === 'on', source: 'config', ...limits }
  let said: boolean | undefined
  if (model.capabilities) {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), opts.timeoutMs ?? 5000)
    })
    try {
      said = (await Promise.race([model.capabilities(), timeout]))?.vision
    } catch (err) {
      logger.debug('model capabilities failed', { err: errorMessage(err) })
    } finally {
      clearTimeout(timer)
    }
  }
  const out: VisionSettings =
    said === undefined
      ? { enabled: knownVisionModel(model.defaultModel), source: 'name', ...limits }
      : { enabled: said, source: 'provider', ...limits }
  logger.info('model vision', { model: model.defaultModel, enabled: out.enabled, source: out.source })
  return out
}

/**
 * Loads the image a history refers to, for a model request: an attachment's bytes or an employee's
 * file, only if its sha256 still matches (a changed file is not the image the model looked at), then
 * downscaled to `maxSide` and refused over `maxBytes`.
 */
export function imageLoader(o: {
  attachments: ChatAttachments
  storage: FileStorage
  maxSide: number
  maxBytes: number
}): (ref: ImageRef) => Promise<LoadedImage | null> {
  return async (ref) => {
    let bytes: Uint8Array | null = null
    if (ref.source === 'attachment' && ref.id) bytes = (await o.attachments.read(ref.id))?.bytes ?? null
    else if (ref.source === 'file' && ref.owner && ref.path) bytes = await o.storage.read(ref.owner, ref.path).catch(() => null)
    if (!bytes || sha256Hex(bytes) !== ref.sha256) return null
    const img = prepareImage(bytes, { maxSide: o.maxSide })
    if (!img || img.bytes.length > o.maxBytes) return null
    return {
      mime: img.mime,
      data: Buffer.from(img.bytes).toString('base64'),
      ...(img.width ? { width: img.width } : {}),
      ...(img.height ? { height: img.height } : {}),
    }
  }
}

/** Deletes chat uploads nobody attached, every `everyMs` (default 10 minutes). */
export function startAttachmentCleanup(
  attachments: ChatAttachments,
  logger: Logger,
  opts: { everyMs?: number } = {},
): WorkerHandle {
  const tick = () =>
    attachments
      .cleanup()
      .then((n) => {
        if (n) logger.info('orphaned chat uploads removed', { count: n })
      })
      .catch((err) => logger.warn('chat upload cleanup failed', { err: errorMessage(err) }))
  let running = tick()
  const timer = setInterval(
    () => {
      running = running.then(tick)
    },
    opts.everyMs ?? 10 * 60_000,
  )
  timer.unref?.()
  return {
    async close() {
      clearInterval(timer)
      await running
    },
  }
}
