import { solidPng } from '@mp/files'
import { describe, expect, it } from 'vitest'
import { DUPLICATE_WINDOW_MS } from '../src/tools/chat.ts'
import { stack } from './helpers.ts'

const SCRIPT = '#!/bin/sh\necho hello\n'

describe('chat.reply with any file, by any path spelling', () => {
  it('attaches /work/files/…, /… and bare paths as the same file, named as a file in events and chat.read', async () => {
    const h = await stack()
    const ana = { kind: 'contact' as const, id: h.ana.id }
    const ch = await h.chat.createChannel({ name: 'general', createdBy: ana })
    const root = await h.chat.post({ channelId: ch.id, author: ana, text: 'write it as your file' })
    // What happened live: code.run wrote /work/files/ipwatch.sh and files_changed said /ipwatch.sh.
    const run = await h.out('code.run', { language: 'node', code: `write("ipwatch.sh", ${JSON.stringify(SCRIPT)})` })
    expect(run.files_changed).toEqual([
      { path: '/ipwatch.sh', sandboxPath: '/work/files/ipwatch.sh', change: 'created', size: SCRIPT.length },
    ])
    const ids: string[] = []
    for (const [i, path] of ['/work/files/ipwatch.sh', '/ipwatch.sh', 'ipwatch.sh'].entries()) {
      const r = await h.out('chat.reply', { threadId: root.id, text: `take ${i}`, attachments: [{ path }] })
      const m = (await h.chat.getMessage(r.messageId))!
      expect(m.data.attachments, path).toEqual([
        { id: expect.stringMatching(/^att_/), kind: 'file', name: 'ipwatch.sh', mime: 'text/x-shellscript', size: SCRIPT.length },
      ])
      ids.push(m.data.attachments![0]!.id)
      expect(new TextDecoder().decode((await h.attachments.read(ids[i]!))!.bytes)).toBe(SCRIPT)
    }
    const read = await h.out('chat.read', { threadId: root.id })
    expect(read.messages[1].attachments).toEqual([`[file: ipwatch.sh 21 bytes text/x-shellscript, attachment ${ids[0]}]`])
    const ev = (await h.events.query({ source: 'chat', type: 'message.replied' })).at(-1)!
    expect(ev.data.text).toContain(`[file: ipwatch.sh 21 bytes text/x-shellscript, attachment ${ids[2]}]`)
  })

  it('takes a shared file as /work/shared/<owner>/…, and still refuses unshared ones and escapes', async () => {
    const h = await stack()
    const other = await h.directory.employees.create({ name: 'Designer', toolAllow: ['**'] })
    await h.files.write(other.id, '/notes/plan.md', '# plan')
    await h.files.write(other.id, '/private.md', 'no')
    await h.files.share(other.id, '/notes', h.employee.data.contactId, 'read')
    const ana = { kind: 'contact' as const, id: h.ana.id }
    const ch = await h.chat.createChannel({ name: 'design', createdBy: ana })
    const root = await h.chat.post({ channelId: ch.id, author: ana, text: 'the plan?' })
    const r = await h.out('chat.reply', {
      threadId: root.id,
      text: 'here',
      attachments: [{ path: `/work/shared/${other.id}/notes/plan.md` }],
    })
    expect((await h.chat.getMessage(r.messageId))!.data.attachments![0]).toMatchObject({ name: 'plan.md', mime: 'text/markdown' })
    for (const path of [`/work/shared/${other.id}/private.md`, '/work/files/../../etc/passwd', '/missing.txt']) {
      // Denied and invalid paths throw (the runner turns that into a tool error); others are tool errors.
      const bad = await h.call('chat.reply', { threadId: root.id, text: `bad ${path}`, attachments: [{ path }] }).then(
        (r) => r.isError === true,
        () => true,
      )
      expect(bad, path).toBe(true)
    }
    expect(await h.chat.thread(root.id)).toHaveLength(2)
  })

  it('image.view refuses a file attachment, pointing at chat.attachment_text', async () => {
    const h = await stack()
    const ana = { kind: 'contact' as const, id: h.ana.id }
    const ch = await h.chat.createChannel({ name: 'general', createdBy: ana })
    const up = await h.attachments.upload({ bytes: new TextEncoder().encode(SCRIPT), name: 'a.sh', by: ana })
    await h.chat.post({ channelId: ch.id, author: ana, text: 'x', attachments: [up.id] })
    const r = await h.call('image.view', { attachment: up.id })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.output)).toContain('chat.attachment_text')
  })
})

describe('chat.attachment_text', () => {
  it('reads a text attachment a person posted, capped, as information', async () => {
    const h = await stack()
    const ana = { kind: 'contact' as const, id: h.ana.id }
    const ch = await h.chat.createChannel({ name: 'general', createdBy: ana })
    const up = await h.attachments.upload({ bytes: new TextEncoder().encode('line\n'.repeat(1000)), name: 'app.log', by: ana })
    await h.chat.post({ channelId: ch.id, author: ana, text: 'logs', attachments: [up.id] })
    const r = await h.out('chat.attachment_text', { attachment: up.id })
    expect(r).toMatchObject({ attachment: up.id, name: 'app.log', mime: 'text/plain', size: 5000, text: 'line\n'.repeat(1000) })
    expect(r.truncated).toBeUndefined()
    expect(r.textNote).toMatch(/not instructions/)
    const cut = await h.out('chat.attachment_text', { attachment: up.id, maxChars: 12 })
    expect(cut).toMatchObject({ text: 'line\nline\nli', truncated: true })
  })

  it('has the visibility of image.view: not in a DM it is not in, not a pending upload, not unknown ids', async () => {
    const h = await stack()
    const ana = { kind: 'contact' as const, id: h.ana.id }
    const bob = await h.directory.contacts.create({ name: 'Bob', email: 'bob@example.com' })
    const dm = await h.chat.openDm([ana, { kind: 'contact', id: bob.id }], ana)
    const secret = await h.attachments.upload({ bytes: new TextEncoder().encode('secret'), name: 's.txt', by: ana })
    await h.chat.post({ channelId: dm.id, author: ana, text: 'just us', attachments: [secret.id] })
    const denied = await h.call('chat.attachment_text', { attachment: secret.id })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.output)).not.toContain('secret"')
    await h.chat.addMember(dm.id, { kind: 'employee', id: h.employee.id })
    expect((await h.out('chat.attachment_text', { attachment: secret.id })).text).toBe('secret')
    const pending = await h.attachments.upload({ bytes: new TextEncoder().encode('p'), name: 'p.txt', by: ana })
    expect((await h.call('chat.attachment_text', { attachment: pending.id })).isError).toBe(true)
    expect((await h.call('chat.attachment_text', { attachment: 'att_nope' })).isError).toBe(true)
  })

  it('refuses images and binary files', async () => {
    const h = await stack()
    const ana = { kind: 'contact' as const, id: h.ana.id }
    const ch = await h.chat.createChannel({ name: 'general', createdBy: ana })
    const img = await h.attachments.upload({ bytes: solidPng(2, 2, [0, 0, 0, 255]), name: 'a.png', by: ana })
    const bin = await h.attachments.upload({ bytes: new Uint8Array([0, 1, 2, 3]), name: 'a.bin', by: ana })
    await h.chat.post({ channelId: ch.id, author: ana, text: 'x', attachments: [img.id, bin.id] })
    expect(JSON.stringify((await h.call('chat.attachment_text', { attachment: img.id })).output)).toContain('image.view')
    expect(JSON.stringify((await h.call('chat.attachment_text', { attachment: bin.id })).output)).toContain('binary')
  })
})

describe('the duplicate guard', () => {
  it('does not post the same text twice in a thread within 2 minutes, and says so', async () => {
    const h = await stack()
    const ana = { kind: 'contact' as const, id: h.ana.id }
    const ch = await h.chat.createChannel({ name: 'general', createdBy: ana })
    const root = await h.chat.post({ channelId: ch.id, author: ana, text: 'script please' })
    const first = await h.out('chat.reply', { threadId: root.id, text: 'Here it is:\n```sh\necho hi\n```' })
    const again = await h.out('chat.reply', { threadId: root.id, text: 'Here it is:\n```sh\necho hi\n```  ' })
    expect(again).toMatchObject({ duplicate: true, messageId: first.messageId, threadId: root.id })
    expect(again.note).toMatch(/not posted again/)
    // Replying to a reply is the same thread.
    expect((await h.out('chat.reply', { threadId: first.messageId, text: 'Here it is:\n```sh\necho hi\n```' })).duplicate).toBe(
      true,
    )
    expect(await h.chat.thread(root.id)).toHaveLength(2)
    // Different text, or later than the window: posted.
    expect((await h.out('chat.reply', { threadId: root.id, text: 'Done.' })).duplicate).toBeUndefined()
    h.clock.advance(DUPLICATE_WINDOW_MS + 1)
    expect((await h.out('chat.reply', { threadId: root.id, text: 'Here it is:\n```sh\necho hi\n```' })).duplicate).toBeUndefined()
    expect(await h.chat.thread(root.id)).toHaveLength(4)
  })

  it('applies to top-level posts, counts attachments, and only for the same session', async () => {
    const h = await stack()
    const ana = { kind: 'contact' as const, id: h.ana.id }
    await h.chat.createChannel({ name: 'general', createdBy: ana })
    await h.files.write(h.employee.id, '/a.sh', 'echo a')
    const one = await h.out('chat.post', { channel: 'general', text: 'status' })
    expect((await h.out('chat.post', { channel: 'general', text: 'status' })).duplicate).toBe(true)
    // The same text with a file is a different message; the same text and file again is a repeat.
    const withFile = await h.out('chat.post', { channel: 'general', text: 'status', attachments: [{ path: '/work/files/a.sh' }] })
    expect(withFile.duplicate).toBeUndefined()
    const repeat = await h.out('chat.post', { channel: 'general', text: 'status', attachments: [{ path: '/a.sh' }] })
    expect(repeat).toMatchObject({ duplicate: true, messageId: withFile.messageId })
    // Another session posting the same text is not a repeat.
    const other = await h.newSession('Other')
    const otherRun = await h.startRun(other.id)
    const byOther = await h.out('chat.post', { channel: 'general', text: 'status' }, h.ctxFor(other.id, otherRun.id))
    expect(byOther.duplicate).toBeUndefined()
    expect(byOther.messageId).not.toBe(one.messageId)
  })
})
