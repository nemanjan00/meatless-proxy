# @mp/git-cli

git CLI adapter (L2) for `@mp/git`. Runs `git` with `execFile` (no shell).

## API

`gitCliCache({ root, git = 'git', env?, logger?, clock?, timeoutMs?, localReposDir? })` returns a `GitCache`. Also
`GitError`. With `localReposDir`, a `local:<slug>` url is fetched from and pushed to `<localReposDir>/<slug>.git` by
path (no auth; a missing repository is a `NotFoundError`); without it such urls are refused.

- Layout like Go's module cache: `mirrorPath(url) = <root>/<mirrorKey(url)>`, one bare repository per remote, created
  atomically (in a temp dir, then renamed).
- The cache repo tracks the remote as `refs/remotes/origin/*` (plus tags), not as a literal `clone --mirror`: with a
  mirror refspec, `git remote update --prune` deletes every local session branch that isn't on the remote yet, including
  branches checked out in worktrees. Session branches are local `refs/heads/*` that fetch never touches.
- `fetch`: `git remote update --prune`.
- `createWorktree`: `git worktree add` from the cache repo, `-b <newBranch>` or `--detach`. `ref` resolves as a local
  branch, then `origin/<ref>`, then any rev; default is the remote's HEAD.
- `removeWorktree`: `git worktree remove --force` + `git worktree prune`; idempotent, also after a crash.
- `commitAll`: `add -A` + `commit` with author and committer from the options (env + `-c user.*`, never global config),
  the clock's time, and trailers appended as `Key: value` lines. Returns null when there is nothing to commit.
- `push`: `assertPushAllowed` first, then pushes `refs/heads/<b>` to the cache repo's `remote.origin.url` and updates
  `refs/remotes/origin/<b>` in the cache. Non-fast-forward -> `ConflictError`. Never forces.
- `diff(path, base?)`: against HEAD, or against the merge base with `base`; includes new and deleted files (staged into a
  throwaway index, the real one is untouched). `log`, `status` (porcelain, untracked files included).
- Auth: with a `GitAuth`, the key (and `knownHosts`) are written to files with mode 0600 in a fresh private temp dir,
  and that one operation runs with `GIT_SSH_COMMAND='ssh -i <key> -o IdentitiesOnly=yes -o UserKnownHostsFile=<file or
  /dev/null> -o StrictHostKeyChecking=<accept-new|yes> -o BatchMode=yes'`. The dir is removed afterwards, also on
  error. Keys never appear in logs or errors (only the temp path is in the command).
- Hooks are disabled (`core.hooksPath=/dev/null`), signing off, `ext::` transport blocked, `GIT_TERMINAL_PROMPT=0`.
  Credentials in URLs are masked in error messages.
- Every operation on one cache repo and its worktrees is serialised in-process.

`gitCliLocalRepos({ root, git?, env?, logger?, clock?, timeoutMs? })` returns a `LocalRepos` (docs/spec.md#local-projects):

- `create`: `init --bare --initial-branch=main` in a temp dir, hooks off, `receive.denyNonFastForwards` and
  `receive.denyDeletes`, an empty tree and one commit by the given author, then renamed into place (atomic; a taken
  slug is a `ConflictError`).
- `merge`: a fast-forward when the default branch is an ancestor; else `git merge-tree --write-tree` (git 2.38+) in
  the bare repository, `commit-tree` with both parents, by the person. Conflicts (exit 1) are a `ConflictError` with
  `details.files` and change nothing. The default branch moves with `update-ref <new> <old>`, a compare-and-swap.
- `compare` (log, `--name-status`, the diff against the merge base, cut at 400 KB), `branches` (`for-each-ref`, ahead
  and behind with `rev-list --left-right --count`), `tree`/`readFile` (`ls-tree` and `cat-file` on `<sha>:<path>`,
  paths normalised and refused outside the repository), `deleteBranch` (never the default branch).
- `pushAll`: pushes `refs/heads/*` and `refs/tags/*` to a remote with the given `GitAuth`; refused access is a
  `DeniedError`, a remote with other history a `ConflictError`.
- Every write to one repository runs one at a time; a bad slug is refused before anything touches disk.

`src/exec.ts` holds the shared git runner (`gitRunner`, `withAuth`, `GitError`, `BASE_CONFIG`).

## Tests

`test/local.test.ts` covers local repositories: slugs and path escapes, create, an employee's checkout and push (and
protected branches refused), compare, fast-forward, merge commit, conflicts, concurrent merges, delete, browsing, and
attaching a remote (an empty one, one with other history, refused credentials through a fake `ssh`).
`test/git-cli.test.ts` uses real git against local `file://` repositories in a temp dir, with
`GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`. `test/ssh.test.ts` puts a fake `ssh` first on the PATH that
records its arguments and the key file (mode, content, dir mode) and runs the remote command locally, so `ssh://`
remotes work against local repositories: it checks the key reaches ensureMirror, fetch and push, known hosts and strict
checking, the cleanup (also after a failure), and that nothing is set without auth.

## Replacing it

Implement `GitCache` another way (e.g. isomorphic-git, a remote cache service) and switch the composition root.
