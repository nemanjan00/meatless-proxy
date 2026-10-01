# @mp/git

The git port (L1): a local cache of remotes, worktrees per session, commits and guarded pushes.

## API

- `GitCache`: `mirrorPath`, `ensureMirror`, `fetch`, `lastFetch`, `createWorktree`, `removeWorktree`, `commitAll`, `push`,
  `diff`, `log`, `status`, `divergence`, `sync`, `abortMerge`.
  - `commitAll(path, { message, author, trailers?, paths? })`: everything, or only `paths` (normalised by
    `commitPaths`: relative, no `..`, nothing in `.git`; a path with no changes is a `ValidationError`). During a merge
    it finishes it (a commit with both parents); `paths` and files still holding conflict markers are refused then.
  - `sync(path, { base?, author, trailers?, auth? })`: fetch, then merge (never rebase) the worktree's own remote
    branch if it moved, then `base` (default: the remote's default branch). Returns `SyncResult` (`merged` steps with
    `from`, `sha`, `commits`, `mode`; `conflict` `{ from, sha, files }` when a merge stopped and was left in progress;
    `divergence`). Needs a clean worktree and no merge in progress. Never pushes or forces.
  - `status` returns `GitStatus`: `{ clean, files, merging, conflicts }`. `push` refuses (`ConflictError`) while a
    merge is in progress. `abortMerge` is `git merge --abort` (false when there was none).
  - `divergence(path, { base? })`: ahead/behind of HEAD against the base branch and the worktree's own remote branch,
    as of the last fetch (no network). `lastFetch(url)`: when this cache last fetched the mirror (epoch ms, or null).
  - `hasConflictMarkers(text)`: a `<<<<<<<` line and a `>>>>>>>` line.
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
- Local repositories (`src/local.ts`, docs/spec.md#local-projects): `LocalRepos`, the port for the harness's own bare
  repositories (`create` with an empty first commit on `main`, `branches` ahead/behind the default branch, `compare`,
  `merge` fast-forward or merge commit with conflicts as a `ConflictError` listing `details.files`, `deleteBranch`,
  `tree`, `readFile`, `pushAll` to attach a remote, `remove`). A person's API: employees reach a local repository only
  through `GitCache`. `local:<slug>` URLs: `isValidRepoSlug`/`assertRepoSlug` (`[a-z0-9-]`, at most 64, no leading or
  trailing dash), `localRepoUrl`, `localRepoSlug` (null for other URLs, throws for a bad slug), `isLocalRepoUrl`,
  `slugifyRepoName`; `mirrorKey('local:<slug>')` is `harness/<slug>`. `LOCAL_GIT_SYSTEM` and `localBranchSubject(slug,
  branch)` name the `branch.merged` / `branch.deleted` events. The adapter is `gitCliLocalRepos` in `@mp/git-cli`
  (tested there against real git); there is no in-memory fake.
- `fakeGitCache({ root?, now? })`: in-memory implementation for other packages' tests. Records `calls` and `pushes`; simulate
  edits with `writeFile(path, file, content)`, upstream commits with `addRemoteCommit`; `remote(url)` exposes the
  upstream state. `push` enforces `assertPushAllowed` first and rejects non-fast-forwards. `sync` merges like git
  does near enough: fast-forwards, merge commits (`secondParent`), and a conflict when both sides changed a file
  differently (the worktree's `dirty` gets the file with conflict markers, `merging` records the merge until a
  commit or `abortMerge`). `now` is the time `lastFetch` reports. `auths` records the auth
  each remote-facing call got (kept out of `calls`).

## Tests

`test/git.test.ts`: mirrorKey (including traversal attempts), assertPushAllowed, and the fake. `test/ssh.test.ts`: keypairs
parse back, have a fixed structure, sign and verify, and (when `ssh-keygen` is installed) `ssh-keygen -y` reproduces the
public key; the fake's auth recording. Keys are generated at test time; none are committed.

## Replacing it

Implement `GitCache` in an adapter (see `@mp/git-cli`) and switch the composition root.
