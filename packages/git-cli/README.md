# @mp/git-cli

git CLI adapter (L2) for `@mp/git`. Runs `git` with `execFile` (no shell).

## API

`gitCliCache({ root, git = 'git', env?, logger?, clock?, timeoutMs? })` returns a `GitCache`. Also `GitError`.

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

## Tests

`test/git-cli.test.ts` uses real git against local `file://` repositories in a temp dir, with
`GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`. `test/ssh.test.ts` puts a fake `ssh` first on the PATH that
records its arguments and the key file (mode, content, dir mode) and runs the remote command locally, so `ssh://`
remotes work against local repositories: it checks the key reaches ensureMirror, fetch and push, known hosts and strict
checking, the cleanup (also after a failure), and that nothing is set without auth.

## Replacing it

Implement `GitCache` another way (e.g. isomorphic-git, a remote cache service) and switch the composition root.
