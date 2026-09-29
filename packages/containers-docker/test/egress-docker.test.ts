import { ValidationError } from '@mp/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROXY_IMAGE, EGRESS_PROXY_SOURCE, dockerRuntime, parseEgressLog } from '../src/index.ts'
import { HttpError, MockDocker, frame } from './mock-docker.ts'

let docker: MockDocker
const rt = (o: Parameters<typeof dockerRuntime>[0] = {}) => dockerRuntime({ docker, ...o })

beforeEach(() => {
  docker = new MockDocker()
})

const spec = {
  name: 'billing-bot-fix-refunds',
  image: 'node:22',
  env: { CI: '1', HTTP_PROXY: 'http://elsewhere:1' },
  services: [{ name: 'db', image: 'postgres:18' }],
  egress: { allow: ['registry.npmjs.org', '*.github.com:443'] },
  labels: { 'mp.employee': 'emp_1', 'mp.session': 'ses_1' },
}

const proxyEnv = {
  HTTP_PROXY: 'http://proxy:3128',
  HTTPS_PROXY: 'http://proxy:3128',
  http_proxy: 'http://proxy:3128',
  https_proxy: 'http://proxy:3128',
  NO_PROXY: 'localhost,127.0.0.1,db',
}

const envMap = (list: string[]) => Object.fromEntries(list.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]))

describe('egress through a proxy', () => {
  it('creates an internal network, an egress network and a proxy sidecar attached to both', async () => {
    const env = await rt().createEnv(spec)
    expect(env.id).toBe('mp-billing-bot-fix-refunds')

    const nets = docker.callsTo('createNetwork').map((a) => a[0] as Record<string, any>)
    expect(nets.map((n) => [n.Name, n.Internal])).toEqual([
      ['mp-billing-bot-fix-refunds', true],
      ['mp-billing-bot-fix-refunds-egress', false],
    ])
    expect(nets[1]!.Labels).toMatchObject({ 'mp.env': spec.name, 'mp.managed': 'true', 'mp.employee': 'emp_1' })

    const created = docker.callsTo('createContainer').map((a) => a[0] as Record<string, any>)
    expect(created.map((c) => c.name)).toEqual([
      'mp-billing-bot-fix-refunds-proxy',
      'mp-billing-bot-fix-refunds-db',
      'mp-billing-bot-fix-refunds',
    ])
    const [proxy, db, main] = created as [Record<string, any>, Record<string, any>, Record<string, any>]

    // The proxy: on the internal network as `proxy`, then connected to the egress network.
    expect(proxy.Image).toBe(DEFAULT_PROXY_IMAGE)
    expect(proxy.Cmd).toEqual(['node', '-e', EGRESS_PROXY_SOURCE])
    expect(envMap(proxy.Env)).toEqual({ ALLOW: JSON.stringify(spec.egress.allow), PORT: '3128' })
    expect(proxy.Labels).toMatchObject({ 'mp.role': 'proxy', 'mp.env': spec.name, 'mp.session': 'ses_1' })
    expect(proxy.HostConfig).toMatchObject({ NetworkMode: 'mp-billing-bot-fix-refunds', Privileged: false, ReadonlyRootfs: true })
    expect(proxy.NetworkingConfig.EndpointsConfig).toEqual({ 'mp-billing-bot-fix-refunds': { Aliases: ['proxy'] } })
    expect(docker.callsTo('network.connect')).toEqual([
      ['mp-billing-bot-fix-refunds-egress', { Container: 'mp-billing-bot-fix-refunds-proxy' }],
    ])
    expect(docker.networks.get('mp-billing-bot-fix-refunds-egress')!.connected).toEqual(['mp-billing-bot-fix-refunds-proxy'])

    // Main and services: internal network only, proxy settings in the environment (winning over the spec's).
    for (const c of [db, main]) {
      expect(c.HostConfig.NetworkMode).toBe('mp-billing-bot-fix-refunds')
      expect(Object.keys(c.NetworkingConfig.EndpointsConfig)).toEqual(['mp-billing-bot-fix-refunds'])
      expect(envMap(c.Env)).toMatchObject({ ...proxyEnv, no_proxy: proxyEnv.NO_PROXY })
    }
    expect(envMap(main.Env).CI).toBe('1')
    expect(docker.networks.get('mp-billing-bot-fix-refunds')!.connected).toBeUndefined()

    // Nothing gets host networking, and nothing but the proxy touches the egress network.
    for (const c of created) {
      expect(c.HostConfig.NetworkMode).not.toBe('host')
      expect(c.HostConfig.Privileged).toBe(false)
      expect(JSON.stringify(c.NetworkingConfig)).not.toContain('-egress')
    }
    expect(docker.callsTo('pull').map((a) => a[0])).toEqual(['node:22', 'postgres:18', DEFAULT_PROXY_IMAGE])
    expect(docker.callsTo('container.start')).toHaveLength(3)
  })

  it('uses the configured proxy image', async () => {
    docker.images.add('registry.example.com/node:26')
    await rt({ proxyImage: 'registry.example.com/node:26' }).createEnv({ name: 'e1', image: 'i', egress: { allow: [] } })
    const proxy = docker.callsTo('createContainer')[0]![0] as Record<string, any>
    expect(proxy.Image).toBe('registry.example.com/node:26')
    expect(docker.callsTo('pull').map((a) => a[0])).toEqual(['i'])
    expect(envMap(proxy.Env).ALLOW).toBe('[]')
  })

  it('without egress: no proxy, no egress network, no proxy variables', async () => {
    await rt().createEnv({ name: 'plain', image: 'i', services: [{ name: 'db', image: 'pg' }] })
    expect(docker.callsTo('createNetwork').map((a) => (a[0] as any).Name)).toEqual(['mp-plain'])
    const created = docker.callsTo('createContainer').map((a) => a[0] as Record<string, any>)
    expect(created.map((c) => c.name)).toEqual(['mp-plain-db', 'mp-plain'])
    for (const c of created) expect(c.Env.some((e: string) => /proxy/i.test(e))).toBe(false)
    expect(docker.callsTo('network.connect')).toEqual([])
  })

  it('validates the allowlist and the combination with allowInternet', async () => {
    const r = rt()
    await expect(r.createEnv({ name: 'x', image: 'i', egress: { allow: ['not a host'] } })).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(r.createEnv({ name: 'x', image: 'i', egress: { allow: [] }, allowInternet: true })).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(
      r.createEnv({ name: 'x', image: 'i', egress: { allow: [] }, services: [{ name: 'proxy', image: 'squid' }] }),
    ).rejects.toThrow(/taken by the egress proxy/)
    expect(docker.callsTo('createNetwork')).toEqual([])
  })

  it('destroyEnv removes the proxy and both networks', async () => {
    const r = rt()
    const env = await r.createEnv(spec)
    await r.destroyEnv(env.id)
    expect([...docker.containers.values()].every((c) => c.removed)).toBe(true)
    expect(docker.networks.size).toBe(0)
    const removed = docker.callsTo('network.remove').map((a) => a[0])
    // The preview network is tried too (it may exist); a missing one is fine.
    expect(removed).toEqual([
      'mp-billing-bot-fix-refunds',
      'mp-billing-bot-fix-refunds-egress',
      'mp-billing-bot-fix-refunds-preview',
    ])
    await r.destroyEnv(env.id) // idempotent
  })

  it('cleans up the proxy and the egress network when creation fails later', async () => {
    docker.failures['container.start'] = new HttpError(500, 'boom')
    await expect(rt().createEnv(spec)).rejects.toThrow(/boom/)
    expect([...docker.containers.values()].every((c) => c.removed)).toBe(true)
    expect(docker.networks.size).toBe(0)
  })

  it('egressLog parses the proxy log', async () => {
    const r = rt()
    const env = await r.createEnv(spec)
    const proxy = [...docker.containers.values()].find((c) => c.name.endsWith('-proxy'))!
    const a = { at: '2026-09-29T09:00:00.000Z', method: 'CONNECT', host: 'registry.npmjs.org', port: 443, allowed: true }
    const b = { at: '2026-09-29T09:00:01.000Z', method: 'GET', host: 'evil.example.com', port: 80, allowed: false }
    proxy.logs = Buffer.concat([frame('stdout', `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`), frame('stdout', 'noise\n')])
    expect(await r.egressLog!(env.id)).toEqual([a, b])
    const [, opts] = docker.callsTo('container.logs').at(-1) as [string, Record<string, any>]
    expect(opts).toMatchObject({ stdout: true, stderr: false })

    const plain = await r.createEnv({ name: 'plain', image: 'i' })
    expect(await r.egressLog!(plain.id)).toEqual([])
  })

  it('parseEgressLog skips junk', () => {
    expect(parseEgressLog('x\n{"bad json\n{"a":1}\n{"method":"GET","host":"h","port":1,"allowed":false,"at":"t"}\n')).toEqual([
      { method: 'GET', host: 'h', port: 1, allowed: false, at: 't' },
    ])
  })
})
