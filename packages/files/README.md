# @mp/files

Each employee's own filesystem, stored as records, with sharing.

## API

`createFiles({ records, contactOf? })` registers `file` (`fil_`, key `<employeeId>:<path>`) and `fs_share` (`fsh_`) and returns:

- `list(employeeId, dir)`: own files and implicit directories; at `/` also `shared` when something is shared with you;
  `/shared` lists the owners sharing with you; `/shared/<ownerEmployeeId>/...` lists what they share (and the directories
  on the way down to a deeper share).
- `read`, `write(employeeId, path, content, { encoding, mime, expectedVersion })`, `move` (files or directories, within one
  filesystem, `overwrite`), `delete` (`recursive` for directories).
- `share(ownerEmployeeId, path, withContactId, 'read' | 'write')` (a file or a directory prefix; sharing again changes the
  permission), `unshare`, `sharedWith(contactId)`, `sharesOf(ownerEmployeeId)`.
- `forEmployee(employeeId)` and `forContact(contactId)` (a person: only `/shared` paths) return the same operations bound to a reader.
- Path helpers: `normalizePath` (absolute POSIX, rejects `..`, backslashes, control characters), `isWithin`, `ancestors`, ...

Access under `/shared` is checked against the reader's contact (`contactOf(employeeId)`, defaulting to the `employee`
record's `contactId`): reading needs a covering share, writing, moving and deleting need a `write` share, otherwise
`DeniedError`. Unshared and missing files look the same (`DeniedError`). Files and directories can't collide.

## Tests

`test/paths.test.ts` (normalization, traversal) and `test/files.test.ts` (own files, base64, moves, deletes, sharing and
permissions, people) with `memoryStore()`.

## Replacing it

Same `FilesService` interface; e.g. an object-store-backed variant for large binaries.
