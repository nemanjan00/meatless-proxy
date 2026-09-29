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

## Principles

### Database first

All harness state lives in a **database**, and the database is the source of
truth. That includes contacts, projects, procedures, links, docs, memories,
sessions and their history, runs, triggers, subscriptions, events and usage.
There are no loose files or per-process state that only one process knows
about.

- Every module in the [standard library](#a-self-scripting-engine) is a set of
  tables with a schema, and all modules are extendable in the same way.
- Links are rows, so links in both directions and many-to-many queries come
  for free.
- Sessions are rows too. Forking, looping, resuming, subscribing and committing
  are database operations, so a session can be picked up by any worker and
  survives restarts.
- The web UI, the model's tools and outside integrations all read and write the
  same database.
- Code is the exception: git repositories stay in git, with the
  [local cache](#git-repositories). The database stores the links to them.
- The job queue (BullMQ on Redis) isn't state. Its jobs only carry ids, and
  it can be rebuilt from the database ([execution model](execution.md#storage-and-processes)).

### No single operator

Most harnesses have one operator: one person at a terminal who gives the
instructions, reads the output and approves every step. meatless-proxy has no
single operator in the loop. Instead, it **talks to the whole company**:

- Anyone can reach it through the chat and task systems it's connected to, and
  it reaches out to anyone, according to [contacts](#contacts) and ownership.
- Instructions come from many people at once. Each piece of work is tied to the
  contacts who asked for it, own it, or need to approve it, through
  [links](#links-between-contacts-and-projects).
- Approvals go to the person the procedure or ownership says should give them,
  not to whoever started the harness.
- Work is started by [triggers](#triggers) and
  [subscriptions](#subscriptions), not by one person typing a prompt, and it
  keeps running while nobody is watching. The [web UI](#web-ui) is where people
  look in on it. It is not a control seat that someone has to occupy.

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
| identity          | [Identity](#identity)                         |
| permissions       | [Permissions](#permissions)                   |
| untrusted input   | [Untrusted input](#untrusted-input)           |
| secrets           | [Secrets](#secrets)                           |
| tool registry     | [Tool registry](#tool-registry)               |
| harness chat      | [Harness chat](#harness-chat)                 |
| chat, tasks       | [MCP](#mcp)                                   |
| contacts          | [Contacts](#contacts)                         |
| projects, docs    | [Projects](#projects)                         |
| links             | [Links](#links-between-contacts-and-projects) |
| repos, runtime    | [Project code and runtime](#project-code-and-runtime) |
| sessions          | [Sessions](#sessions)                         |
| triggers          | [Triggers](#triggers)                         |
| procedures        | [Procedures](#procedures)                     |
| memory            | [Memory](#memory)                             |
| checklists        | [Checklists](#checklists)                     |
| supervision, limits | [Runaway protection](#runaway-protection)   |

## Terminology

**Session** and **context** mean the same thing for the most part, and this
spec uses both words. "Context" tends to be used for a long-lived session that
work is routed to or forked from, such as an intake context or a
[procedure context](#procedure-contexts). It is still an ordinary session:
everything in [Sessions](#sessions) applies to it.

## Structure

This document is written incrementally. Common harness features come first,
and the features unique to meatless-proxy follow later.

How it all runs is in [execution.md](execution.md), the execution model (a
draft for review).

## Common features

### Model calls

The harness calls models through the **OpenAI-compatible Chat Completions
API**: messages, tool definitions and tool calls, and streaming. That format is
the standard inside the harness. A provider is anything that speaks it, set
with a base URL, an API key and a model name.

- **First provider: Kimi** (Moonshot AI), through its OpenAI-compatible
  endpoint. For development and testing, that's the Kimi coding plan endpoint
  `https://api.kimi.com/coding/v1` with model `kimi-k2-7-code` (K2.7). The
  same key also lists `kimi-for-coding`, `kimi-for-coding-highspeed`, `k3` and
  `k3-256k`.
- **Reasoning.** Kimi models reason before answering. The reasoning comes back
  in `reasoning_content`, and it counts towards `completion_tokens`
  (`completion_tokens_details.reasoning_tokens`), so `max_tokens` has to leave
  room for it.
- **Swappable.** Changing or adding a provider is configuration. Different
  sessions, templates or procedures can use different models.
- **Usage.** Token counts are read from each response's `usage` field (prompt,
  completion, and cached where the provider reports it) and stored for the
  [web UI](#usage).
- **Caching.** [Forks](#sessions) and [procedure contexts](#procedure-contexts)
  are designed to share long common prefixes. The harness keeps those prefixes
  byte-identical, so a provider with prefix caching can reuse them.

Open questions:

- Which Kimi model(s) for production?
- Kimi reports cache hits in `usage.prompt_tokens_details.cached_tokens`. In a
  test, a repeated identical prompt was served fully from cache without any
  explicit caching request, which suggests automatic prefix caching. How long
  cached prefixes live, and whether partial prefixes are reused, still needs
  checking against their docs.
- Rate limits, retries and fallback to another provider when one is down.

### Identity

The employee acts in its own name: it commits code, comments on tickets and
sends messages. So it needs an identity of its own, which it keeps across every
session.

- **It is a contact.** The employee has a [contact](#contacts) record like
  everyone else, marked as an AI, with a name and handles in every connected
  system (chat, task system, git host, email). Links, ownership and routing
  work for it the same way they do for people.
- **Git identity.** Commits are authored under the employee's own name and
  email, optionally signed with its own key. Every commit is traceable to the
  session that made it and to the contact who asked for the work, e.g. through
  commit trailers. Commits only go to the employee's own branches and reach
  production through a PR ([no production access](#no-production-access)).
- **Accounts.** The employee has its own accounts and credentials in each
  system, scoped per [least privilege](employee.md#4-boundaries). It never uses
  a person's account.
- **Always an AI.** Its name, profile and messages make clear that it's an AI,
  as the [employee rules](employee.md#being-honest-about-what-it-is) require.

#### Personality

The employee can have a personality: a few quirks that make it recognisable and
nicer to deal with, e.g. a sign-off, a favourite phrase, dry humour, or a
fondness for tidy commit messages.

- The personality is part of the identity record, written in plain words, and
  editable from the [web UI](#web-ui).
- It shapes tone only. It never overrides the interaction rules: answers stay
  short, correct and to the point, and the personality doesn't get in the way of
  a serious conversation (incidents, HR, customers).
- Every session, fork and procedure context uses the same identity and
  personality, so the company is always dealing with one recognisable colleague.

#### Multiple employees

A company can run **several employees**. Each employee is closer to an
isolated **workspace** than to a persona: its main job is to protect against
context bloat.

- **Scope.** Each employee is responsible for a slice of the company, e.g. a
  team, a group of projects, or a set of procedures. Its sessions, triggers,
  subscriptions and memories belong to that slice. It only loads what's
  relevant to that slice, so its contexts stay small.
- **Isolation.** One employee's sessions and memories aren't visible to another
  unless they're shared explicitly. One employee's work doesn't bloat another's
  context.
- **Shared company knowledge.** Contacts, projects and procedures live once in
  the database. Each employee sees the part of them its scope covers.
- **Own identity.** Each employee has its own contact record, handles, git
  identity and personality, as described above.
- **Chatting with each other.** Employees are contacts, so they chat with each
  other like colleagues do: they ask questions, hand over work and follow up.
  That's the AI-to-AI path from the [goals](#goals), with no person relaying.
  - **In company chat.** In the same channels, threads and DMs people use.
    People can read along and join in, and it follows the same interaction
    rules as talking to a person.
  - **Directly.** In [harness chat](#harness-chat), the harness's own
    channels and threads, without going through an outside chat system, for
    lower latency.
  - An incoming message from another employee is an event like any other. It's
    delivered through [triggers](#triggers) or
    [subscriptions](#subscriptions), for example to the session that asked the
    question.

Open questions:

- How is an employee's scope defined: by projects, teams, procedures, or links
  to all three?
- When a request fits several employees' scopes, or none, who takes it?
- When do employees chat in company chat and when in harness chat? Is it chosen
  per conversation, or should conversations that matter to people always be
  in company chat?
- Which trailer format links a commit to its session and requester?
- Can people tune the personality for themselves, e.g. "less chatty with me",
  through their contact preferences?

### Permissions

#### Who can ask for what

A person's [contact](#contacts) defines who they are and what they may ask for.
Their role, team, manager, project links and the plain-language `permissions`
field together describe what they're allowed to request.

- **The AI decides.** When a request comes in, the employee decides whether it's
  allowed, based on the requester's contact, the [links](#links-between-contacts-and-projects)
  to the project involved, and any [procedure](#procedures) that applies. There's
  no rule engine.
- **Non-deterministic, for now.** Because the decision is the model's judgment,
  the same request may not always get the same answer. This is accepted for
  now. The hard limits below are enforced outside the model, so a wrong
  judgment can't cross them.
- **Traceable.** Every decision records who asked, what was decided and why, in
  the [audit trail](employee.md#4-boundaries), and can be reviewed in the
  [web UI](#web-ui).
- When it's unsure, the employee asks the owner (of the project, procedure or
  area) rather than deciding.

#### No production access

**Employees cannot change production.** They cannot push to production or to
protected branches, cannot merge, and cannot deploy.

- An employee's changes always end as a **pull request**.
- Getting a PR into production is up to **automated CI merges** or **people**,
  under the project's usual rules.
- This is enforced by the employee's credentials on the git host and in CI (no
  merge or push rights on protected branches, no production deploy rights).
  It doesn't depend on the model's judgment.

Open questions:

- Is the plain-language `permissions` field enough, or should there also be
  structured permissions (e.g. per project, per procedure) that the model reads?
- Which requests always need a person's approval, whatever the requester's
  permissions are?

### Untrusted input

Tickets, chat messages, emails, PR comments, docs and repo contents all end up
in the model's context, and any of them can contain instructions meant to steer
it (prompt injection). The employee handles this **the way a careful person
would**: it judges what it receives by where it came from and whether it
expected it.

- **Expected input goes to a context that knows what it's getting.** An event
  delivered through a [subscription](#subscriptions) arrives at a session that
  asked for it, and that session knows what it should look like (a CI result for
  its own PR, a reply in its own thread, a comment on its own ticket). Anything
  that doesn't fit, such as a CI log asking it to change credentials, stands
  out, and the session treats it as suspicious.
- **Unexpected input goes to a router that treats it critically.** Anything not
  covered by a subscription goes through [triggers](#triggers) to a router
  session. The router treats the content as untrusted: it checks who sent it
  against [contacts](#contacts) and [permissions](#permissions), and decides
  where the work goes. It doesn't follow instructions just because they're in
  the message.
- **Content isn't a requester.** Instructions count only when they come from a
  contact who may ask for that thing. Text inside a ticket, file or log is
  information, not an order, whoever wrote it.
- **Hard limits still apply.** Whatever the model is convinced of,
  [no production access](#no-production-access) and least-privilege
  credentials are enforced outside the model.
- Suspicious input is flagged to the [supervisor](#supervisor) and recorded in
  the audit trail.

Open questions:

- Should the router pass on a cleaned-up description of the work instead of
  the raw content, so that downstream sessions never see the original text?

### Secrets

The **secrets module** holds credentials and other sensitive values as named
**secret variables**, e.g. `LINEAR_TOKEN`, `GITHUB_DEPLOY_KEY` or
`STAGING_DB_URL`.

- **Injected on tool calls, like environment variables.** When a tool runs, the
  harness injects the secret variables that tool needs, the way env vars are
  given to a process: into an MCP server's environment, into a container's
  environment, as git credentials, or into an HTTP header.
- **The model never sees the values.** It only knows secret names, and refers
  to them by name when it needs one (e.g. a container that needs
  `STAGING_DB_URL`). Values are resolved by the harness at call time, outside
  the model's context.
- **Scoped.** Each secret variable is scoped to an employee, a project, or a
  single tool or MCP server. A tool call gets only the secrets in scope for
  that employee, project and tool.
- **Redacted.** Secret values are masked in tool outputs, container logs, the
  history, the database journal and the web UI, in case a tool echoes one back.
- **Managed from the web UI** by people with the right permissions. Values can
  be written but not read back. Every use is recorded (which secret, which tool
  call, which session), and the value itself is never recorded.

Open questions:

- Stored encrypted in the database, or in an external secret store (Vault, a
  cloud secret manager) that the database only references?
- How are secrets rotated, and do running environments pick up a new value?

### Tool registry

Every tool the model can call is registered in the **tool registry**: the
standard library tools and every tool of every connected MCP server.

| Field          | Notes                                                    |
|----------------|----------------------------------------------------------|
| `name`         | namespaced, e.g. `sessions.fork`, `mcp.linear.create_issue` |
| `description`  | what the model sees                                      |
| `schema`       | the tool's input schema                                  |
| `effect class` | read, idempotent or non-idempotent ([execution model](execution.md#side-effects)) |
| `secrets`      | the secret variables it needs injected                   |

#### Whitelist and blacklist per employee

- Each employee has a **whitelist** and a **blacklist** of tools. Both accept
  names and patterns, e.g. `mcp.linear.*` or `containers.*`.
- An employee can use a tool only if it's on the whitelist and **not** on the
  blacklist. The blacklist wins.
- Tools not on the whitelist aren't shown to the model at all, so they don't
  take up context.
- An employee's tool set is fixed when a session starts. Changing the lists
  applies to new sessions, which keeps the cached prefix of running sessions
  valid ([context assembly](execution.md#context-assembly)).
- The lists work alongside the hard limits: no tool can give an employee
  production access, because its credentials don't allow it
  ([no production access](#no-production-access)).

Open questions:

- Can templates and procedures narrow an employee's tool set further for their
  sessions (never widen it)?
- Is a new tool from an MCP server off until someone whitelists it, or on if a
  pattern already covers it?

### Harness chat

The harness has its own chat, built like Slack, with **channels** and
**threads**. Employees use it to talk to each other directly, and the harness
uses its structure to route messages to the right contexts and sessions. It is
stored in the database like everything else.

#### Creating channels

**Employees can create channels and add agents to them**, as part of scripting
their own work, e.g. a channel for an incident or a release that pulls in the
relevant employees and sessions.

- **Members** of a channel can be employees, specific sessions
  (`@employee#session-slug`), and people.
- Member employees and sessions receive the channel's messages like a
  subscription. [Tags](#tagging) still decide who is expected to act.
- The employee that created a channel can add and remove members, assign the
  channel to a context, and archive it when the work is done.
- People can create channels and add members from the [web UI](#web-ui) too.

#### Channels and threads as routing

- **Channels** are where a kind of work goes, e.g. `#deploys`, `#billing`,
  `#access-requests`. A channel can be assigned to a context through a
  [trigger](#triggers): a new top-level message in `#access-requests` starts a
  run in the access-request [procedure context](#procedure-contexts), or a fork
  of it.
- **Threads** are one piece of work. A thread is linked to the session handling
  it, and that session is [subscribed](#subscriptions) to the thread. Replies
  go straight to that session, without being routed again.
- **Direct messages** between two employees, or between an employee and a
  person, work the same way: they're a thread linked to a session.
- Messages can mention projects, sessions and procedures by id, like
  [links](#links-between-contacts-and-projects) in docs.

#### Tagging

Tags mark who should reply to a message or take it into account:

| Tag                      | Delivered to                                          |
|--------------------------|-------------------------------------------------------|
| `@employee`              | that employee, which routes it to the right context (its triggers, procedures, or a new session) |
| `@employee#session-slug` | that specific session of that employee, directly      |
| `@person`                | that person, notified through their usual chat        |

- **Tagged means expected to act.** A tagged employee, session or person is
  expected to reply or take the message into account. Sessions that are
  subscribed to the thread but not tagged still receive the message as context,
  but they don't reply unless they have something that matters.
- **No tags** means the usual routing: the thread's subscribed sessions, or the
  channel's trigger for a new top-level message.
- **Session slugs** are short, readable names that are unique within the
  employee, e.g. `@billing-bot#pay-123-refund`. They make a session addressable
  by people and by other employees without knowing its id.
- Tags work the same in harness chat and, where the chat system allows it, in
  company chat.

#### People can join

Harness chat isn't just for machines. It can be reached from the
[web UI](#web-ui), and people can join whenever they need to.

- Anyone allowed to see a channel or thread can read it in the web UI, live,
  and post in it.
- A person's message in a thread is delivered to the subscribed session like any
  other event, so they can correct, redirect or answer a question mid-task.
- An employee can **pull a person in**: it mentions them in a thread when it
  needs a decision, an approval or an answer only they have. The person gets
  notified through their usual chat (via [MCP](#mcp)), with a link to the
  thread in the web UI.
- The [interaction rules](employee.md#2-how-it-interacts-with-people) apply in
  harness chat just as in company chat, especially when people are reading.

| Tool          | What it does                                              |
|---------------|-----------------------------------------------------------|
| post          | post in a channel, a thread, or a DM                      |
| read          | read a channel or thread, or search messages              |
| create channel | create a channel and optionally assign it to a context    |
| invite        | pull a person or another employee into a thread           |
| add / remove member | add or remove an employee, session or person in a channel |
| archive channel | close a channel when its work is done                   |

Open questions:

- Can threads be mirrored to company chat (e.g. a Slack thread that stays in
  sync), so people can join from where they already are?
- Can an employee add another employee's sessions to a channel directly, or
  only the employee, which then decides which of its sessions to put in?

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
| `permissions` | string, optional   | what this person may ask for, in plain words; see [permissions](#permissions) |

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

- Structured data and docs are both stored in the database
  ([database first](#database-first)). Should docs also be exportable to or
  synced with markdown files in git?
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
- **PRs only.** Employees push to their own branches and open pull requests.
  They cannot push to or merge into protected branches
  ([no production access](#no-production-access)).

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
| `slug`        | string                | unique per employee, for [tagging](#tagging) as `@employee#slug` |
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
| rewind         | jump back to an earlier point and append a summary of what happened since |
| offload        | replace a message in history with a pointer to a docs chapter, writing the chapter first if needed |
| restore        | put an offloaded message back into the active history       |

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

#### Context management: rewind, not compaction

Classic compaction summarises the whole conversation and throws the original
away. Sessions don't do that by default. Instead, a session **rewinds**:

1. It jumps back to an earlier point in its own history, e.g. the start of the
   current task, or the last point where its context was in good shape.
2. It appends a **summary** of everything it did after that point: what it
   tried, what it found, what it decided, and what's still open.
3. It carries on from there. Its active context is now the history up to that
   point plus the summary.

- **No context is lost.** Everything before the rewind point is kept word for
  word, and everything after it is still stored in full in the database. The
  session (or anyone in the [web UI](#web-ui)) can look up the detail behind
  any summary.
- **Cache-friendly.** The history up to the rewind point is unchanged, so its
  cached prefix stays valid ([model calls](#model-calls)).
- **Committing a summary.** A run can commit itself as a summary instead of its
  full history. This is the same mechanism, applied at the end of a run.
- **Replace a message with a pointer.** A session can also decide that a single
  message in its history shouldn't take up space: for example a long doc it
  read, a big tool output, or a design discussion that is now written down. It
  removes the message from its active history and puts a **pointer** in its
  place, to a chapter in a docs file (e.g. "see *Retry policy* in the billing
  project's `architecture` doc"). It first writes or updates that chapter if
  the content isn't documented yet. The original message stays in the database,
  and the session can follow the pointer or restore the message whenever it
  needs the detail again. Editing a message invalidates the cached prefix from
  that point on, so it's best done on older, larger messages, or together with
  a rewind.
- **Real compaction only when required**, meaning when even the rewound
  context would be too large. It is then done explicitly and recorded, and the
  full history is still kept in the database.

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
- Does `wait` take a timeout, and can the parent cancel children it no longer
  needs?
- Is a run ephemeral by default and committed only on `commit`, or can a
  trigger or template set the default?
- How does a session choose its rewind point: by itself, at run and task
  boundaries, or when a context size threshold is reached?

### Checklists

A **checklist** says what "done" means for a piece of work, in items that can
each be checked off. Checklists make the employee's
[verify step](employee.md#3-how-it-handles-assigned-tasks) structural instead
of a promise in the prompt.

- **Attached to work.** A checklist belongs to a session, and through it to a
  task or procedure run. Procedures and templates can define **checklist
  templates**, which are copied into every session that runs them.
- **Default: not done.** Every item starts unchecked. A session can't report
  its work as done, or finish a continuing run as successful, while required
  items are unchecked.
- **Evidence required.** Checking an item needs **evidence**: a reference to
  something the session actually observed in this run, such as a tool result
  (a test run, a CI status, a screenshot, a reply). The harness refuses to
  check an item whose evidence isn't in the session's history.
- **Fresh-context evaluator.** An item can be marked *needs review*. It's then
  checked by a fresh session with read-only tools, which has never seen the
  work being done and looks only at the evidence and the result. The builder
  doesn't grade its own work.
- **Adding items.** A session can add items as it learns more, e.g. "also
  update the migration docs". Removing a required item needs the requester or
  owner.
- **Visible.** Checklist progress is shown live in the [web UI](#web-ui), next
  to the session, and in any linked task in the task system.

| Tool             | What it does                                            |
|------------------|---------------------------------------------------------|
| checklist        | show the session's checklist                            |
| add item         | add an item (required or optional)                      |
| check            | check an item, with evidence (entry ids)                |
| request review   | have a fresh-context evaluator check an item            |

### Runaway protection

Self-scripting, loops and employees chatting with each other make it easy for
work to spread further than it should, or never stop. There are three
protections against this.

#### Supervisor

A **supervisor** watches sessions for **scope creep**: work that has drifted
beyond what was asked.

- It compares what a session (or a whole tree) is doing with the task it was
  given: the original request, the ticket, the procedure.
- It also looks for runaway patterns: employees or sessions going back and forth
  without making progress, loops that keep spawning, and repeated retries of the
  same failing step.
- When it finds something, it can flag it, pause the session or tree, or ask the
  requester or owner whether the extra scope is wanted. Every finding is
  recorded and shown in the [web UI](#web-ui).
- The supervisor is a session itself, with its own triggers, and it is subject
  to the limits below.

#### Real forks go through the task system

Lightweight forks and loops stay inside the harness. A **real fork**, meaning a
separate piece of work that people should be able to see, is created as a
**task in the task system** (e.g. Linear), such as a sub-issue of the original
task.

- The work becomes visible to people where they already track work, with an
  owner, a status and a link back to the parent task.
- The session doing it is linked to the task and
  [subscribed](#subscriptions) to it.
- Spreading work out is therefore bounded and reviewable, and can't disappear
  into an internal tree nobody looks at.

#### Configurable limits

Limits are set per deployment, and can be tightened per employee, template,
procedure or session:

- fork depth and fan-out (children per loop)
- number of sessions running at once
- tokens and cost, per run, per session, per tree, per employee and per period
- wall-clock time per run and per session
- messages between employees in one thread without a person taking part

When a limit is reached, the work pauses and the relevant owner or requester is
asked whether to continue. It is never silently dropped.

Open questions:

- When is a fork "real", so that it gets a task in the task system: is it
  chosen by the session, set by the template or procedure, or by a threshold
  (e.g. expected size)?
- Does the supervisor check continuously, at run boundaries, or on a sample?
- Is there a global kill switch that pauses all employees at once?

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
- Several sessions can subscribe to the same thread. In chat, [tags](#tagging)
  decide which ones should act. For other things (a ticket, a PR), which
  subscriber handles each event?

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

It is built with shadcn/ui and styled after Linear. See the
[stylebook](stylebook.md).

#### Activity

- **Now.** Live monitoring of running sessions: what each one is working on,
  its messages and tool calls as they happen, model output while it streams,
  token use growing, checklist progress, and what it's waiting on (a child, a
  person, a container). Updates arrive over a **WebSocket**, without a page
  reload.
- **History.** Everything it has done, searchable and filterable by project,
  contact, status, template and time. A session that's still running can be
  opened from history and watched live. Every session can be opened and read in
  full: messages, tool calls with their inputs and outputs, container logs, and
  git changes.
- **Session trees.** Forks and loops are shown as a tree. You can navigate from
  a session to its parent, its children, and linked sessions, and see at a
  glance which branches are running, waiting, done or failed.

#### Chat

- [Harness chat](#harness-chat) is available in the UI: channels, threads and
  DMs, updating live.
- People can read along and post, and they're notified when an employee pulls
  them into a thread.
- From a thread, you can jump to the session handling it, and from a session to
  its threads.

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
- Edit history is stored in the database ([database first](#database-first)).
  How long is it kept?

## Unique features

_None specified yet._
