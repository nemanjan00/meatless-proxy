import { ConflictError } from '@mp/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { LABEL_DEPLOYMENT, dockerRuntime } from '../src/index.ts'
import { MockDocker } from './mock-docker.ts'

// Two deployments of the harness on one Docker host: the default (mp-) and a test server (mp-e2e-).
let docker: MockDocker
beforeEach(() => {
  docker = new MockDocker()
})
const main = () => dockerRuntime({ docker })
const e2e = () => dockerRuntime({ docker, namePrefix: 'mp-e2e-' })

const sandbox = { name: 'meatless-sandbox', image: 'i', volumes: ['/work'], egress: { allow: ['pypi.org'] } }
const containerNames = () => [...docker.containers.values()].filter((c) => !c.removed).map((c) => c.name)

describe('deployments sharing a Docker host', () => {
  it('name and label every container, network and volume with their own prefix', async () => {
    const a = await main().createEnv(sandbox)
    const b = await e2e().createEnv({ ...sandbox, direct: { network: 'meatless-direct' }, egress: undefined })
    expect(a.id).toBe('mp-meatless-sandbox')
    expect(b.id).toBe('mp-e2e-meatless-sandbox')

    for (const c of docker.containers.values()) {
      const want = c.name.startsWith('mp-e2e-') ? 'mp-e2e-' : 'mp-'
      expect(c.opts.Labels[LABEL_DEPLOYMENT], c.name).toBe(want)
      for (const m of c.opts.HostConfig.Mounts ?? [])
        if (!m.Source) expect(m.VolumeOptions.Labels[LABEL_DEPLOYMENT], `${c.name} ${m.Target}`).toBe(want)
    }
    for (const [name, n] of docker.networks)
      expect(n.Labels[LABEL_DEPLOYMENT], name).toBe(name.startsWith('mp-e2e-') ? 'mp-e2e-' : 'mp-')
    expect([...docker.networks.keys()]).toContain('mp-e2e-meatless-direct')
  })

  it('never list, find or remove the other deployment’s resources, even when names match', async () => {
    const A = main()
    const B = e2e()
    const a = await A.createEnv(sandbox)
    const b = await B.createEnv(sandbox)

    expect((await A.listEnvs()).map((e) => e.id)).toEqual([a.id])
    expect((await B.listEnvs()).map((e) => e.id)).toEqual([b.id])
    // `mp-e2e-meatless-sandbox` also reads as the mp- environment `e2e-meatless-sandbox`.
    expect(await A.getEnv(b.id)).toBeNull()
    await A.destroyEnv(b.id)
    expect(containerNames()).toEqual(expect.arrayContaining(['mp-e2e-meatless-sandbox', 'mp-e2e-meatless-sandbox-proxy']))
    expect([...docker.networks.keys()]).toEqual(
      expect.arrayContaining(['mp-e2e-meatless-sandbox', 'mp-e2e-meatless-sandbox-egress']),
    )

    // Each removes only its own.
    await A.destroyEnv(a.id)
    expect(containerNames().sort()).toEqual(['mp-e2e-meatless-sandbox', 'mp-e2e-meatless-sandbox-proxy'])
    await B.destroyEnv(b.id)
    expect(containerNames()).toEqual([])
    expect(docker.networks.size).toBe(0)
  })

  it('treat unlabelled resources from before the label as the default deployment’s only', async () => {
    const A = main()
    await A.createEnv({ name: 'old', image: 'i' })
    const old = [...docker.containers.values()].find((c) => c.name === 'mp-old')!
    delete old.opts.Labels[LABEL_DEPLOYMENT]
    delete docker.networks.get('mp-old')!.Labels[LABEL_DEPLOYMENT]
    expect((await A.listEnvs()).map((e) => e.id)).toEqual(['mp-old'])
    expect(await e2e().listEnvs()).toEqual([])
    await e2e().destroyEnv('mp-old')
    expect(containerNames()).toEqual(['mp-old'])
    await A.destroyEnv('mp-old')
    expect(containerNames()).toEqual([])
    expect(docker.networks.size).toBe(0)
  })

  it('refuse a name taken by another deployment, saying how to fix it', async () => {
    await dockerRuntime({ docker, namePrefix: 'mp-', labels: {} }).createEnv({ name: 'x', image: 'i' })
    const taken = [...docker.containers.values()].find((c) => c.name === 'mp-x')!
    taken.opts.Labels[LABEL_DEPLOYMENT] = 'mp-other-'
    const err = await main()
      .createEnv({ name: 'x', image: 'i' })
      .catch((e) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect(err.message).toMatch(/belongs to another deployment.*DOCKER_NAME_PREFIX/)
    // And the refusal removed nothing of theirs.
    expect(containerNames()).toEqual(['mp-x'])
  })

  it("won't join another deployment's direct network", async () => {
    await e2e().createEnv({ name: 'b', image: 'i', direct: { network: 'ana-direct' } })
    // A second deployment configured with the same prefix label set differently.
    docker.networks.get('mp-e2e-ana-direct')!.Labels[LABEL_DEPLOYMENT] = 'mp-'
    await expect(e2e().createEnv({ name: 'c', image: 'i', direct: { network: 'ana-direct' } })).rejects.toThrow(
      /not a direct network made by this deployment/,
    )
  })
})
