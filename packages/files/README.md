# @mp/files

Each employee's own filesystem, with sharing. The files live in a `FileStorage` (a directory on the
files volume); the database keeps only the sharing grants.

## Why files aren't in the database

Employee files are working files that tools and code open directly: a CSV pandas reads, a chart
matplotlib writes, a file a sandbox mounts. So they are plain files in a directory,
`<FILES_DIR>/<employeeId>/<path>`, and listing, sizes and modification times come from the directory.
The grants (who may read or write which path) are permissions, and stay records like every other
permission. There is no content history yet; making each employee's directory a git repository could
add it later.

## API

`createFiles({ records, storage?, bus?, contactOf? })` registers `fs_share` (`fsh_`) and returns a
`FilesService`:

- `list(employeeId, dir)`: own files and directories; at `/` also `shared` when something is shared with you (an own
  top-level directory called `shared` is hidden); `/shared` lists the owners sharing with you; `/shared/<ownerEmployeeId>/...`
  lists what they share (and the directories on the way down to a deeper share).
- `read` (`content` as UTF-8 text, or base64 for binary content), `write(employeeId, path, content, { encoding, mime,
  expectedVersion })`, `move` (files or directories, within one filesystem, `overwrite`), `delete` (`recursive` for
  directories). A file's `version` is its modification time in ms; `expectedVersion` makes a write compare-and-swap.
- `share(ownerEmployeeId, path, withContactId, 'read' | 'write')` (a file or a directory prefix; sharing again changes the
  permission), `unshare`, `sharedWith(contactId)`, `sharesOf(ownerEmployeeId)`, `isDangling(share)` (its path is gone:
  ignored in listings and sandbox mounts until it's back). Moving or deleting a path moves or removes its grants.
- `contactOf(employeeId)`, `notifyChanged(change)` (for changes made outside the service, e.g. by code in a sandbox),
  `storage` (the `FileStorage`).
- `forEmployee(employeeId)` and `forContact(contactId)` (a person: only `/shared` paths) return the same operations bound to a reader.
- Every write, move and delete publishes `FILE_CHANGED` (`file.changed`): `{ ownerEmployeeId, op, path, from?, actor? }`.
- Path helpers: `normalizePath` (absolute POSIX, rejects `..`, backslashes, control characters), `isWithin`, `ancestors`, ...
- **One path convention:** `employeePath(p)` maps how code.run names files to the fs tools' form: `/work/files/<p>`, `/<p>`
  and `<p>` are the same file (`/<p>`), and `/work/shared/<owner>/<p>` is `/shared/<owner>/<p>` (`SANDBOX_FILES_DIR`,
  `SANDBOX_SHARED_DIR`). The service resolves every path through it (`read`, `write`, `list`, `move`, `delete`, `share`,
  `unshare`), so every tool built on it takes all spellings; escapes are refused as by `normalizePath`. `sandboxPath(p)`
  is the other way (`/a.txt` → `/work/files/a.txt`).
- `encodeContent(bytes)` / `decodeContent(content, encoding)`.

Access under `/shared` is checked against the reader's contact (`contactOf(employeeId)`, defaulting to the `employee`
record's `contactId`): reading needs a covering share, writing, moving and deleting need a `write` share, otherwise
`DeniedError`. Unshared and missing files look the same (`DeniedError`). Files and directories can't collide.

### Storage

`FileStorage` is the port: `read`, `stat`, `write` (atomic, creates parents, the new modification time is always later
than the replaced file's), `list`, `walk`, `delete`, `move`, and optional `localPath(owner)` for storage on a local disk
(for mounting into containers). Paths are an owner's absolute paths; owners are single path segments.

- `memoryStorage()`: in memory, for tests.
- `directoryStorage({ root })`: `<root>/<owner>/<path>` on disk. `..` is refused and symbolic links are never followed:
  a path through a link is `DeniedError`, links inside the tree are neither listed nor read, writing over one replaces
  the link. Writes go to a `.mp-tmp-*` file in the same directory (never listed) and are renamed into place. Empty
  directories left by deletes and moves are removed.
- `fileStorageContract(name, make)` from `@mp/files/contract`: the suite every implementation passes.

### Images

`src/images.ts`, no dependencies (`node:zlib` only):

- `sniffImage(bytes)` → `{ mime, width?, height? }` for PNG, JPEG, GIF and WebP (VP8, VP8L, VP8X), from magic bytes and
  headers; null for anything else (SVG and HTML included). `IMAGE_MIMES`.
- `prepareImage(bytes, { maxSide })`: PNGs over `maxSide` are decoded (8-bit grey, RGB, palette, grey+alpha, RGBA; not
  interlaced), box-filtered down and re-encoded, deterministically (same input, same bytes); other types and PNGs it can't
  decode pass through unchanged.
- `decodePng`, `encodePng`, `resizeRgba`, `solidPng(w, h, rgba)` (for tests), `sha256Hex`.

### File types

`src/sniff.ts`, for chat attachments and downloads:

- `sniffFile(bytes, name?)` → `{ mime, kind: 'image' | 'file', text, width?, height? }`: images by `sniffImage`; PDF, zip
  (and docx/xlsx/pptx by extension), gzip, 7z and tar by magic bytes; valid UTF-8 without NUL bytes is text, typed by the
  extension (`.sh`, `.py`, `.ts`, `.js`, `.md`, `.json`, `.yaml`, `.csv`, `.html`, `.svg`, …) or a `#!` line, else
  `text/plain`; anything else `application/octet-stream`. Never from a claimed type.
- `isImageMime`, `isTextMime`, `downloadMime(mime)` (`application/octet-stream` for what a browser could run or render:
  HTML, SVG, XML, JavaScript, CSS, PDF), `extensionFor(mime)`, `TEXT_PREVIEW_MAX_BYTES` (256 KB).

### Migration

`migrateFileRecords({ records: store.records, storage, logger? })` moves deployments from when files were records
(`file`, `fil_`, with `content`): each record's content is written to storage, then the record is deleted. It is
idempotent and safe to interrupt (a record goes only once its content is in storage; a storage file that differs is
newer and kept). The server runs it at every start.

## Tests

`test/storage.test.ts` (the contract against both storages; links out of the root, an owner directory that is a link,
temporary files, cleanup), `test/files.test.ts` (the service on both storages: own files, base64, compare-and-swap,
files written by code, change events, moves, deletes, sharing and permissions, grants following moves and deletes,
dangling grants, people, `/work/files` and `/work/shared` paths), `test/migrate.test.ts` (the migration, interrupted
runs, newer files, broken records), `test/paths.test.ts` (including `employeePath` and its escapes) and
`test/sniff.test.ts`.

## Replacing it

Another `FileStorage` (an object store, say) passing `fileStorageContract`; the service stays.
