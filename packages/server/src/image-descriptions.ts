import {
  type Attachment,
  type ChatAttachments,
  type DescribeAttribution,
  type ImageDescriber,
  type ImageDescribeMode,
  attachmentLine,
  attachmentView,
  createImageDescriber,
} from '@mp/chat'
import { errorMessage, type EventBus, type Clock, type Logger } from '@mp/core'
import type { MpEvent } from '@mp/events'
import type { ModelClient } from '@mp/model'
import type { Queue, WorkerHandle } from '@mp/queue'
import type { Records } from '@mp/records'
import type { Sessions } from '@mp/sessions'
import type { Ref } from '@mp/store'
import type { UsageService } from '@mp/usage'

/** The queue of background describe jobs (`IMAGE_DESCRIBE=upload`). */
export const DESCRIBE_QUEUE = 'images'

export interface DescriberDeps {
  records: Records
  attachments: ChatAttachments
  model: ModelClient
  sessions: Sessions
  usage: UsageService
  clock: Clock
  logger: Logger
  bus: EventBus
  mode: ImageDescribeMode
  modelName?: string | undefined
  vision: { enabled: boolean; maxSide: number; maxBytes: number }
}

/** The image describer, recording each call's usage like any other model call (attributed to its session, or the system). */
export function buildDescriber(d: DescriberDeps): ImageDescriber {
  return createImageDescriber({
    records: d.records,
    attachments: d.attachments,
    model: d.model,
    ...(d.modelName ? { modelName: d.modelName } : {}),
    mode: d.mode,
    vision: d.vision.enabled,
    maxSide: d.vision.maxSide,
    maxBytes: d.vision.maxBytes,
    clock: d.clock,
    logger: d.logger,
    bus: d.bus,
    async onUsage({ usage: u, model, by }) {
      const session = by.sessionId ? await d.sessions.get(by.sessionId) : null
      const employeeId = by.employeeId ?? session?.data.employeeId
      const rootSessionId = by.rootSessionId ?? session?.data.rootId
      await d.usage.record({
        ...(by.runId ? { runId: by.runId } : {}),
        ...(by.sessionId ? { sessionId: by.sessionId } : {}),
        ...(rootSessionId ? { rootSessionId } : {}),
        ...(employeeId ? { employeeId } : {}),
        ...(by.requesterId ? { requesterId: by.requesterId } : {}),
        model,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        cachedTokens: u.cachedTokens,
        reasoningTokens: u.reasoningTokens,
        totalTokens: u.totalTokens,
      })
    },
  })
}

/** Who a background description is for: the uploader (a session, or the contact it was for). */
export function attributionOf(uploader: Ref): DescribeAttribution {
  if (uploader.kind === 'session') return { sessionId: uploader.id }
  if (uploader.kind === 'contact') return { requesterId: uploader.id }
  return {}
}

/**
 * `IMAGE_DESCRIBE=upload`: a posted message's images go on the describe queue, one job per image
 * (the job id is the attachment id, so a second add does nothing).
 */
export function enqueueDescriptions(queue: Queue, describer: () => ImageDescriber | null, logger: Logger) {
  return async (_message: unknown, attachments: Attachment[]) => {
    const d = describer()
    if (d?.mode !== 'upload' || !d.available) return
    for (const a of attachments) {
      if (a.description) continue
      await queue
        .add(DESCRIBE_QUEUE, { attachmentId: a.id }, { jobId: `describe:${a.id}`, attempts: 3, backoffMs: 5000 })
        .catch((err) => logger.warn('describe job not queued', { attachmentId: a.id, err: errorMessage(err) }))
    }
  }
}

/** Describes queued images. A failed description throws, so the job is retried (and a later image.view tries again too). */
export function startDescribeWorker(
  queue: Queue,
  attachments: ChatAttachments,
  describer: ImageDescriber,
  logger: Logger,
): WorkerHandle {
  return queue.process<{ attachmentId: string }>(
    DESCRIBE_QUEUE,
    async (job) => {
      const a = await attachments.get(job.data.attachmentId)
      if (!a?.data.messageId || !describer.available) return
      const out = await describer.describeAttachment(a.id, { by: attributionOf(a.data.uploadedBy) })
      if (!out.ok) {
        logger.warn('background image description failed', { attachmentId: a.id, attempt: job.attempt, reason: out.reason })
        if (!/not found|no longer available/.test(out.reason)) throw new Error(out.reason)
      }
    },
    { concurrency: 2 },
  )
}

/**
 * The router's `prepareEvent` for chat: the image lines of a message event get the images' saved
 * descriptions (made after the event was stored), so a session sees
 * `[image: chart.png 800x600, attachment att_…: "A bar chart …"]`. Rendered inside the event: information,
 * never instructions.
 */
export function describedEvent(attachments: ChatAttachments) {
  return async (event: MpEvent): Promise<MpEvent> => {
    if (event.data.source !== 'chat' || typeof event.data.text !== 'string') return event
    const listed = (event.data.payload as { attachments?: unknown } | null | undefined)?.attachments
    if (!Array.isArray(listed) || !listed.length) return event
    const lines = event.data.text.split('\n')
    let changed = false
    for (const item of listed as Attachment[]) {
      if (typeof item?.id !== 'string') continue
      const rec = await attachments.get(item.id)
      if (!rec?.data.description) continue
      const marker = `, attachment ${item.id}`
      const i = lines.findIndex((l) => l.startsWith('[image: ') && (l.includes(`${marker}]`) || l.includes(`${marker}:`)))
      if (i < 0) continue
      lines[i] = attachmentLine(attachmentView(rec))
      changed = true
    }
    return changed ? { ...event, data: { ...event.data, text: lines.join('\n') } } : event
  }
}
