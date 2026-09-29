import { DeniedError } from '@mp/core'
import { solidPng, sha256Hex } from '@mp/files'
import { describe, expect, it } from 'vitest'
import { stack } from './helpers.ts'

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const red = solidPng(20, 10, [220, 20, 20, 255])

describe('chat.post and chat.reply with attachments', () => {
  it('attaches an image from the employee’s own files', async () => {
    const h = await stack()
    await h.files.write(h.employee.id, '/charts/q3.png', b64(red), { encoding: 'base64' })
    const ch = await h.chat.createChannel({ name: 'reports', createdBy: { kind: 'contact', id: h.ana.id } })
    const out = await h.out('chat.post', { channel: 'reports', text: 'Q3 chart', attachments: [{ path: '/charts/q3.png' }] })
    const m = (await h.chat.getMessage(out.messageId))!
    expect(m.data.attachments).toEqual([
      {
        id: expect.stringMatching(/^att_/),
        kind: 'image',
        name: 'q3.png',
        mime: 'image/png',
        size: red.length,
        width: 20,
        height: 10,
      },
    ])
    const att = (await h.attachments.read(m.data.attachments![0]!.id))!
    expect(att.bytes).toEqual(red)
    expect(att.attachment.data).toMatchObject({ uploadedBy: { kind: 'session', id: h.session.id }, channelId: ch.id })
    // A reply with only an image, no text.
    const r = await h.out('chat.reply', { threadId: out.threadId, text: '', attachments: [{ path: '/charts/q3.png' }] })
    expect((await h.chat.getMessage(r.messageId))!.data.attachments).toHaveLength(1)
    // chat.read names the images.
    const read = await h.out('chat.read', { threadId: out.threadId })
    expect(read.messages[0].attachments[0]).toMatch(/^\[image: q3\.png 20x10, attachment att_/)
  })

  it('takes files shared with the employee, and refuses ones that aren’t', async () => {
    const h = await stack()
    const other = await h.directory.employees.create({ name: 'Designer', toolAllow: ['**'] })
    await h.files.write(other.id, '/mock.png', b64(red), { encoding: 'base64' })
    await h.files.write(other.id, '/private.png', b64(red), { encoding: 'base64' })
    await h.chat.createChannel({ name: 'design', createdBy: { kind: 'contact', id: h.ana.id } })
    await expect(
      h.call('chat.post', { channel: 'design', text: 'x', attachments: [{ path: `/shared/${other.id}/mock.png` }] }),
    ).rejects.toBeInstanceOf(DeniedError)
    await h.files.share(other.id, '/mock.png', h.employee.data.contactId, 'read')
    const out = await h.out('chat.post', {
      channel: 'design',
      text: 'x',
      attachments: [{ path: `/shared/${other.id}/mock.png` }],
    })
    expect((await h.chat.getMessage(out.messageId))!.data.attachments![0]!.name).toBe('mock.png')
    await expect(
      h.call('chat.post', { channel: 'design', text: 'y', attachments: [{ path: `/shared/${other.id}/private.png` }] }),
    ).rejects.toBeInstanceOf(DeniedError)
  })

  it('refuses files that aren’t images, and messages with nothing in them', async () => {
    const h = await stack()
    await h.files.write(h.employee.id, '/fake.png', '<svg onload="alert(1)"/>')
    await h.chat.createChannel({ name: 'design', createdBy: { kind: 'contact', id: h.ana.id } })
    const r = await h.call('chat.post', { channel: 'design', text: 'x', attachments: [{ path: '/fake.png' }] })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('says it is an image')
    expect((await h.call('chat.post', { channel: 'design', text: '' })).isError).toBe(true)
    expect(await h.chat.messages((await h.chat.channelByName('design'))!.id)).toHaveLength(0)
  })
})

describe('image.view', () => {
  it('returns an image of the employee’s own files by reference', async () => {
    const h = await stack()
    await h.files.write(h.employee.id, '/chart.png', b64(red), { encoding: 'base64' })
    const r = await h.call('image.view', { path: '/chart.png' })
    expect(r.isError).toBeFalsy()
    expect(r.output).toEqual({ image: 'chart.png', mime: 'image/png', size: '20x10', note: 'The image is attached below.' })
    expect(r.images).toEqual([
      {
        source: 'file',
        owner: h.employee.id,
        path: '/chart.png',
        sha256: sha256Hex(red),
        name: 'chart.png',
        mime: 'image/png',
        width: 20,
        height: 10,
      },
    ])
    expect(JSON.stringify(r)).not.toContain(b64(red))
    expect(h.tools.get('image.view')!.def.tags).toEqual(['vision'])
  })

  it('says when a big PNG is shown downscaled, and refuses what is too large or not an image', async () => {
    const h = await stack()
    await h.files.write(h.employee.id, '/wide.png', b64(solidPng(3136, 100, [0, 0, 0, 255])), { encoding: 'base64' })
    expect((await h.out('image.view', { path: '/wide.png' })).shownAs).toBe('1568x50')
    await h.files.write(h.employee.id, '/notes.txt', 'hello')
    expect((await h.call('image.view', { path: '/notes.txt' })).isError).toBe(true)
    expect((await h.call('image.view', {})).isError).toBe(true)
    expect((await h.call('image.view', { path: '/wide.png', attachment: 'att_x' })).isError).toBe(true)
  })

  it('looks at an attachment in a channel it can see, and not in a DM it isn’t in', async () => {
    const h = await stack()
    const ana = { kind: 'contact' as const, id: h.ana.id }
    const ch = await h.chat.createChannel({ name: 'design', createdBy: ana })
    const up = await h.attachments.upload({ bytes: red, name: 'mock.png', by: ana })
    await h.chat.post({ channelId: ch.id, author: ana, text: 'look', attachments: [up.id] })
    const r = await h.call('image.view', { attachment: up.id })
    expect(r.images![0]).toMatchObject({ source: 'attachment', id: up.id, sha256: sha256Hex(red), name: 'mock.png' })

    const bob = await h.directory.contacts.create({ name: 'Bob', email: 'bob@example.com' })
    const dm = await h.chat.openDm([ana, { kind: 'contact', id: bob.id }], ana)
    const secret = await h.attachments.upload({ bytes: red, name: 'secret.png', by: ana })
    await h.chat.post({ channelId: dm.id, author: ana, text: 'just us', attachments: [secret.id] })
    const denied = await h.call('image.view', { attachment: secret.id })
    expect(denied.isError).toBe(true)
    expect(denied.images).toBeUndefined()
    // Once the employee is in the DM, it can look.
    await h.chat.addMember(dm.id, { kind: 'employee', id: h.employee.id })
    expect((await h.call('image.view', { attachment: secret.id })).isError).toBeFalsy()
    // Uploads nobody attached yet are nobody's to look at.
    const pending = await h.attachments.upload({ bytes: red, by: ana })
    expect((await h.call('image.view', { attachment: pending.id })).isError).toBe(true)
  })

  it('says so when the model can’t see images', async () => {
    const h = await stack({ vision: false })
    await h.files.write(h.employee.id, '/chart.png', b64(red), { encoding: 'base64' })
    const r = await h.call('image.view', { path: '/chart.png' })
    expect(r).toMatchObject({ isError: true, output: { error: "this model can't see images" } })
  })
})
