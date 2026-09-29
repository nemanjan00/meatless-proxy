import type { ApiClient, LiveChannel, LiveEvent, LiveSource, LiveStatus, LiveTopic } from '@mp/api'
import { createContext, type DependencyList, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'

/** The data layer the UI talks to: the HTTP client and the live connection (real or mock). */
export interface DataLayer {
  api: ApiClient
  live: LiveSource
  /** True when backed by the in-browser mock. */
  mock: boolean
}

const DataContext = createContext<DataLayer | null>(null)

export function DataProvider({ value, children }: { value: DataLayer; children: ReactNode }) {
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}

export function useData(): DataLayer {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData outside DataProvider')
  return ctx
}

export function useApi(): ApiClient {
  return useData().api
}

export interface Loaded<T> {
  data: T | undefined
  error: Error | undefined
  loading: boolean
  /** Loads again, keeping the current data while loading. */
  reload(): void
  /** Replaces the data locally (optimistic and live updates). */
  setData(update: T | ((prev: T | undefined) => T | undefined)): void
}

/**
 * Loads data with the API client. Re-runs when `deps` change; stale responses
 * are ignored.
 */
export function useLoad<T>(load: (api: ApiClient) => Promise<T>, deps: DependencyList): Loaded<T> {
  const { api } = useData()
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<Error | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const seq = useRef(0)
  const loadRef = useRef(load)
  loadRef.current = load

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's
  useEffect(() => {
    const n = ++seq.current
    setLoading(true)
    loadRef.current(api).then(
      (d) => {
        if (n !== seq.current) return
        setData(d)
        setError(undefined)
        setLoading(false)
      },
      (e: unknown) => {
        if (n !== seq.current) return
        setError(e instanceof Error ? e : new Error(String(e)))
        setLoading(false)
      },
    )
  }, [api, tick, ...deps])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, reload, setData }
}

/**
 * Subscribes to live channels while mounted. The handler may change between
 * renders without resubscribing. Pass `topics` to filter.
 */
export function useLive(
  chans: (LiveChannel | null | undefined | false)[],
  handler: (e: LiveEvent) => void,
  topics?: LiveTopic[],
) {
  const { live } = useData()
  const ref = useRef(handler)
  ref.current = handler
  const list = chans.filter((c): c is LiveChannel => !!c)
  const key = list.join('|')
  const topicKey = topics?.join('|') ?? ''
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the joined channel list
  useEffect(() => {
    if (!list.length) return
    const allowed = topicKey ? new Set(topicKey.split('|')) : null
    return live.subscribe(list, (e) => {
      if (!allowed || allowed.has(e.topic)) ref.current(e)
    })
  }, [live, key, topicKey])
}

/** Reloads (debounced) whenever an event arrives on the channels. */
export function useLiveReload(
  chans: (LiveChannel | null | undefined | false)[],
  reload: () => void,
  topics?: LiveTopic[],
  delayMs = 250,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  useLive(
    chans,
    () => {
      if (timer.current) return
      timer.current = setTimeout(() => {
        timer.current = null
        reload()
      }, delayMs)
    },
    topics,
  )
}

export function useLiveStatus(): LiveStatus {
  const { live } = useData()
  const [status, setStatus] = useState<LiveStatus>(live.status)
  useEffect(() => live.onStatus(setStatus), [live])
  return status
}
