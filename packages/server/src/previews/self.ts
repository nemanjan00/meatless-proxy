import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import type { Config } from '../config.ts'

/**
 * The container the harness runs in, for the Docker runtime's `selfContainer` (it joins each
 * environment's preview network): `SELF_CONTAINER`, else this host name when running in Docker
 * (Docker sets it to the container id), else none (on the host, bridge addresses are reachable).
 */
export function selfContainer(
  config: Pick<Config, 'SELF_CONTAINER'>,
  inDocker = existsSync('/.dockerenv'),
): {
  selfContainer?: string
} {
  if (config.SELF_CONTAINER) return { selfContainer: config.SELF_CONTAINER }
  return inDocker ? { selfContainer: hostname() } : {}
}
