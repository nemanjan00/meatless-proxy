# @mp/git

The git port (L1): a local cache of remotes, worktrees per session, commits and guarded pushes.

## API

- `GitCache`: `mirrorPath`, `ensureMirror`, `fetch`, `createWorktree`, `removeWorktree`, `commitAll`, `push`, `diff`, `log`, `status`.
- `mirrorKey(url)`: `https://github.com/acme/billing.git` -> `github.com/acme/billing` (also scp-style, `ssh://`, `file://`
  and plain paths under `local/`). Always a safe relative path: no `.`/`..` or empty segments; throws `ValidationError`
  for urls without a path.
- `assertPushAllowed(branch, policy)`: throws `DeniedError` for protected branches, branches not in `allow`, and invalid
  names (anything that could smuggle a refspec such as `mp/x:main`).
- `isValidBranchName(name)`.
- `fakeGitCache({ root? })`: in-memory implementation for other packages' tests. Records `calls` and `pushes`; simulate
  edits with `writeFile(path, file, content)`, upstream commits with `addRemoteCommit`; `remote(url)` exposes the
  upstream state. `push` enforces `assertPushAllowed` first and rejects non-fast-forwards.

## Tests

`test/git.test.ts`: mirrorKey (including traversal attempts), assertPushAllowed, and the fake.

## Replacing it

Implement `GitCache` in an adapter (see `@mp/git-cli`) and switch the composition root.
