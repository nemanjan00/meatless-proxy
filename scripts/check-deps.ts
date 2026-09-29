/**
 * Enforces the architecture's dependency rules (docs/architecture.md):
 *
 * - every package has a layer in scripts/layers.json
 * - a package depends only on lower layers (domain packages may also use
 *   domain packages listed earlier in `domainOrder`)
 * - only the composition root may depend on adapters
 * - restricted packages depend only on what they're allowed to
 * - no cycles
 *
 * Dependencies are both what package.json declares and what the source
 * actually imports, and the two must agree.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const cfg = JSON.parse(readFileSync(join(root, 'scripts/layers.json'), 'utf8')) as {
  layers: Record<string, number>
  domainOrder: string[]
  adapterLayer: number
  adapterConsumers: string[]
  restricted: Record<string, string[]>
}

const problems: string[] = []
const pkgDir = join(root, 'packages')
const packages = new Map<string, { dir: string; declared: Set<string>; imported: Map<string, string> }>()

for (const name of readdirSync(pkgDir)) {
  const dir = join(pkgDir, name)
  const pj = join(dir, 'package.json')
  if (!existsSync(pj)) continue
  const json = JSON.parse(readFileSync(pj, 'utf8'))
  const declared = new Set(
    Object.keys({ ...json.dependencies, ...json.devDependencies, ...json.peerDependencies }).filter((d) => d.startsWith('@mp/')),
  )
  packages.set(json.name, { dir, declared, imported: new Map() })
}

const walk = (dir: string, out: string[] = []) => {
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === 'dist') continue
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(f)) out.push(p)
  }
  return out
}

const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s+['"](@mp\/[a-z0-9-]+)(?:\/[^'"]*)?['"]|import\(\s*['"](@mp\/[a-z0-9-]+)(?:\/[^'"]*)?['"]\s*\)|import\s+['"](@mp\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/g

for (const [name, p] of packages) {
  for (const sub of ['src', 'test']) {
    for (const file of walk(join(p.dir, sub))) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(IMPORT_RE)) {
        const dep = m[1] ?? m[2] ?? m[3]!
        if (dep === name) continue
        // Tests may use lower-layer implementations freely, but still only lower layers.
        if (!p.imported.has(dep)) p.imported.set(dep, relative(root, file))
      }
    }
  }
}

const layer = (n: string) => cfg.layers[n]
const domainIndex = (n: string) => cfg.domainOrder.indexOf(n)

for (const [name, p] of packages) {
  const l = layer(name)
  if (l === undefined) {
    problems.push(`${name}: has no layer in scripts/layers.json`)
    continue
  }
  for (const [dep, file] of p.imported) {
    if (!p.declared.has(dep)) problems.push(`${name}: imports ${dep} (${file}) but doesn't declare it in package.json`)
  }
  const deps = new Set([...p.declared, ...p.imported.keys()])
  for (const dep of deps) {
    const dl = layer(dep)
    if (dl === undefined) {
      problems.push(`${name}: depends on ${dep}, which has no layer`)
      continue
    }
    const allowedList = cfg.restricted[name]
    if (allowedList && !allowedList.includes(dep)) {
      problems.push(`${name}: may only depend on ${allowedList.join(', ')}, not ${dep}`)
      continue
    }
    if (dl === cfg.adapterLayer && !cfg.adapterConsumers.includes(name) && l !== cfg.adapterLayer) {
      // Adapters may be used by the composition root only (tests of adapters live in the adapter itself).
      problems.push(`${name}: depends on adapter ${dep}; only ${cfg.adapterConsumers.join(', ')} may`)
      continue
    }
    const sameDomain = l === 3 && dl === 3
    if (sameDomain) {
      if (!(domainIndex(dep) >= 0 && domainIndex(name) >= 0 && domainIndex(dep) < domainIndex(name))) {
        problems.push(`${name}: depends on domain package ${dep}, which isn't listed before it in domainOrder`)
      }
    } else if (dl >= l) {
      problems.push(`${name} (layer ${l}): depends on ${dep} (layer ${dl}); dependencies must point to lower layers`)
    }
  }
}

// Cycles (should be impossible if the layer rules hold, but check the graph itself).
const graph = new Map([...packages].map(([n, p]) => [n, new Set([...p.declared, ...p.imported.keys()])]))
const state = new Map<string, 'visiting' | 'done'>()
const stack: string[] = []
const visit = (n: string) => {
  if (state.get(n) === 'done') return
  if (state.get(n) === 'visiting') {
    problems.push(`cycle: ${[...stack.slice(stack.indexOf(n)), n].join(' -> ')}`)
    return
  }
  state.set(n, 'visiting')
  stack.push(n)
  for (const d of graph.get(n) ?? []) if (graph.has(d)) visit(d)
  stack.pop()
  state.set(n, 'done')
}
for (const n of graph.keys()) visit(n)

if (problems.length) {
  console.error(`Dependency rules violated (${problems.length}):\n` + problems.map((p) => `  - ${p}`).join('\n'))
  process.exit(1)
}
console.log(`Dependency rules OK: ${packages.size} packages, no cycles.`)
