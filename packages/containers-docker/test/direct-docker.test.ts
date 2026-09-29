import { ConflictError, ValidationError } from '@mp/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { ICC_OPTION, dockerRuntime } from '../src/index.ts'
import { HttpError, MockDocker } from './mock-docker.ts'

let docker: MockDocker
const rt = (o: Parameters<typeof dockerRuntime>[0] = {}) => dockerRuntime({ docker, ...o })

beforeEach(() => {
  docker = new MockDocker()
})

const spec = {
  name: 'ana-fix-login',
  image: 'node:22',
  services: [{ name: 'db', image: 'postgres:18' }],
  direct: { network: 'ana-direct' },
  labels: { 'mp.employee': 'emp_1', 'mp.session': 'ses_1' },
}

describe('direct network', () => {
  it('makes a shared bridge with inter-container traffic off and joins main and services to it', async () => {
    await rt({ labels: { 'mp.stack': 'test' } }).createEnv(spec)
    const nets = docker.callsTo('createNetwork').map((a) => a[0] as Record<string, any>)
    expect(nets.map((n) => [n.Name, n.Internal])).toEqual([
      ['mp-ana-fix-login', true],
      ['mp-ana-direct', false],
    ])
    const direct = nets[1]!
    expect(direct.Driver).toBe('bridge')
    expect(direct.Options).toEqual({ [ICC_OPTION]: 'false' })
    // Shared: labelled as the runtime's, never with one environment's labels.
    expect(direct.Labels).toEqual({ 'mp.stack': 'test', 'mp.deployment': 'mp-', 'mp.managed': 'true', 'mp.role': 'direct' })

    const created = docker.callsTo('createContainer').map((a) => a[0] as Record<string, any>)
    expect(created.map((c) => c.name)).toEqual(['mp-ana-fix-login-db', 'mp-ana-fix-login'])
    for (const c of created) {
      // No proxy, no published ports, the private network stays the one they are created on.
      expect(c.Env.some((e: string) => /proxy/i.test(e))).toBe(false)
      expect(c.HostConfig.NetworkMode).toBe('mp-ana-fix-login')
      expect(c.HostConfig.PortBindings).toBeUndefined()
      expect(c.HostConfig.PublishAllPorts).toBeUndefined()
      expect(c.HostConfig.Privileged).toBe(false)
    }
    expect(docker.networks.get('mp-ana-direct')!.connected).toEqual(['mp-ana-fix-login-db', 'mp-ana-fix-login'])
    // Connected before they start, so their first request already has a route.
    const order = docker.calls.map((c) => c.method).filter((m) => m === 'network.connect' || m === 'container.start')
    expect(order).toEqual(['network.connect', 'container.start', 'network.connect', 'container.start'])
    // No proxy sidecar image needed.
    expect(docker.callsTo('pull').map((a) => a[0])).toEqual(['node:22', 'postgres:18'])
  })

  it('reuses the network for the next environment and keeps it when environments go', async () => {
    const r = rt()
    const a = await r.createEnv(spec)
    const b = await r.createEnv({ ...spec, name: 'ana-other', services: [] })
    expect(docker.callsTo('createNetwork').filter((x) => (x[0] as any).Name === 'mp-ana-direct')).toHaveLength(1)
    expect(docker.networks.get('mp-ana-direct')!.connected).toContain('mp-ana-other')
    await r.destroyEnv(a.id)
    await r.destroyEnv(b.id)
    expect(docker.networks.has('mp-ana-direct')).toBe(true)
    expect(docker.networks.has('mp-ana-fix-login')).toBe(false)
  })

  it('survives another environment creating the network at the same time', async () => {
    const orig = docker.createNetwork.bind(docker)
    let raced = false
    docker.createNetwork = async (opts: Record<string, any>) => {
      if (opts.Name === 'mp-ana-direct' && !raced) {
        raced = true
        await orig(opts) // the other environment wins the race
        throw new HttpError(409, 'network with name mp-ana-direct already exists')
      }
      return orig(opts)
    }
    await expect(rt().createEnv(spec)).resolves.toMatchObject({ id: 'mp-ana-fix-login' })
    expect(docker.networks.get('mp-ana-direct')!.connected).toContain('mp-ana-fix-login')
  })

  it("refuses to join a network it didn't make, or one that lost its isolation", async () => {
    // e.g. the harness's own compose network, named like a direct one.
    docker.networks.set('mp-ana-direct', { Name: 'mp-ana-direct', Labels: { 'com.docker.compose.network': 'default' } })
    await expect(rt().createEnv(spec)).rejects.toBeInstanceOf(ConflictError)
    expect(docker.containers.size === 0 || [...docker.containers.values()].every((c) => c.removed)).toBe(true)
    expect(docker.networks.has('mp-ana-fix-login')).toBe(false)

    docker.networks.set('mp-ana-direct', {
      Name: 'mp-ana-direct',
      Labels: { 'mp.managed': 'true', 'mp.role': 'direct' },
      Options: { [ICC_OPTION]: 'true' },
    })
    await expect(rt().createEnv(spec)).rejects.toThrow(/lets containers reach each other/)
    docker.networks.set('mp-ana-direct', {
      Name: 'mp-ana-direct',
      Internal: true,
      Labels: { 'mp.managed': 'true', 'mp.role': 'direct' },
      Options: { [ICC_OPTION]: 'false' },
    })
    await expect(rt().createEnv(spec)).rejects.toThrow(/no route out/)
  })

  it('validates the combination with egress and allowInternet, and the name', async () => {
    const r = rt()
    await expect(r.createEnv({ ...spec, egress: { allow: [] } })).rejects.toBeInstanceOf(ValidationError)
    await expect(r.createEnv({ ...spec, allowInternet: true })).rejects.toBeInstanceOf(ValidationError)
    await expect(r.createEnv({ ...spec, direct: { network: '../host' } })).rejects.toBeInstanceOf(ValidationError)
    expect(docker.callsTo('createNetwork')).toEqual([])
  })
})
