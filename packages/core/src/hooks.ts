/**
 * Hooks are named extension points where higher layers can take part in a
 * decision made by a lower layer, without the lower layer knowing who they
 * are. The package that *calls* a hook declares it with `defineHook`. Higher
 * packages register handlers on it.
 *
 * - `decide` hooks: handlers run in order, and the first one that returns a
 *   decision (anything but `undefined`) wins. Used for "may this tool call
 *   run?", "is this run over budget?".
 * - `transform` hooks: every handler gets the output of the previous one.
 *   Used for "redact this tool output".
 */
export interface HookPoint<P, D> {
  readonly name: string
  /** Phantom fields, only for typing. */
  readonly _payload?: P
  readonly _decision?: D
}

export function defineHook<P, D = never>(name: string): HookPoint<P, D> {
  return { name }
}

export type DecideHandler<P, D> = (payload: P) => D | undefined | void | Promise<D | undefined | void>
export type TransformHandler<P> = (payload: P) => P | Promise<P>

export interface Hooks {
  on<P, D>(hook: HookPoint<P, D>, handler: DecideHandler<P, D>, opts?: { order?: number }): () => void
  onTransform<P>(hook: HookPoint<P, never>, handler: TransformHandler<P>, opts?: { order?: number }): () => void
  /** Runs `decide` handlers. Returns the first decision, or `undefined` if nobody decided. */
  decide<P, D>(hook: HookPoint<P, D>, payload: P): Promise<D | undefined>
  /** Runs `transform` handlers in order and returns the final payload. */
  transform<P>(hook: HookPoint<P, never>, payload: P): Promise<P>
  /** Names of hooks that have at least one handler. */
  registered(): string[]
}

interface Entry {
  order: number
  seq: number
  handler: (p: any) => any
}

export function createHooks(): Hooks {
  const handlers = new Map<string, Entry[]>()
  let seq = 0

  const add = (name: string, handler: (p: any) => any, order = 0) => {
    const list = handlers.get(name) ?? []
    const entry = { order, seq: seq++, handler }
    list.push(entry)
    list.sort((a, b) => a.order - b.order || a.seq - b.seq)
    handlers.set(name, list)
    return () => {
      const l = handlers.get(name)
      if (l)
        handlers.set(
          name,
          l.filter((e) => e !== entry),
        )
    }
  }

  return {
    on: (hook, handler, opts) => add(hook.name, handler, opts?.order),
    onTransform: (hook, handler, opts) => add(hook.name, handler, opts?.order),
    async decide(hook, payload) {
      for (const e of handlers.get(hook.name) ?? []) {
        const d = await e.handler(payload)
        if (d !== undefined) return d
      }
      return undefined
    },
    async transform(hook, payload) {
      let p = payload
      for (const e of handlers.get(hook.name) ?? []) p = await e.handler(p)
      return p
    },
    registered: () => [...handlers.entries()].filter(([, l]) => l.length).map(([n]) => n),
  }
}
