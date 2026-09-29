import { describe, expect, it } from 'vitest'
import { downloadMime, extensionFor, isImageMime, isTextMime, sniffFile, solidPng } from '../src/index.ts'

const enc = (t: string) => new TextEncoder().encode(t)

describe('sniffFile', () => {
  it('finds images by their bytes only', () => {
    expect(sniffFile(solidPng(3, 2, [0, 0, 0, 255]), 'x.txt')).toMatchObject({ kind: 'image', mime: 'image/png', width: 3 })
    expect(sniffFile(enc('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.png')).toMatchObject({ kind: 'file', text: true })
  })

  it('types text by extension, then by its #! line', () => {
    expect(sniffFile(enc('echo'), 'a.sh').mime).toBe('text/x-shellscript')
    expect(sniffFile(enc('x = 1'), 'a.py').mime).toBe('text/x-python')
    expect(sniffFile(enc('{}'), 'a.json').mime).toBe('application/json')
    expect(sniffFile(enc('a,b'), 'A.CSV').mime).toBe('text/csv')
    expect(sniffFile(enc('<html>'), 'a.html').mime).toBe('text/html')
    expect(sniffFile(enc('#!/bin/bash\necho'), 'run').mime).toBe('text/x-shellscript')
    expect(sniffFile(enc('#!/usr/bin/env node\n1'), 'run').mime).toBe('text/javascript')
    expect(sniffFile(enc('hello'), 'notes').mime).toBe('text/plain')
    expect(sniffFile(enc('hello'), 'notes.weird')).toEqual({ mime: 'text/plain', kind: 'file', text: true })
  })

  it('finds binary formats by magic bytes, and calls the rest octet-stream', () => {
    expect(sniffFile(enc('%PDF-1.4\n'), 'a.txt').mime).toBe('application/pdf')
    expect(sniffFile(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]), 'a.xlsx').mime).toContain('spreadsheetml')
    expect(sniffFile(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]), 'a.bin').mime).toBe('application/zip')
    expect(sniffFile(new Uint8Array([0x1f, 0x8b, 8, 0]), 'a').mime).toBe('application/gzip')
    // Invalid UTF-8 or NUL bytes: not text, whatever the name says.
    expect(sniffFile(new Uint8Array([0xff, 0xfe, 0x00]), 'a.txt')).toEqual({
      mime: 'application/octet-stream',
      kind: 'file',
      text: false,
    })
    expect(sniffFile(enc('a\u0000b'), 'a.txt').text).toBe(false)
  })
})

describe('mime helpers', () => {
  it('downloads active content as octet-stream', () => {
    for (const m of [
      'text/html',
      'image/svg+xml',
      'application/xml',
      'text/javascript',
      'application/pdf',
      'application/xhtml+xml',
    ])
      expect(downloadMime(m), m).toBe('application/octet-stream')
    expect(downloadMime('text/x-shellscript')).toBe('text/x-shellscript')
    expect(downloadMime('text/plain')).toBe('text/plain')
    expect(downloadMime('application/zip')).toBe('application/zip')
  })

  it('knows images, text and extensions', () => {
    expect(isImageMime('image/webp')).toBe(true)
    expect(isImageMime('image/svg+xml')).toBe(false)
    expect(isTextMime('application/json')).toBe(true)
    expect(isTextMime('application/zip')).toBe(false)
    expect(extensionFor('text/plain')).toBe('txt')
    expect(extensionFor('image/jpeg')).toBe('jpg')
    expect(extensionFor('application/octet-stream')).toBeUndefined()
  })
})
