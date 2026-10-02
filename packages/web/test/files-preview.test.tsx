import type { Access } from '@mp/api'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { bytesToBase64 } from '../src/components/file-upload.tsx'
import { CON, createMockApi, createMockDb, createMockLive, EMP } from '../src/mock/index.ts'

type Db = ReturnType<typeof createMockDb>

function renderAt(path: string, seed?: (db: Db) => void, who: { id: string; name: string; access: Access } = ADMIN) {
  const db = createMockDb({ now: Date.now() })
  seed?.(db)
  const api = createMockApi(db, { me: who })
  render(
    <MemoryRouter initialEntries={[path]}>
      <App data={{ api, live: createMockLive(db.now), mock: true }} />
    </MemoryRouter>,
  )
  return { api, db }
}

const ADMIN = { id: CON.ana, name: 'Ana Novak', access: 'admin' as const }
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
/** A PNG's signature and IHDR: 40 × 30 pixels. */
const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0,
  0,
  0,
  13,
  0x49,
  0x48,
  0x44,
  0x52,
  ...u32(40),
  ...u32(30),
  8,
  6,
  0,
  0,
  0,
])
const put = (db: Db, path: string, bytes: Uint8Array, size = bytes.length) =>
  db.files.get(EMP.billing)!.set(path, {
    path,
    content: bytesToBase64(bytes),
    encoding: 'base64',
    size,
    version: 3,
    updatedAt: new Date().toISOString(),
  })
const list = () => screen.findByTestId('file-list')
const row = async (name: string) => within(await list()).findByRole('button', { name })

describe('image previews in files', () => {
  it('shows an image inline, scaled to fit, with its dimensions and size, and a download', async () => {
    const { api } = renderAt(`/files?employee=${EMP.billing}&path=/drafts/chart.png`, (db) => put(db, '/drafts/chart.png', PNG))
    const img = (await screen.findByTestId('image-preview')) as HTMLImageElement
    expect(img).toHaveAttribute('alt', 'chart.png')
    expect(img.src).toBe(api.fileUrl(EMP.billing, '/drafts/chart.png', { version: 3 }))
    expect(img.src).toMatch(/^data:image\/png;base64,/)
    expect(img.className).toMatch(/max-w-full/)
    expect(img.className).toMatch(/object-contain/)
    const info = screen.getByTestId('image-info')
    expect(info).toHaveTextContent(`PNG image · 40 × 30 · ${PNG.length} B`)
    expect(within(info).getByRole('button', { name: /Download/ })).toBeInTheDocument()
    expect(screen.queryByTestId('binary-file')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('File content')).not.toBeInTheDocument()
  })

  it('decides by the bytes: an image name with other bytes is a binary file', async () => {
    renderAt(`/files?employee=${EMP.billing}&path=/drafts/fake.png`, (db) =>
      put(db, '/drafts/fake.png', new Uint8Array([0, 1, 2, 0xff])),
    )
    expect(await screen.findByTestId('binary-file')).toHaveTextContent('Binary file · 4 B')
    expect(screen.queryByTestId('image-preview')).not.toBeInTheDocument()
  })

  it('shows an SVG as text with a download, never as markup or an image', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    renderAt(`/files?employee=${EMP.billing}&path=/drafts/icon.svg`, (db) =>
      db.files
        .get(EMP.billing)!
        .set('/drafts/icon.svg', { path: '/drafts/icon.svg', content: svg, version: 1, updatedAt: new Date().toISOString() }),
    )
    const bar = await screen.findByTestId('svg-file')
    expect(bar).toHaveTextContent(/SVG image .* shown as text/)
    expect(within(bar).getByRole('button', { name: /Download/ })).toBeInTheDocument()
    expect(screen.getByLabelText('File content')).toHaveValue(svg)
    expect(screen.queryByTestId('image-preview')).not.toBeInTheDocument()
    expect(document.querySelector('svg script')).toBeNull()
  })

  it('previews files shared with the employee too', async () => {
    renderAt(`/files?employee=${EMP.billing}&path=/shared/infra-bot/diagram.png`, (db) =>
      put(db, '/shared/infra-bot/diagram.png', PNG),
    )
    expect(await screen.findByTestId('image-preview')).toHaveAttribute('alt', 'diagram.png')
    expect(screen.getByText('shared · read-only')).toBeInTheDocument()
  })
})

describe('thumbnails in the file list', () => {
  it('shows small lazy thumbnails for images, an icon for big ones, and none for other files', async () => {
    const { api } = renderAt(`/files?employee=${EMP.billing}`, (db) => {
      put(db, '/pics/small.png', PNG)
      put(db, '/pics/huge.png', PNG, 5 * 1024 * 1024)
      put(db, '/pics/notes.bin', PNG)
    })
    fireEvent.click(await row('pics'))
    const small = await row('small.png')
    const thumb = within(small).getByTestId('file-thumbnail') as HTMLImageElement
    expect(thumb).toHaveAttribute('loading', 'lazy')
    expect(thumb).toHaveAttribute('width', '16')
    expect(thumb.src).toBe(api.fileUrl(EMP.billing, '/pics/small.png', { version: 3 }))
    const huge = await row('huge.png')
    expect(within(huge).queryByTestId('file-thumbnail')).not.toBeInTheDocument()
    expect(within(huge).getByTestId('file-image-icon')).toBeInTheDocument()
    expect(within(await row('notes.bin')).queryByTestId('file-thumbnail')).not.toBeInTheDocument()
  })

  it('falls back to an icon when the thumbnail does not load', async () => {
    renderAt(`/files?employee=${EMP.billing}`, (db) => put(db, '/pics/broken.png', new Uint8Array([1, 2, 3])))
    fireEvent.click(await row('pics'))
    const r = await row('broken.png')
    fireEvent.error(within(r).getByTestId('file-thumbnail'))
    expect(within(r).queryByTestId('file-thumbnail')).not.toBeInTheDocument()
    expect(within(r).getByTestId('file-image-icon')).toBeInTheDocument()
  })
})
