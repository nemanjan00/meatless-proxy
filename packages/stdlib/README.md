# @mp/stdlib

The model's standard library (layer L5): every built-in tool an employee can
call, the employee system prompt, and the built-in policy hooks. Tools are
thin handlers over the domain packages (sessions, chat, events, directory,
records/docs, memory, skills, files, checklists, usage) and the git and
container ports. Specs: [docs/spec.md](../../docs/spec.md) (every "Tool"
table), [docs/employee.md](../../docs/employee.md) (the rules in the prompt),
[docs/execution.md](../../docs/execution.md) (effect classes, waits, commits).

## API

- `registerStdlib(registry, deps: StdlibDeps): string[]` registers the tools
  and returns their names. `git.*` needs `deps.git`, `env.*` needs
  `deps.containers`.
- `employeePrompt({ employee, contact, projects?, procedures?, skills?, memories?, now })`:
  the system prompt (identity, personality, the employee rules, how to use the
  stdlib, skill names and descriptions). Only `now` varies.
- `DEFAULT_TOOLSET` (every stdlib tool except reviewer-only ones),
  `REVIEWER_TOOLSET`, `REVIEWER_ONLY_TOOLS`.
- `registerPolicies(hooks, deps, config?)` on the runner hooks: checklist gate,
  docs maintenance, session document (off by default), commit on stop, and the
  `git.push` tool gate. Returns an unregister function.
- `registerUsagePolicies(hooks, deps)`: budgets (`beforeModelCall` pauses when
  `usage.checkBudget` fails) and usage recording (`afterModelCall`).
- `registerRouterPolicies(hooks, deps, config?)`: the AI-to-AI streak limit on
  `router.beforeDeliver`.
- Helpers: `nodeWorktreeFs()`, `safeRelPath()`, `branchFor()`, `trailersFor()`,
  `runEntries()`, `committedCode()`, `wroteDocs()`, constants
  (`AUTO_COMMIT_MESSAGE`, `NO_DOCS_PHRASE`, `DOCS_PATH`, `AI_STREAK_TOPIC`,
  `REVIEWER_PROMPT`, `ONCE_KIND`, `RESERVED_META`, `Roles`).

`StdlibDeps` additions beyond the original contract: `worktreeFs?` (file
access inside worktrees, default the local disk), `config.defaults.maxConcurrentSessions`, and
`sshKeyFor?(employeeId)` (the employee's `SSH_PRIVATE_KEY` secret, passed as per-call git auth).
`TaskSystemConfig` documents the shape of `employee.taskSystem` for real forks.

## Tools

| Namespace | Tools |
|-----------|-------|
| `sessions.*` | create, fork, loop, wait, look_up, list, search, tree, get, save_metadata, link, unlink, save_template, commit, discard, rewind, offload, restore, compact, message, finish |
| `chat.*` | post, reply, read, search, create_channel, add_member, remove_member, archive, invite |
| `subscriptions.*` / `triggers.*` | subscribe, unsubscribe, list / list, create, update, disable |
| `directory.*` / `procedures.run` | find_contact, get_contact, find_project, get_project, projects_of, find_procedure, get_procedure / run |
| `docs.*` / `memory.*` / `skills.*` / `fs.*` | list, read, search, write, write_chapter, backlinks / remember, recall, link, forget, verify / list, load / list, read, write, move, delete, share |
| `checklist.*` | show, add_item, check, request_review, record_review (reviewer sessions only) |
| `git.*` | checkout, status, diff, log, commit, push, read_file, write_file, list_files |
| `env.*` | up, exec, logs, down |

Notes on behaviour:

- **Isolation.** Tools only touch the calling employee's sessions, triggers
  and memories; anything else is reported as not found.
- **Effect classes.** Reads are `read`. Writes to the harness's own state are
  `idempotent`: either naturally (set metadata, subscribe, write a chapter,
  commit a clean worktree) or through a per-call record (`stdlib_once`,
  keyed by the call's idempotency key) that makes a retried
  `sessions.create`/`fork`, `procedures.run`, `chat.post`/`reply`/`invite`/
  `create_channel`, `docs.write`, `checklist.add_item`/`request_review` return
  the first result. A crash between the effect and that record can repeat the
  effect once; that's accepted for harness-internal state. `sessions.loop`
  (which may create tasks in an outside task system), `sessions.save_template`,
  `triggers.create` and `env.exec` are `non_idempotent`.
- **Forks** start "at the current point": the run's tip without the assistant
  message that asked for the fork. Runs are started with
  `cause: { type: 'fork' | 'loop', parentRunId }` and queued with
  `deps.enqueueRun`. Fork limits: configured limits (`usage.limits.effective`)
  win, `config.defaults` fill the gaps.
- **`sessions.wait`** answers right away when the runs are already done;
  otherwise it returns a `suspend` control signal.
- **Real forks** (`sessions.loop` with `realTasks`) call the tool named in
  `employee.taskSystem` (`tool`, or `server` + `createTool`) once per item,
  then subscribe each child to its task. Without that config it's an error.
- **Evidence** for `checklist.check` can be tool call ids (what the model
  sees), event ids or entry ids; they're resolved to entries of the run.
- **Reviews** run in a new session (not a fork) with `REVIEWER_TOOLSET`; the
  reviewer is recorded in both sessions' meta (`reviews`, `reviewFor`), and
  only that session may call `checklist.record_review`.
- **Git**: worktrees at `<worktreesRoot>/<sessionId>/<mirrorKey>` on branch
  `<employee.git.branchPrefix || 'mp/<employee slug>'>/<session slug>`, recorded
  in `session.meta.worktrees`. Commits carry `Session:` and `Requested-by:`
  trailers. Pushes go through `assertPushAllowed` with `config.pushPolicy`.
  `git.checkout` (fetch, worktree) and `git.push` pass `{ sshPrivateKey }` from
  `deps.sshKeyFor(employeeId)` when it returns a key, else no auth.
- **Environments**: `env.up` names the environment `envNameFor(<employee slug>,
  <session slug>)` (`[a-z0-9-]`, at most `MAX_ENV_NAME` = 40 characters, cut with
  a 6-hex hash suffix), so Docker names are `mp-<employee>-<session>-…` and stay
  under 63 characters; labels `mp.employee` and `mp.session`. Its egress
  allowlist is the `egress` of the checkout's project (else the session's first
  linked project); the tool's `egress` argument can only narrow it (every entry
  must be covered by the project list, `egressEntryCovered`). No project list
  means no network.
  File paths are resolved inside the worktree (no `..`, no `.git`, no symlink
  escapes with `nodeWorktreeFs`).
- **Policies.** The docs policy looks at the run's own entries (after
  `run.data.base`): a successful `git.commit` with a sha and no docs write
  (`docs.write`, `docs.write_chapter`, `git.write_file` on `docs/…` or
  `*.md`) blocks unless the last assistant text says "no docs update needed:
  <reason>". The allow/deny list check stays in the runner (no duplicate);
  `beforeToolCall` only adds the protected-branch gate.

## Tests

`npx vitest run --project node packages/stdlib`: unit tests call every tool
through `registry.execute` on the in-memory stack (`test/helpers.ts`, with the
fake git cache and container runtime), policy tests drive the hooks directly,
and `test/e2e.test.ts` runs sessions with the real runner and router and a
scripted model (fork + wait, chat replies through subscriptions, procedures
with the checklist gate, git with a denied push and the docs policy, commit on
stop, memory, files, session messages). `test/env-egress.test.ts` covers env
naming, egress allowlists and narrowing, and the SSH key passed to git.

## Replacing it

Write another package at L5 that registers tools on a `ToolRegistry` and
policies on `Hooks`, and switch the composition root to it. Tool names are
what sessions store in their toolsets, so keep them (or migrate toolsets).
