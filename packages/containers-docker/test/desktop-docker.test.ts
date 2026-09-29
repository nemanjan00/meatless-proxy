import { DESKTOP_DISPLAY, DESKTOP_PORTS } from '@mp/containers'
import { isMpError } from '@mp/core'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ContainerLike } from '../src/docker-like.ts'
import {
  DEFAULT_DESKTOP_IMAGE,
  DESKTOP_READY_MARKER,
  LABEL_DESKTOP,
  LABEL_EXPOSE,
  PREVIEW_READY_MARKER,
  dockerRuntime,
} from '../src/index.ts'
import { MockDocker, frame } from './mock-docker.ts'

let docker: MockDocker
const rt = (o: Parameters<typeof dockerRuntime>[0] = {}) => dockerRuntime({ docker, ...o })
/** Per container name: the stats samples it returns, in order, and its `top` answer. */
let samples: Map<string, Record<string, any>[]>
let tops: Map<string, { Titles: string[]; Processes: string[][] }>

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

beforeEach(() => {
  docker = new MockDocker()
  samples = new Map()
  tops = new Map()
  const get = docker.getContainer.bind(docker)
  docker.getContainer = (id: string): ContainerLike => {
    const c = get(id)
    const mc = () => [...docker.containers.values()].find((x) => (x.name === id || x.id === id) && !x.removed)
    const start = c.start.bind(c)
    c.start = async (o) => {
      const r = await start(o)
      const m = mc()
      // The sidecars say they're ready, like the real ones.
      if (m && String(m.opts.Cmd?.at(-1) ?? '').includes('createPreviewForwarder'))
        m.logs = Buffer.concat([m.logs, frame('stderr', `${PREVIEW_READY_MARKER} 6080\n`)])
      if (m?.opts.Labels?.['mp.role'] === 'desktop')
        m.logs = Buffer.concat([m.logs, frame('stderr', `${DESKTOP_READY_MARKER} on :99 (1440x900)\n`)])
      return r
    }
    c.stats = async () => {
      const m = mc()!
      const list = samples.get(m.name) ?? []
      return list.length > 1 ? list.shift()! : (list[0] ?? {})
    }
    c.top = async () => tops.get(mc()!.name) ?? { Titles: [], Processes: [] }
    return c
  }
})

const spec = { name: 'bot-gui', image: 'nemanjan00/dev:default', desktop: {}, labels: { 'mp.session': 'ses_1' } }
const created = () => docker.callsTo('createContainer').map((a) => a[0] as Record<string, any>)

describe('desktop environments', () => {
  it('runs a desktop sidecar in the main container’s network namespace, hardened, with DISPLAY for the main container', async () => {
    const info = await rt().createEnv({ ...spec, desktop: { width: 1280, height: 720 } })
    expect(info.desktop).toBe(true)
    const byName = new Map(created().map((c) => [c.name as string, c]))
    expect([...byName.keys()]).toEqual(['mp-bot-gui', 'mp-bot-gui-desktop', 'mp-bot-gui-preview'])
    const main = byName.get('mp-bot-gui')!
    const desk = byName.get('mp-bot-gui-desktop')!
    const fwd = byName.get('mp-bot-gui-preview')!

    expect(main.Env).toContain(`DISPLAY=${DESKTOP_DISPLAY}`)
    expect(main.Labels).toMatchObject({ [LABEL_DESKTOP]: 'true', [LABEL_EXPOSE]: '6080,6081' })

    expect(desk.Image).toBe(DEFAULT_DESKTOP_IMAGE)
    expect(desk.Env).toEqual([`DISPLAY=${DESKTOP_DISPLAY}`, 'DESKTOP_SIZE=1280x720'])
    expect(desk.User).toBe('1000:1000')
    expect(desk.Labels).toMatchObject({ 'mp.role': 'desktop', 'mp.env': 'bot-gui', 'mp.session': 'ses_1' })
    expect(desk.HostConfig).toMatchObject({
      NetworkMode: 'container:mp-bot-gui',
      ReadonlyRootfs: true,
      Privileged: false,
      SecurityOpt: ['no-new-privileges:true'],
    })
    expect(desk.HostConfig.Tmpfs['/tmp']).toContain('mode=1777')
    // Nothing is published on the host.
    expect(desk.HostConfig.PortBindings).toBeUndefined()
    expect(desk.ExposedPorts).toBeUndefined()

    // The forwarder carries the desktop's two bridges, like exposed ports.
    expect(fwd.Env).toContain(
      `FORWARDS=${JSON.stringify([
        { listen: DESKTOP_PORTS.control, port: DESKTOP_PORTS.control },
        { listen: DESKTOP_PORTS.view, port: DESKTOP_PORTS.view },
      ])}`,
    )
    expect((await rt().previewTarget!(info.id, DESKTOP_PORTS.view)).port).toBe(DESKTOP_PORTS.view)
    expect((await rt().getEnv(info.id))?.desktop).toBe(true)
    expect((await rt().listEnvs())[0]?.desktop).toBe(true)
  })

  it('keeps exposed ports next to the desktop, and a DISPLAY of the spec’s own wins', async () => {
    await rt({ desktopImage: 'mp-desktop:dev' }).createEnv({ ...spec, expose: [5173], env: { DISPLAY: ':1' } })
    const [main, desk] = created()
    expect(main!.Labels[LABEL_EXPOSE]).toBe('5173,6080,6081')
    expect(main!.Env).toContain('DISPLAY=:1')
    expect(desk!.Image).toBe('mp-desktop:dev')
    expect(docker.callsTo('pull').map((a) => a[0])).toContain('mp-desktop:dev')
  })

  it('refuses a desktop port in expose, a service called desktop, and bad sizes', async () => {
    for (const bad of [
      { ...spec, expose: [6080] },
      { ...spec, services: [{ name: 'desktop', image: 'redis:8' }] },
      { ...spec, desktop: { width: 10 } },
      { ...spec, desktop: 'yes' as never },
    ]) {
      const err = await rt()
        .createEnv(bad)
        .catch((e) => e)
      expect(isMpError(err, 'validation'), JSON.stringify(bad)).toBe(true)
    }
    expect(created()).toEqual([])
  })

  it('cleans up when the desktop never comes up', async () => {
    const get = docker.getContainer.bind(docker)
    docker.getContainer = (id: string) => {
      const c = get(id)
      const m = [...docker.containers.values()].find((x) => (x.name === id || x.id === id) && !x.removed)
      if (m?.name.endsWith('-desktop')) {
        c.start = async () => {
          m.running = false
          m.logs = frame('stderr', 'mp-desktop: the display did not start\n')
          return {}
        }
      }
      return c
    }
    const err = await rt()
      .createEnv(spec)
      .catch((e) => e)
    expect(String(err.message)).toMatch(/desktop mp-bot-gui-desktop exited: mp-desktop: the display did not start/)
    expect([...docker.containers.values()].filter((c) => !c.removed)).toEqual([])
    expect(docker.networks.size).toBe(0)
  })

  it('takes a screenshot in the sidecar and returns the PNG', async () => {
    const r = rt()
    const info = await r.createEnv(spec)
    docker.execHandler = (cmd) =>
      cmd[0] === 'mp-desktop-shot' ? { frames: [{ stream: 'stdout', data: `${PNG.toString('base64')}\n` }] } : { exitCode: 0 }
    const png = await r.screenshot!(info.id)
    expect(Buffer.from(png).equals(PNG)).toBe(true)
    expect(docker.execs.at(-1)?.container).toBe('mp-bot-gui-desktop')

    docker.execHandler = () => ({ frames: [{ stream: 'stdout', data: 'bm90IGEgcG5n' }] })
    await expect(r.screenshot!(info.id)).rejects.toThrow(/no PNG/)
    docker.execHandler = () => ({ exitCode: 1, frames: [{ stream: 'stderr', data: 'scrot: no display' }] })
    await expect(r.screenshot!(info.id)).rejects.toThrow(/scrot: no display/)
  })

  it('has no screenshot without a desktop, or once the environment is gone', async () => {
    const r = rt()
    const plain = await r.createEnv({ name: 'plain', image: 'alpine:3' })
    expect(plain.desktop).toBeUndefined()
    expect(isMpError(await r.screenshot!(plain.id).catch((e) => e), 'not_found')).toBe(true)
    await r.destroyEnv(plain.id)
    expect(isMpError(await r.screenshot!(plain.id).catch((e) => e), 'not_found')).toBe(true)
  })

  it('removes the desktop before the main container whose network it shares', async () => {
    const r = rt()
    const info = await r.createEnv(spec)
    await r.destroyEnv(info.id)
    const removed = docker.callsTo('container.remove').map((a) => a[0] as string)
    const name = (id: string) => docker.containers.get(id)?.name ?? id
    const order = removed.map(name)
    expect(order.indexOf('mp-bot-gui-desktop')).toBeLessThan(order.indexOf('mp-bot-gui'))
    expect([...docker.containers.values()].filter((c) => !c.removed)).toEqual([])
  })
})

describe('metrics and processes', () => {
  const sample = (total: number, system: number, extra: Record<string, any> = {}) => ({
    cpu_stats: { cpu_usage: { total_usage: total }, system_cpu_usage: system, online_cpus: 4 },
    memory_stats: { usage: 300 * 1024 * 1024, limit: 1024 * 1024 * 1024, stats: { inactive_file: 100 * 1024 * 1024 } },
    networks: { eth0: { rx_bytes: 1000, tx_bytes: 200 }, eth1: { rx_bytes: 24, tx_bytes: 56 } },
    pids_stats: { current: 12 },
    ...extra,
  })

  it('samples each working container (not the sidecars), with CPU from the previous sample', async () => {
    const r = rt()
    const info = await r.createEnv({
      ...spec,
      egress: { allow: ['registry.npmjs.org'] },
      services: [{ name: 'db', image: 'postgres:18' }],
    })
    samples.set('mp-bot-gui', [sample(1_000, 100_000), sample(3_000, 104_000)])
    samples.set('mp-bot-gui-db', [sample(0, 0, { memory_stats: { usage: 10, limit: 20 }, networks: undefined })])

    const first = await r.stats!(info.id)
    expect(first.envId).toBe(info.id)
    expect(first.containers.map((c) => [c.name, c.role, c.state])).toEqual([
      ['main', 'main', 'running'],
      ['db', 'service', 'running'],
      ['desktop', 'desktop', 'running'],
    ])
    const main = first.containers[0]!
    // No previous sample yet: no CPU share.
    expect(main).toMatchObject({
      cpuPercent: null,
      memoryBytes: 200 * 1024 * 1024,
      memoryLimitBytes: 1024 * 1024 * 1024,
      netRxBytes: 1024,
      netTxBytes: 256,
      pids: 12,
    })
    expect(main.startedAt).toMatch(/^\d{4}-/)
    expect(first.containers[1]).toMatchObject({ memoryBytes: 10, memoryLimitBytes: 20, netRxBytes: null, netTxBytes: null })

    // 2000 of 4000 system ticks on 4 CPUs: two CPUs busy.
    const second = await r.stats!(info.id)
    expect(second.containers[0]!.cpuPercent).toBe(200)
  })

  it('uses Docker’s own previous sample when it has one', async () => {
    const r = rt()
    const info = await r.createEnv({ name: 'plain', image: 'alpine:3' })
    samples.set('mp-plain', [
      { ...sample(5_000, 50_000), precpu_stats: { cpu_usage: { total_usage: 4_000 }, system_cpu_usage: 46_000 } },
    ])
    expect((await r.stats!(info.id)).containers[0]!.cpuPercent).toBe(100)
  })

  it('reports stopped containers without metrics, and a failing sample as unknown', async () => {
    const r = rt()
    const info = await r.createEnv({ name: 'plain', image: 'alpine:3' })
    samples.set('mp-plain', [])
    const get = docker.getContainer.bind(docker)
    docker.getContainer = (id: string) => {
      const c = get(id)
      c.stats = async () => {
        throw new Error('boom')
      }
      return c
    }
    expect((await r.stats!(info.id)).containers[0]).toMatchObject({ state: 'running', cpuPercent: null, memoryBytes: null })
    for (const c of docker.containers.values()) c.running = false
    expect((await r.stats!(info.id)).containers[0]).toMatchObject({ state: 'exited', pids: null })
  })

  it('is not found for an environment that is gone or another deployment’s', async () => {
    const r = rt()
    expect(isMpError(await r.stats!('mp-nope').catch((e) => e), 'not_found')).toBe(true)
    const info = await rt({ namePrefix: 'mp-other-' }).createEnv({ name: 'plain', image: 'alpine:3' })
    expect(isMpError(await r.stats!(info.id).catch((e) => e), 'not_found')).toBe(true)
    expect(isMpError(await r.processes!(info.id).catch((e) => e), 'not_found')).toBe(true)
  })

  it('lists processes per container, busiest first, at most 25', async () => {
    const r = rt()
    const info = await r.createEnv({ ...spec, services: [{ name: 'db', image: 'postgres:18' }] })
    const titles = ['PID', 'USER', '%CPU', '%MEM', 'ELAPSED', 'COMMAND']
    tops.set('mp-bot-gui', {
      Titles: titles,
      Processes: [
        ['1', 'root', '0.0', '0.1', '10:00', 'sleep infinity'],
        ['40', 'user', '87.5', '4.0', '00:12', 'chromium --headed'],
        ...Array.from({ length: 30 }, (_, i) => [String(100 + i), 'user', '0.1', '0.0', '00:01', `sh ${i}`]),
      ],
    })
    const list = await r.processes!(info.id)
    expect(list.map((p) => [p.name, p.role])).toEqual([
      ['main', 'main'],
      ['db', 'service'],
      ['desktop', 'desktop'],
    ])
    expect(list[0]!.titles).toEqual(titles)
    expect(list[0]!.processes).toHaveLength(25)
    expect(list[0]!.processes[0]![5]).toBe('chromium --headed')
    expect(list[1]!.processes).toEqual([])
  })
})
