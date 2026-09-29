import { ManualClock, ValidationError } from '@mp/core'
import { describe, expect, it } from 'vitest'
import {
  checkEgress,
  egressEntryCovered,
  fakeRuntime,
  hostGlobMatch,
  invalidEgressEntries,
  isPrivateAddress,
  parseEgressEntry,
} from '../src/index.ts'

describe('egress allowlists', () => {
  it('parses entries', () => {
    expect(parseEgressEntry('Registry.NPMjs.org')).toEqual({ host: 'registry.npmjs.org', exact: true })
    expect(parseEgressEntry('*.github.com:443')).toEqual({ host: '*.github.com', port: 443, exact: false })
    expect(parseEgressEntry('10.0.0.5:8080')).toEqual({ host: '10.0.0.5', port: 8080, exact: true })
    expect(parseEgressEntry('[2001:db8::1]:443')).toEqual({ host: '2001:db8::1', port: 443, exact: true })
    expect(parseEgressEntry('::1')).toEqual({ host: '::1', exact: true })
    for (const bad of ['', 'a b', 'host:0', 'host:70000', 'host:x', 'http://x', 'a/b', '-x', '[nope]:1'])
      expect(parseEgressEntry(bad), bad).toBeNull()
    expect(invalidEgressEntries(['ok.example.com', 'bad host'])).toEqual(['bad host'])
  })

  it('matches globs', () => {
    expect(hostGlobMatch('*.github.com', 'api.github.com')).toBe(true)
    expect(hostGlobMatch('*.github.com', 'a.b.github.com')).toBe(true)
    expect(hostGlobMatch('*.github.com', 'github.com')).toBe(false)
    expect(hostGlobMatch('*.github.com', 'evilgithub.com')).toBe(false)
    expect(hostGlobMatch('*.github.com', 'api.github.com.evil.io')).toBe(false)
    expect(hostGlobMatch('registry.npmjs.org', 'registryxnpmjs.org')).toBe(false)
  })

  it('decides hosts and ports', () => {
    const allow = ['registry.npmjs.org', '*.github.com:443', 'staging.example.com:8443']
    expect(checkEgress(allow, 'registry.npmjs.org', 443)).toMatchObject({ allowed: true, exact: true })
    expect(checkEgress(allow, 'REGISTRY.npmjs.org.', 80).allowed).toBe(true)
    expect(checkEgress(allow, 'api.github.com', 443)).toMatchObject({ allowed: true, exact: false })
    expect(checkEgress(allow, 'api.github.com', 22)).toMatchObject({ allowed: false, reason: 'not in allowlist' })
    expect(checkEgress(allow, 'github.com', 443).allowed).toBe(false)
    expect(checkEgress(allow, 'staging.example.com', 8443).allowed).toBe(true)
    expect(checkEgress(allow, 'staging.example.com', 443).allowed).toBe(false)
    expect(checkEgress(allow, 'example.org', 443).allowed).toBe(false)
    expect(checkEgress(allow, 'a*b.github.com', 443)).toMatchObject({ allowed: false, reason: 'bad host' })
    expect(checkEgress(allow, '', 443).allowed).toBe(false)
    expect(checkEgress([], 'registry.npmjs.org', 443).allowed).toBe(false)
  })

  it('refuses IP literals and private names unless listed exactly', () => {
    expect(checkEgress(['*'], '1.1.1.1', 443)).toMatchObject({ allowed: false, reason: 'ip literal' })
    expect(checkEgress(['*'], '127.0.0.1', 80)).toMatchObject({ allowed: false, reason: 'private address' })
    expect(checkEgress(['*'], '10.1.2.3', 80).allowed).toBe(false)
    expect(checkEgress(['*'], '::1', 80).allowed).toBe(false)
    expect(checkEgress(['*'], '[::ffff:127.0.0.1]', 80).allowed).toBe(false)
    expect(checkEgress(['*'], 'localhost', 80)).toMatchObject({ allowed: false, reason: 'private address' })
    expect(checkEgress(['*.localhost'], 'db.localhost', 80).allowed).toBe(false)
    expect(checkEgress(['*'], 'example.com', 80).allowed).toBe(true)
    expect(checkEgress(['127.0.0.1:5000'], '127.0.0.1', 5000).allowed).toBe(true)
    expect(checkEgress(['127.0.0.1:5000'], '127.0.0.1', 5001).allowed).toBe(false)
    expect(checkEgress(['localhost'], 'localhost', 3000).allowed).toBe(true)
    expect(checkEgress(['[::1]:80'], '::1', 80).allowed).toBe(true)
  })

  it('knows private ranges', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1'])
      expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of ['0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'ff02::1'])
      expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of ['1.1.1.1', '172.32.0.1', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8'])
      expect(isPrivateAddress(ip), ip).toBe(false)
  })

  it('checks that a requested list only narrows', () => {
    const project = ['registry.npmjs.org', '*.github.com', 'staging.example.com:8443', '10.0.0.5']
    expect(egressEntryCovered('registry.npmjs.org', project)).toBe(true)
    expect(egressEntryCovered('registry.npmjs.org:443', project)).toBe(true)
    expect(egressEntryCovered('api.github.com', project)).toBe(true)
    expect(egressEntryCovered('*.api.github.com:443', project)).toBe(true)
    expect(egressEntryCovered('*.github.com', project)).toBe(true)
    expect(egressEntryCovered('github.com', project)).toBe(false)
    expect(egressEntryCovered('*', project)).toBe(false)
    expect(egressEntryCovered('*.com', project)).toBe(false)
    expect(egressEntryCovered('staging.example.com', project)).toBe(false) // any port is wider than :8443
    expect(egressEntryCovered('staging.example.com:8443', project)).toBe(true)
    expect(egressEntryCovered('10.0.0.5:22', project)).toBe(true)
    expect(egressEntryCovered('10.0.0.6', project)).toBe(false)
    expect(egressEntryCovered('localhost', ['*'])).toBe(false)
    expect(egressEntryCovered('not valid', project)).toBe(false)
  })
})

describe('fakeRuntime egress', () => {
  it('records the setting and answers decisions like the real runtime', async () => {
    const clock = new ManualClock()
    const rt = fakeRuntime({ clock })
    const proxied = await rt.createEnv({ name: 'p', image: 'i', egress: { allow: ['registry.npmjs.org:443'] } })
    const closed = await rt.createEnv({ name: 'c', image: 'i' })
    const open = await rt.createEnv({ name: 'o', image: 'i', allowInternet: true })
    expect(rt.envs()[0]!.spec.egress).toEqual({ allow: ['registry.npmjs.org:443'] })

    expect(rt.egressAllowed(proxied.id, 'registry.npmjs.org', 443)).toBe(true)
    expect(rt.egressAllowed(proxied.id, 'evil.example.com', 443)).toBe(false)
    expect(rt.egressAllowed(closed.id, 'registry.npmjs.org', 443)).toBe(false)
    expect(rt.egressAllowed(open.id, 'anything.example.com', 22)).toBe(true)

    expect(await rt.egressLog(proxied.id)).toEqual([
      { at: clock.iso(), method: 'CONNECT', host: 'registry.npmjs.org', port: 443, allowed: true },
      { at: clock.iso(), method: 'CONNECT', host: 'evil.example.com', port: 443, allowed: false, reason: 'not in allowlist' },
    ])
    expect(await rt.egressLog(closed.id)).toEqual([])
  })

  it('validates egress specs', async () => {
    const rt = fakeRuntime()
    await expect(rt.createEnv({ name: 'x', image: 'i', egress: { allow: ['bad host'] } })).rejects.toBeInstanceOf(ValidationError)
    await expect(rt.createEnv({ name: 'x', image: 'i', egress: { allow: [] }, allowInternet: true })).rejects.toBeInstanceOf(
      ValidationError,
    )
    await expect(rt.createEnv({ name: 'x', image: 'i', egress: { allow: [] } })).resolves.toMatchObject({ name: 'x' })
  })
})

describe('intersectEgress', () => {
  it('keeps what both lists allow, narrowing hosts and ports', async () => {
    const { intersectEgress, checkEgress } = await import('../src/index.ts')
    expect(intersectEgress(['*'], ['registry.npmjs.org', '*.github.com:443'])).toEqual(['registry.npmjs.org', '*.github.com:443'])
    expect(intersectEgress(['api.github.com', 'pypi.org'], ['*.github.com:443'])).toEqual(['api.github.com:443'])
    expect(intersectEgress(['a.test:80'], ['a.test:443'])).toEqual([])
    expect(intersectEgress(['pypi.org'], ['registry.npmjs.org'])).toEqual([])
    expect(intersectEgress(['bad entry!'], ['*'])).toEqual([])
    // A wildcard never reaches IP literals or private names.
    expect(intersectEgress(['*'], ['10.0.0.5'])).toEqual([])
    expect(intersectEgress(['10.0.0.5:5432'], ['10.0.0.5'])).toEqual(['10.0.0.5:5432'])
    const both = intersectEgress(['*.example.com'], ['api.example.com', 'example.com'])
    expect(both).toEqual(['api.example.com'])
    expect(checkEgress(both, 'www.example.com', 443).allowed).toBe(false)
  })
})
