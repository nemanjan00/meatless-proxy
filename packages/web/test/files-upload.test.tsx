import { type Access, FILE_WRITE_MAX_BYTES } from '@mp/api'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { base64ToBytes, bytesToBase64, fileToBase64, joinPath, parentDir } from '../src/components/file-upload.tsx'
import { CON, createMockApi, createMockDb, createMockLive, EMP } from '../src/mock/index.ts'

function renderAt(
  path: string,
  who: { id: string; name: string; access: Access } = { id: CON.ana, name: 'Ana Novak', access: 'admin' },
  seed?: (db: ReturnType<typeof createMockDb>) => void,
) {
  const db = createMockDb({ now: Date.now() })
  seed?.(db)
  const api = createMockApi(db, { me: who })
  const data = { api, live: createMockLive(db.now), mock: true }
  render(
    <MemoryRouter initialEntries={[path]}>
      <App data={data} />
    </MemoryRouter>,
  )
  return { api, db }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 0xff, 0xfe])
const png = (name = 'logo.png') => new File([PNG], name, { type: 'image/png' })
const text = (name: string, body: string) => new File([body], name, { type: 'text/plain' })

const list = () => screen.findByTestId('file-list')
const folder = async (name: string) => within(await list()).findByRole('button', { name })
const pick = async (files: File[]) => {
  await act(async () => {
    fireEvent.change(screen.getByTestId('upload-input'), { target: { files } })
  })
}
const items = () => screen.queryAllByTestId('upload-item')
const allSettled = () =>
  waitFor(() => {
    expect(items().length).toBeGreaterThan(0)
    for (const i of items()) expect(i.dataset.state).not.toMatch(/queued|uploading/)
  })
const stored = (db: ReturnType<typeof createMockDb>, path: string) => db.files.get(EMP.billing)?.get(path)

describe('uploading into employee files', () => {
  it('uploads picked files, text and binary, into the directory shown, with progress', async () => {
    const { db } = renderAt(`/files?employee=${EMP.billing}`)
    fireEvent.click(await folder('drafts'))
    expect(screen.getByTestId('upload-target')).toHaveTextContent('/drafts')
    await pick([png(), text('todo.txt', 'buy milk')])
    await allSettled()
    expect(items().map((i) => i.dataset.state)).toEqual(['done', 'done'])
    expect(screen.getByTestId('upload-panel')).toHaveTextContent(/Uploaded 2 of 2/)
    const logo = stored(db, '/drafts/logo.png')!
    expect(logo.encoding).toBe('base64')
    expect(base64ToBytes(logo.content)).toEqual(PNG)
    expect(logo.size).toBe(PNG.length)
    expect(new TextDecoder().decode(base64ToBytes(stored(db, '/drafts/todo.txt')!.content))).toBe('buy milk')
    // The listing reloads with the new files.
    expect(await within(await list()).findByRole('button', { name: 'logo.png' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss uploads' }))
    expect(screen.queryByTestId('upload-panel')).not.toBeInTheDocument()
  })

  it('asks before replacing a file: cancel leaves it, skip keeps it, replace overwrites it', async () => {
    const { db } = renderAt(`/files?employee=${EMP.billing}`)
    // /notes starts open: close and open it again to make it the current directory.
    fireEvent.click(await folder('notes'))
    fireEvent.click(await folder('notes'))
    expect(screen.getByTestId('upload-target')).toHaveTextContent('/notes')
    const before = stored(db, '/notes/pay-123.md')!.content

    await pick([text('pay-123.md', '# replaced')])
    const dialog = await screen.findByTestId('replace-dialog')
    expect(dialog).toHaveTextContent('Replace a file?')
    expect(dialog).toHaveTextContent('pay-123.md')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByTestId('replace-dialog')).not.toBeInTheDocument())
    expect(stored(db, '/notes/pay-123.md')!.content).toBe(before)

    await pick([text('pay-123.md', '# replaced'), text('new.md', '# new')])
    fireEvent.click(within(await screen.findByTestId('replace-dialog')).getByRole('button', { name: 'Skip existing' }))
    await allSettled()
    expect(items().map((i) => i.dataset.state)).toEqual(['skipped', 'done'])
    expect(stored(db, '/notes/pay-123.md')!.content).toBe(before)
    expect(stored(db, '/notes/new.md')).toBeDefined()

    await pick([text('pay-123.md', '# replaced')])
    fireEvent.click(within(await screen.findByTestId('replace-dialog')).getByRole('button', { name: 'Replace' }))
    await allSettled()
    expect(new TextDecoder().decode(base64ToBytes(stored(db, '/notes/pay-123.md')!.content))).toBe('# replaced')
  })

  it('takes files dropped on a folder, and refuses drops where you can’t write', async () => {
    const { db } = renderAt(`/files?employee=${EMP.billing}`)
    const exports = await folder('exports')
    const files = [png('chart.png')]
    fireEvent.dragOver(exports, { dataTransfer: { types: ['Files'], files } })
    expect(screen.getByTestId('upload-target')).toHaveTextContent('Drop to upload to /exports')
    await act(async () => {
      fireEvent.drop(exports, { dataTransfer: { types: ['Files'], files } })
    })
    await allSettled()
    expect(stored(db, '/exports/chart.png')?.encoding).toBe('base64')

    // /shared holds other employees' files: nothing goes there.
    const shared = await folder('shared')
    fireEvent.dragOver(shared, { dataTransfer: { types: ['Files'], files } })
    expect(screen.getByTestId('upload-target')).not.toHaveTextContent('Drop to upload')
    await act(async () => {
      fireEvent.drop(shared, { dataTransfer: { types: ['Files'], files: [png('nope.png')] } })
    })
    expect([...(db.files.get(EMP.billing)?.keys() ?? [])].filter((p) => p.endsWith('nope.png'))).toEqual([])
    fireEvent.click(shared)
    expect(screen.queryByRole('button', { name: /^Upload$/ })).not.toBeInTheDocument()
  })

  it('shows what failed: a file over the limit is not sent, a refused write says why', async () => {
    const { api, db } = renderAt(`/files?employee=${EMP.billing}`)
    fireEvent.click(await folder('drafts'))
    const big = new File([new Uint8Array(FILE_WRITE_MAX_BYTES + 1)], 'huge.bin')
    const real = api.writeFile
    api.writeFile = (...args) =>
      args[1].endsWith('locked.txt') ? Promise.reject(Object.assign(new Error('disk is full'), { status: 507 })) : real(...args)
    await pick([big, text('locked.txt', 'x'), text('ok.txt', 'y')])
    await allSettled()
    const [huge, locked, ok] = items()
    expect(huge!.dataset.state).toBe('error')
    expect(huge).toHaveTextContent('over 10.0 MB')
    expect(locked!.dataset.state).toBe('error')
    expect(locked).toHaveTextContent('disk is full')
    expect(ok!.dataset.state).toBe('done')
    expect(stored(db, '/drafts/huge.bin')).toBeUndefined()
    expect(stored(db, '/drafts/ok.txt')).toBeDefined()
  })

  it('has no upload for people who can’t write', async () => {
    renderAt(`/files?employee=${EMP.billing}`, { id: CON.eli, name: 'Eli Brown', access: 'viewer' })
    fireEvent.click(await folder('drafts'))
    expect(screen.queryByRole('button', { name: /^Upload$/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId('upload-input')).not.toBeInTheDocument()
  })

  it('shows an uploaded binary file as a download, not as text', async () => {
    renderAt(`/files?employee=${EMP.billing}&path=/drafts/logo.png`, undefined, (db) =>
      db.files.get(EMP.billing)!.set('/drafts/logo.png', {
        path: '/drafts/logo.png',
        content: bytesToBase64(PNG),
        encoding: 'base64',
        size: PNG.length,
        version: 1,
        updatedAt: new Date().toISOString(),
      }),
    )
    const bin = await screen.findByTestId('binary-file')
    expect(bin).toHaveTextContent(`Binary file · ${PNG.length} B`)
    expect(within(bin).getByRole('button', { name: /Download/ })).toBeInTheDocument()
    expect(screen.queryByLabelText('File content')).not.toBeInTheDocument()
  })
})

describe('upload helpers', () => {
  it('round-trips bytes through base64, past one chunk', async () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 256)
    const b64 = bytesToBase64(bytes)
    expect(b64).toBe(Buffer.from(bytes).toString('base64'))
    expect(base64ToBytes(b64)).toEqual(bytes)
    expect(await fileToBase64(new File([bytes], 'x.bin'))).toBe(b64)
  })

  it('joins and splits paths', () => {
    expect(joinPath('/', 'a.md')).toBe('/a.md')
    expect(joinPath('/notes', 'a.md')).toBe('/notes/a.md')
    expect(parentDir('/notes/a.md')).toBe('/notes')
    expect(parentDir('/a.md')).toBe('/')
  })
})
