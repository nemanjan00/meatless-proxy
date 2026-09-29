import type { ControlState } from '@mp/api'
import { isMpError, type Clock, type EventBus, type Hooks, type Json, type Logger } from '@mp/core'
import { beforeModelCall } from '@mp/runner'
import type { Sessions } from '@mp/sessions'
import type { Actor } from '@mp/store'
import { SettingNames, type Settings } from './settings.ts'

/** The pause reason of runs paused by the global kill switch. */
export const GLOBAL_PAUSE_REASON = 'paused by the global kill switch'

export interface Control {
  state(): Promise<ControlState>
  /** Sets the global pause flag: every run pauses at its next model call. */
  pauseAll(actor: Actor): Promise<ControlState>
  /** Clears the flag and re-queues runs the kill switch paused. */
  resumeAll(actor: Actor): Promise<ControlState>
}

export interface ControlDeps {
  settings: Settings
  sessions: Sessions
  hooks: Hooks
  bus: EventBus
  clock: Clock
  logger: Logger
  enqueueRun: (runId: string, priority?: number) => Promise<void>
}

/**
 * The global pause flag (kill switch), stored as a setting so every process
 * sees it. A `beforeModelCall` handler, registered first, honours it.
 */
export function createControl(deps: ControlDeps): Control {
  const read = async (): Promise<ControlState> => {
    const v = (await deps.settings.get<{ [k: string]: Json }>(SettingNames.control)) ?? {}
    return {
      paused: v.paused === true,
      ...(typeof v.pausedAt === 'string' ? { pausedAt: v.pausedAt } : {}),
      ...(v.pausedBy && typeof v.pausedBy === 'object' ? { pausedBy: v.pausedBy as unknown as ControlState['pausedBy'] } : {}),
    }
  }

  deps.hooks.on(
    beforeModelCall,
    async () => {
      const s = await read()
      return s.paused ? { pause: GLOBAL_PAUSE_REASON } : undefined
    },
    { order: -1000 },
  )

  return {
    state: read,
    async pauseAll(actor) {
      const value = { paused: true, pausedAt: deps.clock.iso(), pausedBy: { type: actor.type, id: actor.id } }
      await deps.settings.set(SettingNames.control, value, actor)
      deps.bus.publish('control.changed', { paused: true })
      deps.logger.warn('global pause set', { actor })
      return read()
    },
    async resumeAll(actor) {
      await deps.settings.set(SettingNames.control, { paused: false }, actor)
      deps.bus.publish('control.changed', { paused: false })
      const paused = await deps.sessions.runs({ state: 'paused' })
      let resumed = 0
      for (const r of paused) {
        if (r.data.pauseReason !== GLOBAL_PAUSE_REASON) continue
        try {
          await deps.sessions.transition(r.id, 'paused', 'queued', { pauseReason: undefined } as never)
          await deps.enqueueRun(r.id, r.data.priority)
          resumed++
        } catch (e) {
          if (!isMpError(e, 'conflict')) throw e
        }
      }
      deps.logger.info('global pause cleared', { actor, resumed })
      return read()
    },
  }
}
