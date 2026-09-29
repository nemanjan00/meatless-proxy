import { chmod, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { DeniedError, ValidationError } from '@mp/core'
import type { WorktreeFs } from './types.ts'

/**
 * Normalizes a path inside a worktree to a relative POSIX path (`''` for the
 * root). Refuses anything that would leave the worktree (`..`, absolute paths
 * outside it) and anything inside `.git`.
 */
export function safeRelPath(root: string, path: string | undefined): string {
  const p = (path ?? '').replace(/\\/g, '/').trim()
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f]/.test(p)) throw new ValidationError('path contains control characters')
  const base = resolve(root)
  const abs = resolve(base, p.startsWith('/') && !p.startsWith(base) ? `.${p}` : p)
  const rel = relative(base, abs)
  if (rel === '') return ''
  if (rel.startsWith('..') || resolve(base, rel) !== abs) throw new DeniedError(`path ${path} is outside the worktree`)
  const parts = rel.split(sep)
  if (parts[0] === '.git') throw new DeniedError("the worktree's .git is off limits")
  return parts.join('/')
}

/** `WorktreeFs` on the local disk. Also refuses paths that escape the worktree through symlinks. */
export function nodeWorktreeFs(): WorktreeFs {
  const inside = async (root: string, abs: string) => {
    const realRoot = await realpath(root)
    let probe = abs
    // The deepest existing ancestor decides where the path really is.
    for (;;) {
      try {
        const real = await realpath(probe)
        if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new DeniedError('path is outside the worktree')
        return
      } catch (e) {
        if (e instanceof DeniedError) throw e
        const up = dirname(probe)
        if (up === probe) throw e
        probe = up
      }
    }
  }
  return {
    async read(root, rel) {
      const abs = join(root, rel)
      await inside(root, abs)
      return readFile(abs, 'utf8')
    },
    async write(root, rel, content) {
      const abs = join(root, rel)
      await inside(root, abs)
      await mkdir(dirname(abs), { recursive: true })
      await inside(root, abs)
      await writeFile(abs, content, 'utf8')
    },
    async setExecutable(root, rel, executable) {
      const abs = join(root, rel)
      await inside(root, abs)
      const mode = (await stat(abs)).mode & 0o777
      await chmod(abs, executable ? mode | 0o111 : mode & ~0o111)
    },
    async list(root, rel) {
      const abs = join(root, rel)
      await inside(root, abs)
      const entries = await readdir(abs, { withFileTypes: true })
      return entries
        .filter((e) => !(rel === '' && e.name === '.git'))
        .map((e) => ({ name: e.name, type: e.isDirectory() ? ('dir' as const) : ('file' as const) }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    },
  }
}
