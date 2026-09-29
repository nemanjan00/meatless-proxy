import { errorMessage, silentLogger, type Logger } from '@mp/core'
import type { ChatMessage, ImagePart, ImageRef } from '@mp/model'

/** Tools with this tag need a model that can see images (e.g. `image.view`). */
export const VISION_TAG = 'vision'

/** An image's bytes, ready for a request. */
export interface LoadedImage {
  mime: string
  /** Base64. */
  data: string
  /** Of what is sent, when it was downscaled. */
  width?: number
  height?: number
}

export interface ImageResolverOptions {
  vision: boolean
  load?: (ref: ImageRef) => Promise<LoadedImage | null>
  /** Images kept in memory between steps. Default 32. */
  cacheSize?: number
  logger?: Logger
}

const refKey = (r: ImageRef) => `${r.source}:${r.id ?? `${r.owner}:${r.path}`}:${r.sha256}`

/**
 * Fills in the bytes of the images a rendered history refers to, just before a model call. Same
 * reference, same bytes (the loader checks the sha256), so a cached prefix with images stays valid.
 * Without vision, images are dropped and the message says so. Returns new messages; the input is
 * left alone.
 */
export function createImageResolver(o: ImageResolverOptions): (messages: ChatMessage[]) => Promise<ChatMessage[]> {
  const cache = new Map<string, LoadedImage | null>()
  const max = o.cacheSize ?? 32
  const log = o.logger ?? silentLogger

  const load = async (ref: ImageRef): Promise<LoadedImage | null> => {
    const key = refKey(ref)
    if (cache.has(key)) {
      const hit = cache.get(key)!
      cache.delete(key)
      cache.set(key, hit)
      return hit
    }
    let img: LoadedImage | null = null
    try {
      img = o.load ? await o.load(ref) : null
    } catch (err) {
      log.warn('image could not be loaded', { ref: key, err: errorMessage(err) })
    }
    // Only hits are cached: a missing image may come back (e.g. a file restored).
    if (img) {
      cache.set(key, img)
      if (cache.size > max) cache.delete(cache.keys().next().value!)
    }
    return img
  }

  return async (messages) => {
    if (!messages.some((m) => m.images?.length)) return messages
    const out: ChatMessage[] = []
    for (const m of messages) {
      if (!m.images?.length) {
        out.push(m)
        continue
      }
      if (!o.vision) {
        const { images, ...rest } = m
        const note = `[${images.length === 1 ? 'an image' : `${images.length} images`} not shown: this model can't see images]`
        out.push({ ...rest, content: rest.content ? `${rest.content}\n${note}` : note })
        continue
      }
      const images: ImagePart[] = []
      for (const part of m.images) {
        if (part.data || !part.ref) {
          images.push(part)
          continue
        }
        const img = await load(part.ref)
        const { data: _, ...meta } = part
        images.push(
          img
            ? {
                ...meta,
                mime: img.mime,
                data: img.data,
                ...(img.width ? { width: img.width } : {}),
                ...(img.height ? { height: img.height } : {}),
              }
            : meta,
        )
      }
      out.push({ ...m, images })
    }
    return out
  }
}
