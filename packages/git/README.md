# @mp/git

The git port (L1): a local cache of remotes, worktrees per session, commits and guarded pushes.

## API

- `GitCache`: `mirrorPath`, `ensureMirror`, `fetch`, `createWorktree`, `removeWorktree`, `commitAll`, `push`, `diff`, `log`, `status`.
  The operations that talk to a remote take an optional per-call `GitAuth` (`{ sshPrivateKey?, knownHosts?,
  strictHostKeyChecking? }`): `ensureMirror(url, auth?)`, `fetch(url, auth?)`, `push(path, branch, policy, auth?)`, and
  `createWorktree(url, { …, auth? })` (used if it has to clone the mirror).
- `generateSshKeypair(comment)`: a new ed25519 keypair from node:crypto, `{ privateKeyOpenssh, publicKeyOpenssh }`. The
  private key is written by hand in OpenSSH's `openssh-key-v1` format (unencrypted), the public key is an
  `ssh-ed25519 AAAA… comment` line. `parseSshPublicKey` and `parseSshPrivateKey` read them back (the latter also gives
  the public key line, e.g. to show it again from the stored secret).
- `mirrorKey(url)`: `https://github.com/acme/billing.git` -> `github.com/acme/billing` (also scp-style, `ssh://`, `file://`
  and plain paths under `local/`). Always a safe relative path: no `.`/`..` or empty segments; throws `ValidationError`
  for urls without a path.
- `assertPushAllowed(branch, policy)`: throws `DeniedError` for protected branches, branches not in `allow`, and invalid
  names (anything that could smuggle a refspec such as `mp/x:main`).
- `isValidBranchName(name)`.
- `fakeGitCache({ root? })`: in-memory implementation for other packages' tests. Records `calls` and `pushes`; simulate
  edits with `writeFile(path, file, content)`, upstream commits with `addRemoteCommit`; `remote(url)` exposes the
  upstream state. `push` enforces `assertPushAllowed` first and rejects non-fast-forwards. `auths` records the auth
  each remote-facing call got (kept out of `calls`).

## Tests

`test/git.test.ts`: mirrorKey (including traversal attempts), assertPushAllowed, and the fake. `test/ssh.test.ts`: keypairs
parse back, have a fixed structure, sign and verify, and (when `ssh-keygen` is installed) `ssh-keygen -y` reproduces the
public key; the fake's auth recording. Keys are generated at test time; none are committed.

## Replacing it

Implement `GitCache` in an adapter (see `@mp/git-cli`) and switch the composition root.
