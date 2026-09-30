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
  `deps.containers`, `code.*` needs `deps.sandbox` (`@mp/sandbox`),
  `projects.create_local` needs `deps.localProjects`.
  `deps.defaultTimezone()` gives `time.now` the company timezone (default UTC).
- `employeePrompt({ employee, contact, procedures?, skills?, memories?, now })`:
  the system prompt (identity, personality, the employee rules, how to use the
  stdlib, skill names and descriptions). Only `now` varies. It lists no
  projects: those come per run (below), so an assignment never changes it.
- Procedure contexts (`procedure-context.ts`): `createProcedureContexts(registry, deps)` → `ProcedureContexts`:
  `ensure(procedureId, employeeId, { toolset? })` (the context, built the first time: the employee prompt and the
  procedure's entry, `procedureContextText`, with names for its owner and approvers and each approval's step;
  default toolset the employee's router context's; concurrent callers get one), `rebuild(procedureId, { employeeId? })`
  (a fresh context built the same way, the procedure pointed at it, the old one marked done), `state(procedure)`
  (`ready`, `stale` or `missing`: contexts record `meta.procedureDigest` of the fields they were built from;
  older ones are compared with the procedure's revisions) and `start(procedureId, { work?, requesterId?, actor })`
  (Run now: a fork, the checklist, links, a queued `manual` run). `procedures.run` uses `ensure`, and refuses an
  archived procedure. The server keeps one as `services.procedureContexts`.
- "Your projects" (`projects-entry.ts`): `currentProjects(directory, employeeId)`
  (the projects its AI contact is linked to: name, id, roles owner first,
  repository URLs, owner or `you`, a one-line description), `projectsText(lines)`
  (deterministic; at most `MAX_LISTED_PROJECTS`, then a count; with none, to ask
  an admin), and `projectsEntry(deps, employeeId, sessionId?)`: the `system`
  entry for a new run (meta `projectsEntry`: the project ids), or null when the
  session's history already ends with the same list. `kit.startRun` adds it
  before the instruction of every new session, fork and review (not loop
  children, whose item stays last); the server adds it to router runs through
  the router's `runInput` hook.
- `DEFAULT_TOOLSET` (every stdlib tool except reviewer-only ones),
  `REVIEWER_TOOLSET`, `REVIEWER_ONLY_TOOLS`.
- `registerPolicies(hooks, deps, config?)` on the runner hooks: checklist gate,
  docs maintenance, session document (off by default), commit on stop, and the
  `git.push` tool gate. Returns an unregister function.
- `registerUsagePolicies(hooks, deps)`: budgets (`beforeModelCall` pauses when
  `usage.checkBudget` fails, with the run's requester so per-requester budgets
  apply) and usage recording (`afterModelCall`).
- `registerRouterPolicies(hooks, deps, config?)`: the AI-to-AI streak limit on
  `router.beforeDeliver` (sessions and contacts of kind `ai` or `agent`, i.e. local agents, count as AI).
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
| `sessions.*` | create, fork, loop, wait, follow_up, look_up, list, search, tree, get, save_metadata, link, unlink, save_template, commit, discard, rewind, offload, restore, compact, message, finish |
| `chat.*` | post, reply, read, search, create_channel, add_member, remove_member, archive, invite |
| `subscriptions.*` / `triggers.*` | subscribe, unsubscribe, list / list, create, update, disable |
| `directory.*` / `procedures.run` | find_contact, get_contact (with `learned` and `pendingSuggestions`), update_contact (role, team, manager and bio notes an employee learned, with a source: fills empty fields, suggests changes to set ones, refuses every other field and AI contacts; idempotent; not in router contexts), find_project, get_project, projects_of (without `contactId`: which projects you work on), find_procedure, get_procedure / run |
| `docs.*` / `memory.*` / `skills.*` / `fs.*` | list, read, search, write, write_chapter, backlinks / remember, recall, link, forget, verify / list, load / list, read, write, move, delete, share |
| `checklist.*` | show, add_item, check, request_review, record_review (reviewer sessions only) |
| `git.*` | checkout, status, diff, log, commit, push, read_file, write_file, list_files |
| `projects.create_local` | a project on a repository the harness hosts (docs/spec.md#local-projects), the employee a member (`deps.localProjects.create`, once per call). No tool merges |
| `env.*` | up (with `expose` ports for live previews, `desktop: true` for a virtual screen), exec, logs, preview, screenshot (the desktop as a PNG in the employee's files), down |
| `schedule.*` | create, list, update, cancel, run_now: scheduled tasks (docs/spec.md#scheduled-tasks). `create { instruction, at? \| in? \| every? \| cron?, timezone?, report?, session? }` reads times in the company time zone, creates the task's own session (employee prompt, full toolset, `requested_by`) and reports "here" by default (the conversation of the run, or the thread its session owns). `sessions.follow_up { in \| at, note }` leaves a note for the calling session. Routers get `schedule.list` only |
| `time.now` | the current time `{ iso, local, timezone, weekday, unix }`, in the company timezone or an IANA one asked for (an unknown one is an error naming an example) |
| `code.*` | run (`{ language: 'python' \| 'node', code, timeoutMs?, fresh? }`, stateful per session, files at `/work/files`), reset |

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
  `triggers.create`, `env.exec` and `code.run` are `non_idempotent`
  (`code.reset` is `idempotent`, `time.now` is `read`).
- **Network.** `env.up` takes its network from `networkFor({ network,
  projectAllow, fallback, direct })`: the employee's `network` setting (`none`,
  `project` by default, `{ allow }` intersected with a project's list, or
  `direct`), the project's list, else `config.defaultEgress`. `direct` is
  never narrowed by the project (its list only applies to the proxy); with
  `config.directNetwork: false` (`DOCKER_DIRECT_NETWORK=false`) it is no
  network, with a reason. `env.up { egress }` can only narrow: fewer hosts,
  or a direct network to proxied hosts, never to direct. The result's
  `network` is `{ via: 'proxy', allow, note }`, `{ via: 'direct', note:
  DIRECT_NOTE }` (`'unrestricted network, not logged'`, on
  `EnvSpec.direct: { network: directNetworkName(<handle>) }`, i.e.
  `<handle>-direct`, one per employee) or `{ via: 'none', reason }` saying
  why and what to ask an admin for. The session meta keeps what the
  environment started with (`meta.env.network`, `networkKey`, `projectId`):
  a running environment keeps it, and `env.up` says when the setting has
  changed since (`env.down`, then `env.up`, to use the new one).
- **Time.** The prompt says that every message carries when it arrived (the
  router stamps event headers) and to call `time.now` for the time now; the
  prompt itself holds no clock time beyond the session's start, so its cached
  prefix never changes. `time.now` and `code.*` are in router toolsets too.
- **Images** (`src/tools/images.ts`). `image.view { attachment? | path? }`
  returns `{ output, images: [ImageRef] }`: a reference with the sha256, never
  the bytes, which the runner loads for each request. Attachments only of
  messages in channels the employee sees (`employeeSeesChannel`: named
  channels, and DMs the employee, its contact or one of its sessions is in);
  files through `files.forEmployee`, so shares apply. It is tagged `vision`:
  without `deps.vision.enabled` the runner doesn't offer it, and it answers
  "this model can't see images". It reports the size the model gets
  (`shownAs` when a PNG is downscaled to `vision.maxSide`) and refuses images
  over `vision.maxBytes`, and file attachments (pointing at
  `chat.attachment_text`). `chat.post` and `chat.reply` take `attachments:
  [{ path }]` of any file (`uploadFiles`: read with the employee's
  permissions, uploaded to `deps.attachments` as the session, then posted);
  `chat.read` lists a message's attachments as `[image: <name> <w>x<h>,
  attachment <id>]` or `[file: <name> <size> <type>, attachment <id>]`.
  `chat.attachment_text { attachment, maxChars? }` reads a text attachment
  (same visibility as `image.view`; default 20,000 characters, at most
  100,000, from the first 256 KB). The prompt has one line on this, the same
  whether vision is on or not.
- **Paths.** Every file path goes through `files.forEmployee`, which takes
  `/work/files/<p>`, `/<p>` and `<p>` as one file (`employeePath` in
  `@mp/files`); the fs, image, chat and code tool descriptions say so in one
  sentence (`SANDBOX_PATHS_NOTE`).
- **Repeats.** `chat.post` and `chat.reply` don't post the same text (and
  attachment names) twice from one session in one thread (or at the top level
  of one channel) within `DUPLICATE_WINDOW_MS` (2 minutes): they return
  `{ duplicate: true, messageId, threadId, note }`.
  With `deps.describer` (an `ImageDescriber` from `@mp/chat`), images have
  saved descriptions: `image.view` makes one on the first look (per
  attachment, or per file's sha256) and returns it next to the image
  (`description`, `visibleText`, `descriptionNote`: information, not
  instructions), `describe_only: true` returns only that (no image; the tool
  recommends it first), a failed description is not an error. `chat.read`
  and `chat.search` show descriptions and visible text in the image lines,
  and `chat.read { describe_images: true }` describes the shown images that
  have none (at most 10, only in channels the employee sees).
- **Code.** `code.run` is `sandbox.run` for the calling session, with the
  session as the actor of file changes; a cell's error (or a timeout) is a
  tool error with the output. A session that ends (`done`, `abandoned`) loses
  its kernels (a `record.changed` subscription).
- **Forks** start "at the current point": the run's tip without the assistant
  message that asked for the fork. Runs are started with
  `cause: { type: 'fork' | 'loop', parentRunId }` and queued with
  `deps.enqueueRun`. Fork limits (depth, fan-out): the usage service's
  defaults overridden by limit records (`usage.limits.effective`), then
  `config.defaults`. Runs working at once aren't refused at fork time: the
  runner holds extra runs in the queue.
- **`sessions.wait`** answers right away when the runs are already done;
  otherwise it returns a `suspend` control signal. With `delivery: true`
  (instead of `runIds`) it suspends on a `delivery` wait: the next reply or
  event delivered to the session wakes the run (e.g. the answer to
  `mcp.slack.ask`), or the optional timeout. Only a continuing run can; an
  ephemeral one is told to end its turn instead.
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
  `deps.sshKeyFor(employeeId)` when it returns a key, else no auth. A local
  repository (`local:<slug>`) gets no auth; `git.push` to one says a person
  merges it in the web UI and subscribes the session to the branch
  (`localBranchSubject`, types `branch.*`: `branch.merged`, `branch.deleted`).
- **Environments**: `env.up` names the environment `envNameFor(<employee slug>,
  <session slug>)` (`[a-z0-9-]`, at most `MAX_ENV_NAME` = 40 characters, cut with
  a 6-hex hash suffix), so Docker names are `mp-<employee>-<session>-…` and stay
  under 63 characters; labels `mp.employee` and `mp.session`. Its egress
  allowlist is the `egress` of the checkout's project (else the session's first
  linked project); the tool's `egress` argument can only narrow it (every entry
  must be covered by the project list, `egressEntryCovered`). No project list
  means no network. `expose: [5173]` lists ports the app serves as live
  previews: they go to the runtime (`EnvSpec.expose`) and the session meta
  (`meta.env.expose`). `env.preview { port? }` returns the harness UI link to
  the session's Preview tab (`previewLink(sessionId, port)`,
  `/sessions/<id>?tab=preview&port=<port>`), never a token: the UI mints tokens
  for whoever signed in opens it. `desktop: true` asks the runtime for a desktop
  (`EnvSpec.desktop`, refused when `features().desktop` is off) and returns
  `desktop: { url: desktopLink(sessionId), display: ':99', note }`;
  `env.screenshot { path? }` saves the screen to `/screenshots/<env>-<time>.png`
  (or `path`) in the employee's files for `image.view`. With `config.filesDir`
  (the server's `FILES_DIR`), every environment mounts the employee's own files
  at `/files` (`FILES_MOUNT`). The session meta records what the Environments
  page shows (`image`, `profile`, `desktop`, `checkouts`, `services`), and the
  bus hears `env.changed` (up, down) and `env.exec.started` / `env.exec.finished`.
  `env.exec` keeps the head and tail of long output (`headAndTail`, 3000
  characters each for stdout) and then says to redirect it to a file (`cutNote`).
  File paths are resolved inside the worktree (no `..`, no `.git`, no symlink
  escapes with `nodeWorktreeFs`).
- **Scheduled tasks** (`src/schedules.ts`, `scheduleService(deps)`): the tools and the server's API share it. It
  resolves `at | in | every | cron` (`@mp/events` when.ts), creates a task with its session, a follow-up for a
  session, runs a task now (an event with a `now:<key>` dedupe key), cancels one (its session done, its
  subscriptions ended) and works out "here" for a report. Records are `deps.scheduledTasks` or, without it,
  `createScheduledTasks` over the same records. The answer-where-asked policy posts a task run's final answer to its
  chat report target (a thread, or a new thread in a channel) unless the run posted in chat or ended with `NO_REPLY`.
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
naming, egress allowlists and narrowing, and the SSH key passed to git;
`test/env-direct.test.ts` direct networks (not narrowed by the project, the
model can't ask for or widen to one, turned off by the deployment, running
environments keep what they started with).
`test/local-projects.test.ts` covers `projects.create_local` (membership, once per call, the toolsets), checkout and
push of a local repository without the SSH key and the branch subscription, protected branches refused, and that no
tool merges.
`test/schedule.test.ts` covers `schedule.*` and `sessions.follow_up`: one-offs, recurring in words and cron, the
company time zone, the task's session and requester, a retried call, bad input, "here" and other report targets,
list/update/pause/run now/cancel on the employee's own tasks only, and the router's toolset.
`test/projects-entry.test.ts` covers the "Your projects" text (none, one line per
project, `you`, role order, the limit), skipping a repeat, new sessions and forks
getting the current list with the system prompt byte-identical after an
assignment, and `directory.projects_of` defaulting to the caller.

## Replacing it

Write another package at L5 that registers tools on a `ToolRegistry` and
policies on `Hooks`, and switch the composition root to it. Tool names are
what sessions store in their toolsets, so keep them (or migrate toolsets).
