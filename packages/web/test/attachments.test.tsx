import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../src/app.tsx'
import { CHN, createMockDataLayer } from '../src/mock/index.ts'

const THREAD = 'msg_01JB0000000000000000000001'

function renderAt(path: string) {
  const data = createMockDataLayer({ now: Date.now() })
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <App data={data} />
    </MemoryRouter>,
  )
  return { ...utils, data }
}

const png = (name = 'chart.png', type = 'image/png') =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], name, { type })

describe('images in chat', () => {
  it('shows a message’s images as thumbnails and opens them in a lightbox that arrows and Esc control', async () => {
    renderAt(`/chat/${CHN.billing}/${THREAD}`)
    const thread = await screen.findByTestId('thread')
    const grid = await within(thread).findByTestId('attachments')
    const thumbs = within(grid).getAllByTestId('attachment-thumb')
    expect(thumbs).toHaveLength(2)
    // The saved description is the alt text; an image without one keeps its name.
    expect(within(thumbs[0]!).getByRole('img')).toHaveAttribute('alt', expect.stringMatching(/^A timeline of invoice INV-1002/))
    expect(within(thumbs[1]!).getByRole('img')).toHaveAttribute('alt', 'provider-dashboard.png')

    fireEvent.click(thumbs[0]!)
    const box = await screen.findByTestId('lightbox')
    expect(within(box).getByText('charges-timeline.png')).toBeInTheDocument()
    expect(within(box).getByText(/1000×340 · 47 KB · 1 of 2/)).toBeInTheDocument()
    expect(within(box).getByRole('link', { name: /Download/ })).toHaveAttribute('download', 'charges-timeline.png')
    fireEvent.keyDown(box, { key: 'ArrowRight' })
    expect(within(box).getByText('provider-dashboard.png')).toBeInTheDocument()
    fireEvent.keyDown(box, { key: 'ArrowRight' })
    expect(within(box).getByText('charges-timeline.png')).toBeInTheDocument()
    fireEvent.keyDown(box, { key: 'ArrowLeft' })
    expect(within(box).getByText('provider-dashboard.png')).toBeInTheDocument()
    fireEvent.click(within(box).getByRole('button', { name: 'Previous image' }))
    expect(within(box).getByText('charges-timeline.png')).toBeInTheDocument()
    fireEvent.keyDown(box, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('lightbox')).not.toBeInTheDocument())
  })

  it('attaches an image in a thread reply: pending thumbnail, upload, then the posted message shows it', async () => {
    const { data } = renderAt(`/chat/${CHN.billing}/${THREAD}`)
    const thread = await screen.findByTestId('thread')
    await within(thread).findByText(/Found it/)
    const input = within(thread).getByTestId('attach-input')
    await act(async () => {
      fireEvent.change(input, { target: { files: [png('refund-proof.png')] } })
    })
    const pending = await within(thread).findByTestId('pending-attachment')
    await waitFor(() => expect(pending).toHaveAttribute('data-state', 'done'))
    // An image alone can be sent: no text needed.
    const send = within(thread).getByRole('button', { name: /Send/ })
    expect(send).toBeEnabled()
    await act(async () => {
      fireEvent.click(send)
    })
    await waitFor(() => expect(within(thread).queryByTestId('pending-attachment')).not.toBeInTheDocument())
    const t = await data.api.thread(THREAD)
    const last = t.replies.at(-1)!
    expect(last.data.attachments).toEqual([expect.objectContaining({ name: 'refund-proof.png', mime: 'image/png' })])
    await within(thread).findByRole('button', { name: 'Open refund-proof.png' })
  })

  it('takes pasted images, refuses empty files, and lets a pending image be removed', async () => {
    renderAt(`/chat/${CHN.billing}`)
    const composer = (await screen.findAllByTestId('composer'))[0]!
    const box = within(composer).getByLabelText('Message')
    await act(async () => {
      fireEvent.paste(box, { clipboardData: { files: [png('pasted.png')] } })
    })
    expect(await within(composer).findByTestId('pending-attachment')).toBeInTheDocument()
    await act(async () => {
      fireEvent.change(within(composer).getByTestId('attach-input'), {
        target: { files: [new File([], 'empty.txt', { type: 'text/plain' })] },
      })
    })
    expect(within(composer).getByTestId('attach-notice')).toHaveTextContent('empty files')
    expect(within(composer).getAllByTestId('pending-attachment')).toHaveLength(1)
    fireEvent.click(within(composer).getByRole('button', { name: 'Remove pasted.png' }))
    expect(within(composer).queryByTestId('pending-attachment')).not.toBeInTheDocument()
    expect(within(composer).getByRole('button', { name: /Send/ })).toBeDisabled()
  })

  it('takes dropped images', async () => {
    renderAt(`/chat/${CHN.billing}`)
    const composer = (await screen.findAllByTestId('composer'))[0]!
    const files = [png('a.png'), png('b.jpg', 'image/jpeg')]
    fireEvent.dragOver(composer, { dataTransfer: { types: ['Files'], files } })
    await act(async () => {
      fireEvent.drop(composer, { dataTransfer: { types: ['Files'], files } })
    })
    expect(within(composer).getAllByTestId('pending-attachment')).toHaveLength(2)
  })

  it('the mock checks uploads like the server', async () => {
    const { api } = createMockDataLayer({ now: Date.now() })
    await expect(api.uploadAttachment(new File(['<svg/>'], 'x.png', { type: 'text/plain' }))).rejects.toMatchObject({
      status: 422,
    })
    expect((await api.uploadAttachment(new File(['<p>'], 'x.html', { type: 'text/html' }))).attachment).toMatchObject({
      kind: 'file',
      mime: 'text/html',
    })
    const up = await api.uploadAttachment(png())
    const m = await api.postMessage(CHN.billing, { text: '', attachments: [up.attachment.id] })
    expect(m.data.attachments).toHaveLength(1)
    await expect(api.postMessage(CHN.billing, { text: 'again', attachments: [up.attachment.id] })).rejects.toMatchObject({
      status: 409,
    })
    const del = await api.deleteMessage(m.id)
    expect(del.data.attachments).toBeUndefined()
    expect(api.attachmentUrl(up.attachment.id)).toBe('')
  })

  it('the lightbox captions an image with its AI description, with the visible text behind a toggle', async () => {
    renderAt(`/chat/${CHN.billing}/${THREAD}`)
    const thread = await screen.findByTestId('thread')
    const thumbs = within(await within(thread).findByTestId('attachments')).getAllByTestId('attachment-thumb')
    fireEvent.click(thumbs[0]!)
    const box = await screen.findByTestId('lightbox')
    const caption = within(box).getByTestId('image-description')
    expect(within(caption).getByText('Description (AI)')).toBeInTheDocument()
    expect(within(caption).getByTestId('image-description-text')).toHaveTextContent(/two \$412\.00 charges/)
    expect(within(box).getByTestId('lightbox-image')).toHaveAttribute('alt', expect.stringMatching(/^A timeline/))
    expect(within(caption).queryByTestId('image-visible-text')).not.toBeInTheDocument()
    fireEvent.click(within(caption).getByRole('button', { name: 'Show visible text' }))
    expect(within(caption).getByTestId('image-visible-text')).toHaveTextContent('INV-1002 · charges on Sep 27')
  })

  it('an admin or the uploader edits and clears a description, marked as edited by them', async () => {
    renderAt(`/chat/${CHN.billing}/${THREAD}`)
    const thread = await screen.findByTestId('thread')
    const thumbs = within(await within(thread).findByTestId('attachments')).getAllByTestId('attachment-thumb')
    fireEvent.click(thumbs[0]!)
    const box = await screen.findByTestId('lightbox')
    const caption = within(box).getByTestId('image-description')
    // The server says who may edit (the mock's person is an admin).
    fireEvent.click(await within(caption).findByRole('button', { name: /Edit/ }))
    const field = within(caption).getByLabelText('Image description')
    fireEvent.change(field, { target: { value: 'Two duplicate charges on INV-1002.' } })
    await act(async () => {
      fireEvent.click(within(caption).getByRole('button', { name: 'Save' }))
    })
    await waitFor(() => expect(within(caption).getByText(/Description \(edited by /)).toBeInTheDocument())
    expect(within(caption).getByTestId('image-description-text')).toHaveTextContent('Two duplicate charges on INV-1002.')
    expect(within(box).getByTestId('lightbox-image')).toHaveAttribute('alt', 'Two duplicate charges on INV-1002.')
    await act(async () => {
      fireEvent.click(within(caption).getByRole('button', { name: /Clear/ }))
    })
    await waitFor(() => expect(within(caption).getByText('No description yet.')).toBeInTheDocument())
    expect(within(box).getByTestId('lightbox-image')).toHaveAttribute('alt', 'charges-timeline.png')
    // Describe makes a new one.
    await act(async () => {
      fireEvent.click(within(caption).getByRole('button', { name: /Describe/ }))
    })
    await waitFor(() => expect(within(caption).getByText('Description (AI)')).toBeInTheDocument())
  })

  it('the mock keeps descriptions to those who may change them', async () => {
    const data = createMockDataLayer({ now: Date.now() })
    const withImages = (t: Awaited<ReturnType<typeof data.api.thread>>) =>
      [t.root, ...t.replies].find((m) => m.data.attachments?.length)!
    const att = withImages(await data.api.thread(THREAD)).data.attachments![0]!
    const d = await data.api.attachmentDescription(att.id)
    expect(d).toMatchObject({ available: true, canEdit: true, attachment: { description: expect.any(String) } })
    const edited = await data.api.updateAttachment(att.id, { description: 'New.' })
    expect(edited.attachment).toMatchObject({ description: 'New.', descriptionEditedBy: { kind: 'contact' } })
    // The message has it too.
    expect(withImages(await data.api.thread(THREAD)).data.attachments![0]!.description).toBe('New.')
    await expect(data.api.attachmentDescription('att_nope')).rejects.toMatchObject({ status: 404 })
  })
})

describe('files in chat', () => {
  const INC_THREAD = 'msg_01JB0000000000000000000020'

  it('shows a file as a chip with its name, size and a download link, and no image thumbnail', async () => {
    renderAt(`/chat/${CHN.inc42}/${INC_THREAD}`)
    const thread = await screen.findByTestId('thread')
    const chip = await within(thread).findByTestId('file-attachment')
    expect(within(chip).getByText('free-disk.sh')).toBeInTheDocument()
    expect(within(chip).getByText(/\d+ B$/)).toBeInTheDocument()
    const link = within(chip).getByRole('link', { name: 'Download free-disk.sh' })
    expect(link).toHaveAttribute('download', 'free-disk.sh')
    expect(within(chip).queryByRole('img')).not.toBeInTheDocument()
    // The chart on the same message stays an image thumbnail.
    expect(within(within(thread).getByTestId('attachments')).getAllByTestId('attachment-thumb')).toHaveLength(1)
  })

  it('previews a text file as plain text: the first lines, then all of it', async () => {
    renderAt(`/chat/${CHN.inc42}/${INC_THREAD}`)
    const thread = await screen.findByTestId('thread')
    const preview = await within(thread).findByTestId('text-preview')
    const body = within(preview).getByTestId('text-preview-body')
    expect(body.tagName).toBe('PRE')
    expect(body.textContent).toMatch(/^#!\/bin\/sh\n/)
    expect(body.textContent).not.toContain('apt-get clean')
    expect(body.textContent!.split('\n')).toHaveLength(8)
    fireEvent.click(within(preview).getByRole('button', { name: /Show all \d+ lines/ }))
    expect(body.textContent).toContain('apt-get clean')
    fireEvent.click(within(preview).getByRole('button', { name: /Collapse/ }))
    expect(body.textContent).not.toContain('apt-get clean')
  })

  it('renders markup in a preview as text, never as HTML', async () => {
    const data = createMockDataLayer({ now: Date.now() })
    const up = await data.api.uploadAttachment(
      new File(['<img src=x onerror="alert(1)"><b>bold</b>'], 'page.html', { type: 'text/html' }),
    )
    await data.api.postMessage(CHN.billing, { text: 'markup', attachments: [up.attachment.id] })
    render(
      <MemoryRouter initialEntries={[`/chat/${CHN.billing}`]}>
        <App data={data} />
      </MemoryRouter>,
    )
    const body = await screen.findByTestId('text-preview-body')
    expect(body.textContent).toBe('<img src=x onerror="alert(1)"><b>bold</b>')
    expect(body.querySelector('img, b')).toBeNull()
  })

  it('attaches any file from the composer and posts it as a file', async () => {
    const { data } = renderAt(`/chat/${CHN.billing}/${THREAD}`)
    const thread = await screen.findByTestId('thread')
    await within(thread).findByText(/Found it/)
    expect(within(thread).getByRole('button', { name: 'Attach files' })).toBeInTheDocument()
    expect(within(thread).getByTestId('attach-input')).not.toHaveAttribute('accept')
    await act(async () => {
      fireEvent.change(within(thread).getByTestId('attach-input'), {
        target: { files: [new File(['echo hello\n'], 'hello.sh', { type: 'application/x-sh' })] },
      })
    })
    const pending = await within(thread).findByTestId('pending-attachment')
    expect(within(pending).getByTestId('pending-file')).toHaveTextContent('hello.sh')
    await waitFor(() => expect(pending).toHaveAttribute('data-state', 'done'))
    await act(async () => {
      fireEvent.click(within(thread).getByRole('button', { name: /Send/ }))
    })
    const t = await data.api.thread(THREAD)
    expect(t.replies.at(-1)!.data.attachments).toEqual([
      expect.objectContaining({ kind: 'file', name: 'hello.sh', mime: 'text/x-shellscript' }),
    ])
    expect(await data.api.attachmentText(t.replies.at(-1)!.data.attachments![0]!.id)).toMatchObject({
      text: 'echo hello\n',
      truncated: false,
    })
    await within(thread).findByRole('link', { name: 'Download hello.sh' })
  })
})
