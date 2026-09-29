# meatless-proxy spec

meatless-proxy is an AI harness: the runtime that hosts the AI employee defined
in [employee.md](employee.md). It connects the model to the company's people,
systems and tasks.

## Goals

1. **Reduce latency between AIs.** When one AI needs something that another
   AI (or the system behind it) can provide, the two talk directly. The request
   shouldn't wait on a person to carry it across.
2. **Remove humans from steps that don't need them.** People stay in the loop
   for decisions, approvals and judgment. They are removed from steps where all
   they do is relay, copy or reformat what an AI produced.
3. **Reduce round trips.** Fewer back-and-forth exchanges per task: gather the
   needed context up front, ask everything in one go, and resolve as much as
   possible without extra hops.

## A self-scripting engine

The harness is a **self-scripting engine**. The model doesn't just answer
inside one conversation: it scripts its own work using a set of primitives. It
creates, forks and loops sessions, waits for them or leaves them running, and
works with people, projects, code and memory.

Those primitives make up a **standard library** that covers what a person in
the [employee role](employee.md) needs, plus memory. Each feature below adds a
module to it:

| Module            | Section                                       |
|-------------------|-----------------------------------------------|
| chat, tasks       | [MCP](#mcp)                                   |
| contacts          | [Contacts](#contacts)                         |
| projects, docs    | [Projects](#projects)                         |
| links             | [Links](#links-between-contacts-and-projects) |
| repos, runtime    | [Project code and runtime](#project-code-and-runtime) |
| sessions          | [Sessions](#sessions)                         |
| triggers          | [Triggers](#triggers)                         |
| procedures        | [Procedures](#procedures)                     |
| memory            | [Memory](#memory)                             |

## Structure

This document is written incrementally. Common harness features come first,
and the features unique to meatless-proxy follow later.

## Common features

### MCP

The harness is an MCP (Model Context Protocol) client. It reaches outside
systems through MCP servers, not through integrations built into the harness.

It uses MCP for two kinds of systems:

- **Chat**: Slack, Telegram, Teams, email and the like. The harness reads and
  sends messages, follows threads and DMs, and looks up who is who.
- **Task systems**: Linear, Jira, GitLab/GitHub issues and the like. The harness
  creates, reads, updates, assigns and comments on tasks.

Requirements:

- Several MCP servers can be connected at the same time. Adding a new chat or
  task system means configuring a server, not changing harness code.
- The harness supports both directions. It acts on a system (MCP tool calls),
  and it also finds out when something happens there: a new message, a mention,
  a task assigned to it. Those events are routed by [triggers](#triggers). How
  they are delivered from the MCP server is still open (see below).

Open questions:

- How are inbound events delivered: MCP notifications, polling, or webhooks
  bridged into MCP?
- Which transports are supported: stdio, streamable HTTP, or both?
- How are credentials for each server stored and scoped?

### Contacts

The harness keeps a directory of who is who in the company. Each person is one
**contact**. The schema has a small fixed core, and deployments can extend it
without changing the harness.

Core fields:

| Field      | Type                  | Notes                                            |
|------------|-----------------------|--------------------------------------------------|
| `id`       | string                | stable, harness-assigned                         |
| `name`     | string                | display name                                     |
| `handles`  | list of {system, id}  | identity in each connected system, e.g. `{slack, U123}`, `{linear, 9f2…}` |
| `role`     | string, optional      | job title                                        |
| `team`     | string, optional      |                                                  |
| `manager`  | contact id, optional  |                                                  |

Extension:

- A deployment can declare extra fields (for example `expertise`, `timezone`,
  `working_hours`, `preferences`) with a name, a type and a description.
- Extra fields are stored and returned just like core fields, and the model
  sees them the same way.
- The core fields cannot be removed or redefined.

Behaviour:

- **Identity resolution.** An incoming message or task event is matched to a
  contact through `handles`. That way, the same person is recognised in chat and
  in the task system.
- The model can look up contacts: by id, by handle, by name, or by any field.
- A contact's projects, and the contact's role on each one, come from the
  [links between contacts and projects](#links-between-contacts-and-projects).

The [employee definition](employee.md#people) lists the fields the employee
role expects. Most of them are extensions, not core fields.

Open questions:

- Where do contacts come from: an HR system, a chat workspace directory, a
  manual file, or several of these merged?
- Can people edit their own contact, for example to set preferences?

### Projects

The harness keeps a record of the company's projects. Each project has two
parts:

- **structured data**, which follows an extendable schema like
  [contacts](#contacts) and lets code read the project directly
- **documentation**, a set of interlinked markdown files that people and the
  model can read

Core fields:

| Field         | Type                          | Notes                                  |
|---------------|-------------------------------|----------------------------------------|
| `id`          | string                        | stable, harness-assigned               |
| `name`        | string                        |                                        |
| `aliases`     | list of string, optional      | other names people use for it          |
| `description` | string                        | one paragraph                          |
| `status`      | string                        | e.g. active / maintenance / sunset     |
| `owner`       | contact id                    | the person accountable for the project; a view of the [links](#links-between-contacts-and-projects) |
| `members`     | list of {contact id, role}    | role on this project, e.g. `reviewer`; a view of the links |
| `repositories`| list of repository            | see [git repositories](#git-repositories) |
| `links`       | list of {system, ref}         | task boards, chat channels, other      |

Extension works the same way as for contacts: a deployment can declare extra
fields with a name, a type and a description, and the core fields can't be
removed or redefined.

#### Documentation

- Every project has its own set of markdown documents, for example an overview,
  runbooks, decisions and procedures.
- Documents can link to each other, to documents in other projects, to
  contacts, and to projects. These links can be followed by the model and by
  code, not just by people reading a rendered page.
- Links to contacts and projects use their ids, so they don't break when a name
  changes.

#### Behaviour

- The model can look up projects by id, name, alias or any field. From a
  project it can get the contacts linked to it, and it can find the projects
  linked to a given contact (e.g. "what does Ana own?").
- Following links in either direction is supported: which documents link to
  this one, and which documents mention this person.

Open questions:

- How is the structured data stored: frontmatter in the project's main markdown
  file, or a separate file next to the docs?
- What is the link syntax for contacts and projects, e.g. `[[contact:ana]]` or
  a normal markdown link with a special scheme?
- Can projects nest (sub-projects or components), or is the ownership of
  components expressed some other way?

### Links between contacts and projects

Contacts and projects are linked. A link is a first-class record, not just an
id copied into both sides:

| Field     | Type        | Notes                                                |
|-----------|-------------|------------------------------------------------------|
| `contact` | contact id  |                                                      |
| `project` | project id  |                                                      |
| `role`    | string      | e.g. `owner`, `member`, `reviewer`, `stakeholder`    |

- **Stored once, read from both sides.** The project's `owner` and `members`,
  and the list of a contact's projects, are both views of the same links. The
  two sides can never disagree.
- **Many-to-many.** A contact can be on many projects, and a project has many
  contacts. A contact can have more than one role on the same project.
- **Extendable.** Links take extra fields the same way contacts and projects do,
  for example `since`, `until` or `allocation`.
- **Queryable.** "Who owns X?", "What is Ana on?", "Who reviews for X?" and
  "Who to ask about X if the owner is away?" are all answered from these links.
- **Referential integrity.** A link can't point to a contact or project that
  doesn't exist. What happens to the links when either one is removed is still
  open (see below).

Open questions:

- When a contact leaves the company, are their links deleted, or kept and
  marked as past?
- Is the set of roles fixed, or can each deployment define its own?

### Project code and runtime

Beyond records and docs, the harness has access to each project's actual code
and can run it.

#### Git repositories

- A project links to one or more git repositories, each with a remote URL, a
  default branch, and an optional path within the repo (for monorepos).
- The harness keeps a **local cache** of every linked repository, so reading
  code doesn't need a network round trip and a fresh clone isn't needed for each
  task.
- For now the cache is **local to the harness host**. Like Go's module cache,
  its layout comes from the remote URL. Each repository is a bare mirror under
  `<cache root>/<host>/<path>`, for example
  `<cache root>/github.com/acme/billing`. The same remote therefore always maps
  to the same place, and different projects that link to one repo share it. The
  cache root is configurable and defaults to a directory in the harness's data
  directory.
- The cache is kept up to date by fetching: on a schedule, when a task starts,
  and when the task system or chat reports new changes (e.g. a push or a merged
  PR).
- Each task works in its **own checkout** (for example a git worktree taken
  from the cache), so concurrent tasks can't interfere with each other or with
  the cache.
- Access is scoped: the harness uses credentials that allow what the project
  needs (read by default, write only where tasks need it), and it follows the
  project's branch and review rules.

#### Docker orchestration

- A project can declare how it runs: which image to build or use, which
  services it needs (databases, queues), and the commands for build, test and
  run. By default this is read from files the repo already has, such as a
  `Dockerfile` or `compose.yaml`.
- The harness starts the project in containers to build it, run its tests,
  reproduce a bug, or check that a change works.
- Each task gets its **own isolated environment**, with its own containers,
  network and volumes, mounted on the task's checkout. It's torn down when the
  task ends.
- Resource limits (CPU, memory, time) apply per environment, and network access
  from the containers is restricted to what the project needs.
- Output from builds, tests and running services (logs, exit codes, artifacts)
  is captured and available to the model and in the task's
  [audit trail](employee.md#4-boundaries).

Open questions:

- How is the cache size limited, and when are unused mirrors removed?
- Sharing the cache between several harness hosts is left for later.
- How are secrets the project needs at runtime provided to its containers?
- Is Docker the only runtime, or should the orchestration layer also allow
  others (Podman, Kubernetes, remote runners)?
- How long can an environment stay up, for example for someone to look at a
  running preview?

### Sessions

A **session** is one line of work by the model: its conversation history, its
state, and what it is working on. Sessions are persistent, forkable, linked,
documented and templatable.

#### Properties

- **Persistent.** A session survives harness restarts and can be resumed at
  any time, with its full history and state.
- **Forkable.** Any session can be forked at any point in its history. The fork
  starts with everything the parent had up to that point, then goes its own
  way. The parent is not affected.
- **Trees.** Forks form a tree. Every session knows its parent and the point it
  was forked from, and can list its children. The whole tree can be walked from
  any session in it.
- **Loops (fan-out).** A session can split into *n* child sessions in one step,
  one per item in a list (for example, one per repository, per ticket, or per
  contact). Each child gets the parent's context plus its own item.
- **New sessions.** A session can also be created from nothing or from a
  template, with no parent.
- **Linked.** Sessions link to contacts and to projects, many-to-many in both
  directions, and to other sessions beyond the fork tree (e.g. `related`,
  `follows up`).
- **Documented.** Every session has structured metadata and a markdown
  document, following the same pattern as projects.
- **Templatable.** A session can be created from a template (see below), and
  an existing session can be saved as a template.
- **Ephemeral or committed runs.** Any session can do a piece of work as an
  **ephemeral** run, which is discarded afterwards and leaves the session as it
  was. Or it can **commit** the run to itself, so the run becomes part of the
  session's history (see [Runs](#runs-ephemeral-or-committed)).

#### Metadata

Core fields, extendable the same way as contacts and projects:

| Field         | Type                  | Notes                                     |
|---------------|-----------------------|-------------------------------------------|
| `id`          | string                | stable, harness-assigned                  |
| `title`       | string                |                                           |
| `status`      | string                | e.g. active / waiting / done / abandoned  |
| `parent`      | {session id, point}, optional | where it was forked from          |
| `template`    | template id, optional | the template it was created from          |
| `created`     | timestamp             |                                           |
| `updated`     | timestamp             |                                           |

The session's markdown document holds what a person or another session needs
to know about it: its purpose, a summary of what was done, decisions, and
anything left open. The session keeps it up to date as it works.

#### Links

Session links use the same kind of link record as
[contacts and projects](#links-between-contacts-and-projects), with a role:

- **Session ↔ contact**, many-to-many, e.g. `requested by`, `waiting on`,
  `reviewer`.
- **Session ↔ project**, many-to-many, e.g. `works on`, `affects`.
- **Session ↔ session**, e.g. `related`, `follows up`, `blocks`. Fork tree
  edges are recorded separately, in `parent`.

These links answer questions like "which sessions are working on project X?",
"what's in flight for Ana?" and "what is this session waiting on?".

#### Templates

A template describes how to start a session:

- the initial instructions and context
- parameters that are filled in when a session is created (e.g. a project id or
  a ticket), including the item in a loop
- default links, metadata and tools

Templates are versioned, and each session records which template version it
came from.

#### Tooling

The model has tools for working with sessions:

| Tool           | What it does                                                  |
|----------------|---------------------------------------------------------------|
| create         | start a new session, blank or from a template                 |
| fork           | fork a session at a given point                               |
| loop           | split a session into *n* children, one per item               |
| look up        | find sessions by id, title, status, any metadata field, link, or text in their document |
| tree           | get a session's parent, children, or whole tree               |
| save metadata  | set or update metadata fields and the session's document      |
| link / unlink  | add or remove links to contacts, projects and other sessions  |
| save template  | turn a session into a template                                |
| wait           | block until the given children (one, some or all) finish, and return their results |
| commit         | keep the current run: add it to the session's history          |

#### Runs: ephemeral or committed

A **run** is one piece of work done in a session, for example handling one
[trigger](#triggers) or one item in a loop. The run starts from the session's
current history, and the result is one of two things:

- **Ephemeral.** When the run ends, its messages and tool calls are dropped
  from the session. Its effects on the outside world stay (a reply sent, a
  ticket updated), and so do the run's log and usage. The session goes into its
  next run as clean as before, which keeps its context small.
- **Committed.** The run calls `commit` to keep itself: its history becomes part
  of the session, and later runs build on it. This is how a long-lived context
  accumulates what it has learned or decided.

Every session can do both. Sessions created by a loop are usually ephemeral
runs of one context, and a context commits a run when there is something worth
carrying forward.

#### Waiting

After a fork or a loop, **the parent decides whether to wait**:

- It can call `wait` and block until the children it names have finished. It
  then gets their results.
- Or it can carry on without waiting. The children keep running, and the parent
  can check on them later with `tree` or `look up`, or call `wait` whenever it
  needs their results.

Each child's result is its final output together with its session document.

Open questions:

- What is a "point" in a session's history when forking: a message, a tool
  call, or any turn?
- Can two sessions in a tree be merged back together?
- Are forks limited, e.g. by depth or by how many children one loop can have?
- Does `wait` take a timeout, and can the parent cancel children it no longer
  needs?
- Is a run ephemeral by default and committed only on `commit`, or can a
  trigger or template set the default?
- Can a run commit only part of itself, for example a summary instead of the
  full history?

### Triggers

External events don't each start a new session. A **trigger** routes an event
into a specific, long-lived **context** (a session) that is assigned to that
kind of event. The context decides what to do with it.

Example: a task system's MCP server sends a notification that a new task was
assigned. The trigger for "new task" is assigned to a context that knows how
to take tasks in. That context runs, reads the task, and then orchestrates:
it forks or loops out other sessions to do the work, waits for them or not,
and commits to itself only what it needs to remember.

- **Sources.** An event can come from an MCP notification (new message,
  mention, new or changed task), a schedule, a git push, or the web UI.
- **Assignment.** Each trigger names the event it matches (source, type, and
  filters such as project, channel or contact) and the context it runs in. One
  context can handle many triggers.
- **Handling.** Each event starts one [run](#runs-ephemeral-or-committed) in the
  assigned context. The event is passed in as the run's input, and the run is
  ephemeral unless it commits.
- **Orchestration.** From that run, the context can use the whole session
  library: create, fork and loop sessions, route work to other contexts, and
  wait or not.
- **Traceability.** Every run records the event that started it, so the web UI
  can show a chain from event to context to child sessions.

#### Subscriptions

Triggers route *new* things, like a new task, to the context assigned to them.
Once a session is working on an existing thing, it **subscribes** to that
thing's notifications directly. Its events then skip the routing and go
straight to the session, which keeps going.

Example: a session is working on ticket PAY-123. It subscribes to PAY-123 and
to its PR. When someone comments on the ticket, or CI fails on the PR, the
event is delivered to that session. The intake context doesn't see it again
and doesn't have to work out who handles it, the way a person would have to
forward it.

- **Subscribe to specific things:** a task, a chat thread, a PR, a repo branch,
  a running environment, or another session.
- **Delivery.** A subscribed event starts a run in the subscribed session (or
  wakes it if it's waiting). The run continues from the session's history and
  is committed by default, because it continues the same piece of work.
- **Precedence.** When a subscription matches an event, it takes that event
  instead of the general triggers, so the work isn't routed twice.
- **Lifetime.** A subscription ends when the session unsubscribes, when the
  session ends, or when the thing itself is closed (the ticket resolved, the PR
  merged). Subscriptions are handed on when a session forks or passes the work
  to another session.
- **Any session can subscribe.** It's part of the session library, like fork
  and loop.

| Tool         | What it does                                               |
|--------------|------------------------------------------------------------|
| subscribe    | deliver events for a given thing directly to this session  |
| unsubscribe  | stop receiving them                                        |
| subscriptions | list what this session is subscribed to                   |

Open questions:

- What happens when events arrive faster than a context can handle them: queue
  them, run them in parallel, or batch them into one run?
- Besides subscriptions, can a context create or change general triggers
  itself?
- Can several sessions subscribe to the same thing, and if so, which one handles
  each event?

### Procedures

The employee knows the company's [procedures](employee.md#procedures). In the
harness, each procedure is a record and also a context that knows how to carry
it out.

#### Procedure records

Same pattern as the other modules: structured metadata plus a markdown document,
with an extendable schema, linked to contacts and projects.

| Field       | Type                      | Notes                                        |
|-------------|---------------------------|----------------------------------------------|
| `id`        | string                    | stable, harness-assigned                     |
| `name`      | string                    | e.g. "production deploy", "access request"   |
| `applies`   | string                    | when it applies, in plain words              |
| `owner`     | contact id                | who to ask when it's unclear or out of date  |
| `approvals` | list of contact / role    | who has to say yes                           |
| `context`   | session id                | the procedure context, see below             |

The steps and details are in the markdown document. Links connect a procedure
to the projects it applies to and to the contacts that take part in it.

#### Procedure contexts

Every procedure has a **procedure context**: a session that has read the
procedure, its linked docs and its history, and is ready to run it.

- **Routing to forks.** When a piece of work needs a procedure, it's routed to a
  **fork** of the procedure context. That covers a trigger ("new access
  request"), a subscribed event, or a step inside another session ("this change
  needs a deploy"). Each instance of the procedure is its own fork.
- **Why fork.** Every fork starts already knowing the procedure, so it doesn't
  need to re-read documents or ask who to involve. This removes round trips.
  Forks share the same starting history, so the model provider's prompt cache
  can be reused, which cuts latency and cost.
- **Isolation.** Forks don't affect the procedure context or each other. Each
  fork links to the work it serves and subscribes to what it needs.
- **Improving the procedure.** The procedure context changes only through
  committed runs: when the procedure document changes, or when a fork finds
  something that should apply to every future run (e.g. "the approver changed").
  Such changes go through the procedure's owner, per the
  [employee rules](employee.md#procedures).
- **Routing without a person.** Since the employee knows which procedure applies,
  work is routed straight to the right procedure fork. Nobody has to decide
  "who handles this".

| Tool            | What it does                                                   |
|-----------------|----------------------------------------------------------------|
| find procedure  | find the procedures that apply to a piece of work               |
| run procedure   | fork the procedure context for this work and start the fork     |

Open questions:

- When a procedure document is edited, is the procedure context rebuilt from
  scratch or updated with a committed run?
- Should forks that are still running continue with the old version of the
  procedure, or be told about the change?

### Memory

The harness gives the model memory that lasts beyond a single session: things
it learned, was told, or decided, which it can recall later in any session.

#### Memory entries

Each memory is one entry. It follows the same pattern as the other modules:
structured metadata plus markdown content, with an extendable schema.

| Field      | Type                   | Notes                                           |
|------------|------------------------|-------------------------------------------------|
| `id`       | string                 | stable, harness-assigned                        |
| `summary`  | string                 | one line, used to decide whether it's relevant  |
| `kind`     | string                 | e.g. fact, preference, feedback, decision       |
| `source`   | {session id, contact id}, optional | where it came from and who said it  |
| `created`  | timestamp              |                                                 |
| `verified` | timestamp, optional    | when it was last confirmed to still be true     |

The content is markdown, and it can link to contacts, projects, sessions and
other memories like any other document.

#### Links

Memories link to contacts, projects and sessions many-to-many, with the same
link record as elsewhere. That way, "what do I know about Ana?" or "what have I
learned about project X?" are link queries, and linked memories can be pulled
in automatically when a session starts working on a project or with a person.

#### Behaviour

- **One fact per entry.** An existing entry is updated when it covers the same
  fact, instead of adding a duplicate.
- **Recall.** Memories are found by summary, content, metadata or links. The
  harness can load relevant memories into a session up front, which saves a
  round trip.
- **Staleness.** A memory is a claim about the past. Before acting on one that
  names a file, a person's role or a procedure, the model checks it against the
  current source of truth. It updates or deletes the memory if it's wrong.
- **Scope and visibility.** A memory can be scoped to a contact, a project, or
  the whole company. It is only recalled in sessions allowed to see it, under
  the same confidentiality rules as the [employee](employee.md#4-boundaries).

#### Tooling

| Tool          | What it does                                               |
|---------------|------------------------------------------------------------|
| remember      | create or update a memory                                  |
| recall        | find memories by text, metadata or links                   |
| link / unlink | link a memory to contacts, projects, sessions or memories  |
| forget        | delete a memory                                            |

Open questions:

- Is recall based on keywords, embeddings, or both?
- Who can see and edit memories: can people review what the employee remembers
  about them, and correct it or have it deleted?
- When a session is forked, do memories written in one branch become visible to
  the others right away?
- Is there a size limit, or some process to compact and prune old memories?

### Web UI

The harness has a web UI where people can see what it is doing, what it has
done, and what it costs, and where they can explore and edit what it knows.

#### Activity

- **Now.** Live view of running sessions: what each one is working on, its
  latest messages and tool calls, and what it's waiting on (a child, a person,
  a container). Updates stream in without a page reload.
- **History.** Everything it has done, searchable and filterable by project,
  contact, status, template and time. Every session can be opened and read in
  full: messages, tool calls with their inputs and outputs, container logs, and
  git changes.
- **Session trees.** Forks and loops are shown as a tree. You can navigate from
  a session to its parent, its children, and linked sessions, and see at a
  glance which branches are running, waiting, done or failed.

#### Usage

- Token usage is recorded for every model call: input, output and cached
  tokens, and the model used.
- The UI shows usage per session, rolled up per session tree, per project, per
  contact (who requested the work), per template and over time. Cost is shown
  next to the token counts.
- Usage can be broken down to find what's expensive: which sessions, tools or
  steps used the most tokens.

#### Knowledge

- **Browse** contacts, projects, links, templates and memories, and follow the
  links between them, e.g. from a project to its people, sessions, memories and
  docs.
- **Read and edit docs.** The markdown documents of projects, sessions and
  memories can be read rendered and edited in place, with links to contacts,
  projects and sessions resolved and clickable.
- **Edit structured data.** Contacts, projects, links and memories can be
  edited through forms generated from their schema, including extension fields.
- **History of changes.** Every edit records who made it (a person or a
  session) and when, and can be reviewed and reverted.

Open questions:

- How do people sign in, and how does what they can see map to the
  [confidentiality rules](employee.md#4-boundaries)?
- Can people act on sessions from the UI (stop, fork, resume, reply), or is it
  view-only apart from docs and data?
- Where is edit history stored: git, the harness database, or both?

## Unique features

_None specified yet._
