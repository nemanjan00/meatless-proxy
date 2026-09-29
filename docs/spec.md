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
  a task assigned to it. How it receives those events is still open (see below).

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

- Where does the cache live and how big can it get: one host, or shared between
  several harness hosts?
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

Open questions:

- In a loop, how do children report back to the parent: does the parent wait
  for all of them and get their results, or do results arrive as they finish?
- What is a "point" in a session's history when forking: a message, a tool
  call, or any turn?
- Can two sessions in a tree be merged back together?
- Are forks limited, e.g. by depth or by how many children one loop can have?

## Unique features

_None specified yet._
