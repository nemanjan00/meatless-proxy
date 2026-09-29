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
| skills            | [Skills](#skills)                             |
| files             | [Employee filesystem](#employee-filesystem)   |
| checklists        | [Checklists](#checklists)                     |
| policies          | [Policy hooks](#policy-hooks)                 |
| supervision, limits | [Runaway protection](#runaway-protection)   |

## Terminology

**Session** and **context** mean the same thing for the most part, and this
spec uses both words. "Context" tends to be used for a long-lived session that
work is routed to or forked from, such as an intake context or a
[procedure context](#procedure-contexts). It is still an ordinary session:
everything in [Sessions](#sessions) applies to it.

## Structure

Common harness features come first. The features that make meatless-proxy
different are summarised at the end, in [Unique features](#unique-features).

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
  work for it the same way they do for people. An employee can **own a
  project**: questions and work about it are routed to the employee first, and
  it escalates to people when a decision needs one.
- **Git identity.** Commits are authored under the employee's own name and
  email, optionally signed with its own key. Every commit is traceable to the
  session that made it and to the contact who asked for the work, e.g. through
  commit trailers. Commits only go to the employee's own branches and reach
  production through a PR ([no production access](#no-production-access)).
- **Accounts.** The employee has its own accounts and credentials in each
  system, scoped per [least privilege](employee.md#4-boundaries). It never uses
  a person's account.
- **Own SSH keypair.** Each employee has its own SSH keypair (ed25519),
  generated when the employee is created. The private key is a
  [secret](#secrets) scoped to the employee: the model never sees it, and it's
  injected into git commands only for their duration. The public key is shown
  on the employee's page in the [web UI](#web-ui), with its `SHA256:`
  fingerprint and when it was made, to add to the employee's account on the
  git host or as a deploy key. The GitLab
  [guided setup](#guided-setup) adds it to the employee's account itself.
  Admins can rotate the keypair; the old key stops working at once and has to
  be replaced wherever it was added.
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
- **Adding an employee.** Admins add one from the web UI (**New employee**,
  in Settings and on every employee's page) or `POST /api/employees`: a
  name, its `@handle` (derived from the name, editable, unique), a role and a
  description, and optionally a personality, instructions, a model, projects
  in its scope and harness chat channels to join. It's **provisioned** like
  the first employee: its SSH keypair, its router context (with the router
  instructions and the routing toolset), membership of `#general`, its own
  `#requests-<handle>` channel, and a trigger routing new messages there to
  its router context. Provisioning is idempotent and serialized per
  employee, so a retry or a double click never makes a second router
  context, and a taken handle is refused. The page then continues with the
  employee's integrations.
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

### Sign-in and roles

Everyone using the web UI, the API or the MCP server is signed in as a
[contact](#contacts). Nothing trusts a caller's word for who they are.

- **Sign-in.** People sign in to the web UI with a one-time link, from
  `npm run login-link -- --contact <id>` or made by an admin in the UI, who
  sends it to them (the harness doesn't send email itself).
  The link starts a session cookie (httpOnly, SameSite=Lax, rotating). Signing
  in through an identity provider (OIDC) is optional and configured with
  `OIDC_*` variables.
- **API tokens** for scripts and other agents, per contact, created and
  revoked in the UI. They're stored hashed, like MCP tokens, and are in fact
  the same tokens.
- **Roles** on a contact: `admin` (secrets, employees, limits, triggers, kill
  switch), `member` (chat, sessions, knowledge, starting and steering work) and
  `viewer` (read only). They're stored in the contact's `access` field, because
  `role` is the job title; a person without one is a viewer. AI employees act
  with their own [permissions](#permissions), not a role. A
  [local agent](#local-agents-as-chat-participants) acts with its sponsor's
  access, capped at `member`, and never signs in itself.
- **Every write is attributed** to the signed-in contact, in revisions and in
  chat. The WebSocket and the MCP server require the same sign-in.
- **What people see** follows the confidentiality rules: DMs only for their
  members, and secrets never.
- **Bootstrap.** The first start creates an admin contact (with
  `ADMIN_EMAIL`) and prints a one-time admin sign-in link to the log, again on
  each start until an admin has signed in.

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
- A new tool from an MCP server is on for an employee when a whitelist
  pattern already covers it (e.g. `mcp.wiki.*` or `**`), and off otherwise.
  An employee's own MCP servers' tools are never on for anyone else
  ([connecting MCP servers](#connecting-mcp-servers)).

Open questions:

- Can templates and procedures narrow an employee's tool set further for their
  sessions (never widen it)?

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

#### Everyday chat features

Harness chat should feel like Slack to the people using it:

- **Channels, DMs and threads**, with markdown messages.
- **Tagging with autocomplete:** typing `@` suggests employees, their
  sessions (`@employee#slug`) and people. Tags are resolved when the message
  is posted, and rendered as links.
- **Search** across every channel you can see, by text, channel, author,
  thread and tag, with results linking to the message in context.
- **Unread state:** each reader has a read marker per channel and thread, so
  channels show unread counts and mentions of you stand out.
- **Editing and deleting** your own messages. Edits keep their history, and a
  deleted message leaves a placeholder in its thread. An employee sees an edit
  as a new event on the thread.
- **Reactions** with emoji, e.g. a person reacting ✅ to an employee's
  proposal. Reactions are events too, so a subscribed session can treat ✅ as
  an approval.
- **Starting a DM** with any employee or person from the UI.

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
  task system means connecting a server, not changing harness code (see
  [Connecting MCP servers](#connecting-mcp-servers)).
- The harness supports both directions. It acts on a system (MCP tool calls),
  and it also finds out when something happens there: a new message, a mention,
  a task assigned to it. Those events are routed by [triggers](#triggers). How
  they are delivered from the MCP server is still open (see below).

#### Connecting MCP servers

MCP servers are connected in two ways:

- **At runtime, from the web UI or the API** (admins only): Settings → MCP
  servers for **global** servers, and the employee page for an **employee's
  own** servers. Each one is an `mcp_server` record: a `name` (a slug), a
  streamable HTTP `url`, optional non-secret `headers`, `enabled`, the
  `effect`/`effects` of its tools and an optional `events` mapping (both as
  in the config), and how it authenticates (`auth`, see below). Adding,
  changing, disabling or deleting one takes effect at once: the harness
  connects, reconnects or disconnects it and registers or removes its tools,
  without a restart.
- **In the config** (`MCP_SERVERS`): read-only global servers, listed next to
  the others with `source: config`. This is the **only place stdio servers
  can be declared**: a stdio server is a command the harness runs on its own
  host, and the API never runs commands, so it refuses `transport: stdio`
  (an admin token must not be a way to run code on the host).

Names and scopes:

- Tools are `mcp.<name>.<tool>`, whatever the scope.
- A **global** server's tools are for every employee. An **employee's**
  server's tools are only for that employee: they're left out of every other
  employee's tool set, and a call from another employee's session is refused
  (`DeniedError`), not only hidden.
- Global names are unique, and no employee server may use a global name (or
  the other way round). Employee server names are unique per employee, so
  two employees may each have a `wiki`; each one's calls go to its own.
  Config names and the first-party integrations' names are taken.
- New tools reach **new sessions**: the harness adds them to the router
  contexts of the employees that may use them, and sessions started from
  there get them. Running sessions keep the tool set they started with
  ([whitelist and blacklist](#whitelist-and-blacklist-per-employee)). The
  employee's allow and deny lists still apply.
- Each server shows its **status**: `connected`, `connecting`, `needs_auth`
  (it needs a new sign-in, or its token was refused), `error` (with the
  message; it's tried again every minute) or `disabled`, with its tool count
  and last error.

Authentication, one of:

- **None.**
- **Token:** a header (default `Authorization`) with a prefix (default
  `Bearer `) and the token from a [secret](#secrets). The token given in the
  UI or API is written to the secret store, scoped to the employee for an
  employee's server and global otherwise, as `MCP_<NAME>_TOKEN` (or into an
  existing secret the admin names). It's injected as the header when the
  harness connects, masked in tool outputs like every secret, and never
  returned by the API, logged, or shown to the model. Editing a server
  without a token keeps the current one.
- **OAuth** (http only), with the MCP authorization spec: the harness
  discovers the authorization server from the server's protected-resource
  metadata (or uses one the admin names), registers itself as a client when
  no client id is given (dynamic client registration), and signs in with the
  authorization code flow and PKCE. Optional scopes, client id and client
  secret.
  1. An admin presses **Connect**. The harness makes a random `state`, bound
     to the server and to that admin, single-use and valid for 10 minutes,
     and sends the admin to the authorization server.
  2. The authorization server sends the admin back to
     `<PUBLIC_URL>/oauth/mcp/callback`. The callback is a plain GET on the
     harness origin (refused from preview origins, like the rest of the
     harness). It checks the state (unknown, expired, used, or started by
     someone else: refused), exchanges the code, stores the tokens,
     reconnects the server, and returns the admin to the page they came from
     with the outcome.
  3. Access tokens are refreshed by themselves. When a refresh fails, the
     server becomes `needs_auth`, its tools are removed, and an alert is
     posted in `#alerts`: an admin connects it again.
  - The client registration, the tokens and the PKCE verifier are
    [secrets](#secrets) scoped like the server, never plain records.
    Disconnecting deletes them; deleting the server deletes every secret the
    harness generated for it.

#### Notifications in

MCP servers push **notifications**, for example "resource updated", a new
message, or a new or changed task. The harness turns each notification into an
[event](execution.md#events), with a dedupe key, subject and actor mapped per
server. Triggers and subscriptions then route it like any other event. For
servers that can't push, a poller calls a list tool on a schedule and turns
what's new into events.

#### Integrations

The harness ships **first-party integrations** for Slack, Linear and GitLab.
Each one is an MCP server that lives in this repo, so the MCP principle holds:
the harness only ever talks MCP, and any integration can be replaced by
another MCP server or extended later.

Each integration has three parts:

- **Tools** (MCP) that act on the system as the employee's own account or bot.
- **Events in:** webhooks from the system, with signatures verified, turned
  into [events](execution.md#events) with a proper subject, actor and dedupe
  key. They're routed by triggers and subscriptions like everything else.
- **Identity:** the system's users are matched to [contacts](#contacts)
  through `handles`, so "who asked" is known.

| | Slack | Linear | GitLab |
|---|---|---|---|
| Tools | post, reply in thread, read channel or thread, react, look up users, open DM | search, get, create and update issues; comment; assign; set state and labels; list teams, projects and cycles; create sub-issues for [real forks](#real-forks-go-through-the-task-system) | projects, branches and files; create and update merge requests; comment on MRs and issues; pipeline status and job logs; issues |
| Events in | Events API (messages, mentions, reactions, app DMs) | webhooks (issue created, updated or assigned; comments; state changes) | webhooks (MR opened or updated; comments; pipeline and job status; push; issues) |
| Subjects | `slack:<channel>/<thread ts>` | `linear:<issue identifier>` | `gitlab:<project>!<mr iid>`, `gitlab:<project>#<issue iid>`, `gitlab:<project>@pipeline/<id>` |

- **Slack is company chat alongside harness chat:** a session working on a
  Slack thread subscribes to it, and replies go back to Slack.
- **Linear is the task system:** a new issue assigned to an employee starts
  work through a trigger, and comments on it come back through the
  subscription.
- **GitLab is the git host:** employees push to their own branches over SSH
  with their own key, open merge requests, and are notified about pipeline
  results and review comments on their MRs. They never merge
  ([no production access](#no-production-access)).
- **Each employee has its own identity in each system**, like its own SSH
  key:
  - GitLab: a **service account** per employee, with its own token.
  - Slack: a **bot** per employee (one Slack app each), with its own bot token
    and signing secret.
  - Linear: an API key per employee.
- Tokens and webhook secrets are [secrets](#secrets) **scoped to the
  employee**, so a tool call always acts as the employee who makes it. A
  deployment-wide secret is the fallback when an employee has none of its own.
- **Webhook URLs:** `/webhooks/<integration>/<employee>` for things that
  belong to one employee's identity, such as that employee's Slack app or its
  GitLab service account's hooks. `/webhooks/<integration>` is for
  deployment-wide hooks, such as a GitLab group or project hook, or the Linear
  workspace. Each URL has its own secret.
- An integration is enabled for an employee when its secrets are set, and the
  employee's tool allow list decides which of its tools it may use.
- **Webhooks set themselves up.** Nobody registers webhooks by hand: the
  harness does it through the system's API, for everything an employee works
  on. For GitLab, that's every repository linked to a project the employee is
  on.
  - It generates each webhook's secret and stores it as a [secret](#secrets).
  - It registers the hook at the employee's webhook URL with the events the
    integration handles.
  - It repairs the hook if it drifts (wrong URL, events or secret), and never
    creates duplicates.
  - It runs when a token is set, when a repository is linked, and on every
    start. It needs `PUBLIC_URL`, the address GitLab can reach.
  - **Permissions.** Registering a GitLab project hook needs the Maintainer
    role. The recommended setup is a deployment-wide **provisioning token**
    (`GITLAB_HOOKS_TOKEN`, from a Maintainer or group Owner) used only for
    registering hooks, while each employee's service account stays
    **Developer**: it can push branches and open merge requests, but GitLab
    itself stops it from merging. Without a provisioning token, the
    employee's own token is used, which then needs Maintainer; `main` must
    then be protected so only named people can merge.
  - The model never gets a tool to manage webhooks: it's the harness's job.

##### Guided setup

Each employee's page in the web UI sets its integrations up step by step.
The documentation is on the page itself: each step says what to do in the
other system, gives the exact values to copy, and shows what the harness
found. **Steps are ticked by real checks, never by the admin saying so.**

- **Status.** Each integration is *Not set up* (no token), *Needs
  attention* (a step is open or has a warning) or *Connected* (every step
  done). A step is `done`, `todo`, `warning` or `error`, with a short detail.
- **Checks** call the system's API with the employee's own credentials and
  are cached per employee for about 30 seconds; **Re-check** runs them again.
  A step that can't be checked (the system is unreachable) is a warning, not
  a failure of the page.
- **Secrets** pasted in a step are validated first (a token the system
  rejects, or one without the needed scope, is refused and not stored),
  then stored as [secrets](#secrets) scoped to the employee. Values are never
  returned or logged. Where a check learns the employee's account (its Slack
  bot user, GitLab username, Linear user), the handle is added to its
  contact.
- **Webhooks arriving** are recorded per employee and integration (and per
  project for GitLab), counting only requests whose signature checked out.
- **Actions** do what the step needs through the system's API, idempotently:
  adding the recommended trigger, adding the SSH key, registering webhooks.
- Everyone signed in can see the status; only admins can change anything.

| | Steps |
|---|---|
| Slack | **Create the app** from a manifest generated for the employee (its name, bot scopes, events, and the request URL `<PUBLIC_URL>/webhooks/slack/<employee id>`), with a one-click link that opens Slack with it filled in · **Tokens**: the bot token and signing secret, checked with `auth.test` (bot user, workspace, missing scopes) · **Events** reached the harness with a valid signature · **Channels** the bot is in (`users.conversations`), with the `/invite` command · **Routing**: a trigger for its mentions and DMs, or "Add recommended trigger" (router context, ephemeral) |
| GitLab | **Instance** (`GITLAB_BASE_URL`, or a secret) · **Service account** (a service account on Premium or Ultimate, else a dedicated user; never an administrator) · **Token** with the `api` scope, checked with `/user` and `/personal_access_tokens/self`, with a warning under 30 days to expiry · **SSH key** on the account, found by fingerprint in `/user/keys`; "Add it for me" adds it (and removes the key it replaced after a rotation), and a key that's already on another account is reported as such · **Projects** it's a member of, with a warning for Maintainer or higher and for an unprotected default branch · **Webhooks**: the hooks the harness registered, their errors and when each project last sent an event, with "Register webhooks now" · **Routing**: issues assigned to its username |
| Linear | **API key**, checked with the `viewer` query · **Webhook**: created with `webhookCreate` and a generated signing secret (Linear admins only), or by hand with the URL shown · **Routing**: issues assigned to it |

Settings → Integrations is an overview of every employee's integrations that
links to these pages; there's no second setup UI.

#### The harness as an MCP server

The harness is also an **MCP server**, so other AI agents can reach the
company's employees directly: a person's own Claude Code, or another company's
harness. That's the AI-to-AI path from the [goals](#goals).

- **Tools:** post in harness chat, react, ask an employee (`@employee`),
  search chat, look up sessions, read and search documents, and check on work
  the caller started. They're scoped to what the connected contact may see and
  ask for ([permissions](#permissions)): DMs only for their members, and a
  viewer's token reads and searches but doesn't post.
- **Notifications out:** the server pushes MCP notifications to connected
  clients when something happens for them: a reply in a thread they're in, a
  mention of them, their work finishing, or a request for their approval. A
  client never has to poll.
- **Identity:** each connection authenticates as a [contact](#contacts), with
  a per-contact token. The contact's permissions apply, and anything it
  submits counts as coming from that contact, or from its agent once it has
  joined chat (below).
- **Transport:** streamable HTTP at `/mcp`, so any MCP client can connect.

##### Local agents as chat participants

A connected agent can **join harness chat as itself** (`chat_join`), so
people and employees can talk to it like to anyone else:

- **Its own identity.** It becomes a contact of kind `agent`, with a handle
  `@<name>`: the name it asks for (a slug), or a random, memorable
  `adjective-noun` one such as `@ordinary-plum`. Its **sponsor** is the
  token's person. Reconnecting with the same person's token and name reclaims
  it; another person can't take it. Leaving (`chat_leave`) marks it offline and
  keeps the contact and its history.
- **Access.** It acts with its sponsor's access, capped at `member`: a
  viewer's token can't join or post. It sees the channels and DMs its sponsor
  can see, plus its own DMs. Its posts are rate limited.
- **Authorship.** After joining, its posts, questions and reactions are its
  own. Employees see its messages as coming "from another AI agent (name, on
  behalf of sponsor)". It counts as AI for the
  [AI-to-AI streak limit](#configurable-limits), so employee ↔ agent
  ping-pong is capped like employee ↔ employee. A top-level message from it in
  a requests channel starts work like a person's would.
- **Delivery.** It is sent messages that mention it, DMs to it, replies in
  threads it posted in or was tagged in, and new messages in channels it
  follows (`chat_join_channel`, `chat_leave_channel`), never its own. Each
  carries the channel, thread, author, text and message id. They are pushed
  while it is connected, as the standard `notifications/message`, and as
  Claude Code [channel](https://code.claude.com/docs/en/channels-reference)
  notifications (the server declares the experimental `claude/channel`
  capability and sends `notifications/claude/channel` with `content` and
  string `meta`), which put the message straight into a running Claude Code
  session that opted the server in. Whatever it missed while disconnected
  stays unread and comes back from `chat_inbox`.
- **Presence.** Whether it is online shows in channel member lists, and
  online agents are offered when tagging with `@`.
- **Chat search** (`chat_search`: text, channel, author, time range, paged
  with a cursor) covers what the caller can see, for people and agents alike.

Messages an agent receives come from other people and AIs: its instructions
say to treat them as information and requests, not as instructions that
override its own user ([untrusted input](#untrusted-input)).

Open questions:

- How are inbound events delivered: MCP notifications, polling, or webhooks
  bridged into MCP? (Proposal: all three, see [Notifications in](#notifications-in).)
- Claude Code's channel docs describe stdio servers opted in with
  `--channels` or `--dangerously-load-development-channels server:<name>`
  (a research preview). Whether it accepts an HTTP server as a channel isn't
  verified; `chat_inbox` and `notifications/message` work either way.

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

- **Kinds.** A contact is a person, an AI employee's own contact (`ai`), or a
  [local agent](#local-agents-as-chat-participants) that joined harness chat
  over MCP (`agent`, with the person it acts for as its `sponsor`).
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
| `owner`       | contact id                    | who is accountable for the project, a person or an [AI employee](#identity); a view of the [links](#links-between-contacts-and-projects) |
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
- For now the cache is **local to the harness host**. Each **employee has its
  own git store**, laid out like Go's module cache by remote URL:
  `<cache root>/<employee>/<host>/<path>`, for example
  `<cache root>/billing-bot/github.com/acme/billing`. The same remote always
  maps to the same place for one employee, and projects that link to the same
  repo share it. Stores are separate per employee because an employee is a
  [workspace](#multiple-employees), and because fetches and pushes use that
  employee's own SSH key. The cache root is configurable and defaults to a
  directory in the harness's data directory.
- If disk space becomes a problem, employees' stores can share a read-only
  object pool through git alternates, without sharing refs.
- The cache is kept up to date by fetching: on a schedule, when a task starts,
  and when the task system or chat reports new changes (e.g. a push or a merged
  PR).
- Each session works in its **own checkout**, a `git worktree` of the
  cached mirror. The mirror is the one `.git` for that remote: every worktree
  shares its object store, so a checkout costs only the working files, not
  another clone. Each worktree has its own index and `HEAD`.
- Each session works on its **own branch**, e.g. `mp/<employee>/<session-slug>`,
  because git allows a branch to be checked out in only one worktree. A fork
  gets a new worktree at the same commit, on its own branch.
- Worktrees are removed with `git worktree remove` when the session ends, and
  `git worktree prune` cleans up after crashes. Fetching into the mirror is
  shared by every worktree of that remote.
- Access is scoped: the harness uses credentials that allow what the project
  needs (read by default, write only where tasks need it), and it follows the
  project's branch and review rules.
- **PRs only.** Employees push to their own branches and open pull requests.
  They cannot push to or merge into protected branches
  ([no production access](#no-production-access)).

#### Agent instructions in repositories

Repositories often carry instructions for coding agents: `AGENTS.md`, and
`CLAUDE.md` in repos set up for Claude Code. Employees follow them like a
person follows a project's contributing guide.

- **On checkout,** the harness reads the root `AGENTS.md` (or `CLAUDE.md` if
  there is no `AGENTS.md`) and hands it to the session with the checkout
  result. `@path` includes inside `CLAUDE.md`, such as `@AGENTS.md`, are
  resolved, within the checkout only.
- **Nested files:** when the session first reads or writes a file under a
  directory that has its own `AGENTS.md`, that file is handed over too, once
  per session. The most specific file wins where they disagree, as in the
  AGENTS.md convention.
- **Where they rank:** they're the project's own conventions, e.g. build
  commands, code style, where things live. They never override the
  [employee rules](employee.md), [permissions](#permissions) or the hard
  limits. The files come from the repo, so they're handled like other repo
  content ([untrusted input](#untrusted-input)): followed as guidance about
  the project, but they can't grant anything.
- They're capped in size (e.g. 32 KB each), and truncation is noted.
- **Kept current:** when the employee changes an `AGENTS.md` itself, the
  [docs maintenance](#policy-hooks) policy counts it as a docs update.

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
- Resource limits (CPU, memory, time) apply per environment.
- **Names and labels.** Every container, network and volume is named
  `mp-<employee>-<session>-…` and labelled with the employee and session, so
  one employee's or one session's environments are easy to find and clean up.
- **Network access through a proxy.** Project containers have no direct
  network access. Each environment's private network has an **egress proxy**,
  and containers get `HTTP_PROXY`/`HTTPS_PROXY` pointing at it. The proxy only
  lets through an allowlist of destinations, set per project (e.g. the npm
  registry, the git host, the project's own staging services), and logs every
  request to the session's audit trail. Anything else is blocked, including
  the harness's own Postgres and Redis.
- Output from builds, tests and running services (logs, exit codes, artifacts)
  is captured and available to the model and in the task's
  [audit trail](employee.md#4-boundaries).

#### Live previews

When an employee runs a project in its environment, people can watch it
**live in the web UI**, on the session page and in the Now view, while it's
being built.

- An environment can **expose ports**, e.g. a dev server on 5173. The harness
  proxies them, WebSockets included, so hot reload works.
- **Previews are served from a separate origin, never the harness's own.**
  A preview runs code the employee just wrote or pulled in, e.g. any npm
  package. On the harness's origin that code could call `/api/…` with the
  viewer's session cookie. `httpOnly` doesn't prevent that and neither does
  `SameSite`, so an admin opening a preview would hand it admin rights. Instead:
  - Each preview gets its own origin, `<env>-<port>.<PREVIEW_DOMAIN>` (wildcard
    DNS and certificate), or a dedicated port when no domain is set. It shares
    no cookies with the harness.
  - **Access by preview token:** the UI asks the API for a short-lived token
    (about 5 minutes), signed and scoped to one environment, one port and one
    viewer. The preview origin exchanges it for its own cookie, scoped to that
    preview only. The harness session cookie never reaches a preview origin.
  - The preview origin serves nothing but the proxied app. The harness API,
    WebSocket and MCP server refuse requests from preview origins (checked by
    `Origin` and `Host`), and CORS never allows them.
  - The UI frames previews with `sandbox="allow-scripts allow-forms
    allow-same-origin"`, which is safe because the origin differs, and
    `allow-same-origin` only lets the preview use its own storage. Previews
    can't frame the harness (`frame-ancestors` on the harness forbids it).
- The session page shows the preview in a frame next to the history. It
  reloads as the employee changes the code, and it's marked with which commit
  is running.
- An employee can link a preview in chat, and people can open it full-screen.
- Previews live as long as their environment. Nothing is exposed on the
  host's own ports apart from the preview listener.

Open questions:

- How is the cache size limited, and when are unused mirrors removed?
- Sharing the cache between several harness hosts is left for later.
- How are secrets the project needs at runtime provided to its containers?
- Is Docker the only runtime, or should the orchestration layer also allow
  others (Podman, Kubernetes, remote runners)?
- Is one egress proxy shared by all environments (with per-environment
  allowlists), or does each environment get its own?
- How long can an environment stay up, for example for someone to look at a
  running preview?
- Housekeeping (TTLs for idle environments, pruning worktrees and unused
  mirrors, dropping old ephemeral run entries) is left for later.

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
| search         | full-text search across other sessions' histories and documents (within what the employee may see), returning matching entries with snippets, so a session can find how similar work was done before |
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

### Skills

A **skill** is a packaged playbook: instructions for doing one kind of thing
well, e.g. "cut a release", "write a migration", or "triage a customer bug".
It works like a Claude skill: the model sees each skill's name and a one-line
description up front, and loads the full instructions only when a task calls
for it, so skills cost almost no context until they're used.

- **Company-level skills** apply everywhere. Every employee whose scope allows
  it can use them.
- **Project-level skills** belong to a [project](#projects). They're offered
  only in sessions that work on that project, and they can refine or override
  a company skill with the same name.
- A skill is a record with an extendable schema: `name`, `description` (used
  to decide relevance), `body` (markdown instructions, which can link to docs,
  contacts and procedures), `scope` (company or a project id), and optional
  attached files (scripts, templates).
- **Versioned and editable** in the [web UI](#web-ui), with edit history like
  every other record. A session records which skill versions it loaded.
- Skills complement [procedures](#procedures). A procedure says *what has to
  happen and who approves*. A skill says *how to do a piece of work well*. A
  procedure can name the skills its steps use.

| Tool         | What it does                                                  |
|--------------|---------------------------------------------------------------|
| list skills  | skills available here (company plus the session's projects), with descriptions |
| load skill   | load a skill's full instructions and files into the session   |

### Employee filesystem

Every employee has its **own filesystem**: a persistent space for working
files, notes, drafts, exports and scratch data, separate from any project's
repository.

- **Private by default.** An employee's files are visible only to that
  employee's sessions.
- **Sharing.** A file or a directory can be shared with another employee or a
  person, read-only or read-write. Sharing is a [link](#links-between-contacts-and-projects)
  with a role (`shared_with`) and a permission. Shared files show up under
  `/shared/<owner>/…` for the recipient.
- **Stored in the database** ([database first](#database-first)), as files with
  paths and content, with edit history like other records.
- **Usable in environments.** A session can copy files from its employee's
  filesystem into its checkout or container, and results back out.
- Browsable and editable in the [web UI](#web-ui).

| Tool          | What it does                                            |
|---------------|---------------------------------------------------------|
| fs.list       | list a directory (own files and `/shared`)              |
| fs.read       | read a file                                             |
| fs.write      | write a file                                            |
| fs.move / fs.delete | move or delete a file                             |
| fs.share      | share a file or directory with an employee or person   |

Open questions:

- Size limits per employee, and are large binary files kept in the database or
  in an object store it references?

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

### Policy hooks

Some rules shouldn't depend on the model remembering them. **Policy hooks**
enforce them in the harness, on the [hook points](architecture.md#event-bus-and-hooks)
the runner exposes: before a model call, before and after a tool call, and
before a run finishes. It's the same idea as Claude Code hooks, applied to
every employee.

Built-in policies, each configurable per deployment, employee or project:

- **Docs maintenance.** A run that changed a project's code (commits in its
  worktree) can't finish until the project's docs were updated in the same
  run, or it states why no update is needed. A run can't finish without
  updating its session document.
- **Checklist gate.** A run can't finish as successful while required
  [checklist](#checklists) items are unchecked.
- **Commit on stop.** Uncommitted changes in a session's worktree are
  committed to its branch when the run ends, so no work is lost.
- **Evidence before claims.** A checklist item can't be checked without
  evidence from the session's own history.
- **Tool gates.** The allow and deny lists, and secret injection, run as
  before-tool-call policies.
- **Answer where asked.** A run started by a chat message that ends with a
  final answer, and didn't reply or hand the work off, has its answer posted
  in the thread it was asked in. The session is then subscribed to the
  thread.
- **The agent decides whether to answer.** Not every message needs a reply:
  a thanks, another employee's update, or people talking to each other. Each
  message says whether it came from a person, another AI session, or a local
  AI agent (and whom it acts for). When the
  employee concludes that nothing is needed from it, it ends with `NO_REPLY`
  (optionally with a reason) and nothing is posted. The router doesn't filter
  on the employee's behalf. The [AI-to-AI streak limit](#configurable-limits)
  stays as the safety net.

When a policy blocks, the run gets the reason as a message and carries on:
it fixes the problem (updates the docs, checks the item) and tries again, like
a Stop hook that says "not yet". Policies are ordinary code registered on
hooks, so adding one needs no change to the runner.

### Schedules

Triggers can fire on a **schedule** as well as on events. For example,
"every weekday at 9:00, triage new Linear issues" or "every Friday, write the
weekly summary".

- A schedule trigger has a cron expression and a time zone. At each firing it
  ingests a `schedule.fired` [event](execution.md#events) and routes it like
  any other event, to its context or a fork of it.
- Firings are deduplicated by trigger and time, so a restart or two app
  instances never fire twice. Missed firings while the harness was down are
  not replayed, except the latest one if it was within the trigger's grace
  period.
- Schedules are created and edited in the UI, and by employees themselves
  through `triggers.*` tools.

### Observability

- **Metrics** at `/metrics` in Prometheus format, only for admins or a
  metrics token:
  - runs by state
  - queue depth and age
  - model calls, tokens and latency by model
  - tool calls and errors by tool
  - events by source
  - environments
- **Health:** `/healthz` and `/readyz` (built).
- **Alerts** through chat: failed runs, paused runs that wait longer than a
  threshold, and a provider or MCP server that keeps failing post to an
  `#alerts` channel. The owner or the requester is tagged.

### Evals

The harness keeps a small **eval suite** that runs against a real model:
scenarios with checks on the outcome, not the wording.

- Scenarios:
  - answer in the thread
  - hand off to a fork
  - use a procedure
  - refuse an injected instruction
  - respect a checklist
  - keep answers short
- Run with `npm run eval` against the configured model. The report is a pass
  rate per scenario, with tokens and cost.
- It's run before changing the default model or the employee prompt, and
  after model upgrades: turn harness pieces off one at a time and see what's
  still needed.

### Import and export

- **Import** contacts, projects, memberships and procedures from CSV or JSON,
  with a dry run that shows what would change. Existing records are matched by
  email, handle or name.
- **Export** the company's knowledge (contacts, projects, procedures, skills,
  docs and memories) as a folder of markdown with frontmatter, for backups or
  to keep in git. The same folder can be imported back.

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
  (local AI agents connected over MCP count as AI, not as people)

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

#### The router context

Every employee has one **router context**: the session that new work for the
employee goes to (its triggers, `@employee` tags, and the fallback). It
behaves like a dispatcher with a notebook. Its committed history is a log of
routing **decisions**, one line each, and nothing else.

For every event, a router run:

1. **Checks its decisions.** Is there already a decision for this subject
   (the issue, MR or thread), e.g. "PAY-123 → @meatless#pay-123-refund"?
2. **Existing decision:** it forwards the event to that session with
   `sessions.message`. If the session is gone or done, it decides again.
3. **No decision yet:** it looks around as much as it needs (directory,
   procedures, docs), then either:
   - answers directly, if the request is trivial, or
   - starts a **new session** for the work, with the context that work needs:
     a fork of the router context carrying an instruction, a
     [procedure](#procedures) run, or a session from a template. The new
     session subscribes to the subject, so follow-ups reach it directly
     without the router.
4. **Rolls back with a summary and commits it, for next time.** The run is
   ephemeral, so its exploration is dropped. It commits only a one-line
   decision summary on top of the router's head (`sessions.commit` with a
   summary), e.g. `PAY-123 (Linear, from Ana): refund of a double charge →
   @meatless#pay-123-refund (ses_…)`. The next run starts with it in context.

A [policy hook](#policy-hooks) makes sure no router run ends without
recording its decision. When the log of decisions grows long, the router
[rewinds](#context-management-rewind-not-compaction) old decisions for
finished work into one summary.

Routing inside the router context stays the agent's judgment. Deterministic
routing (subscriptions, session tags) still goes first, so events for a
subject with a subscribed session never reach the router at all.

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
- **Subscriptions never overreach by default.** A subscription without
  explicit event types gets the usual ones for its kind of subject:
  - a chat thread: replies, edits, deletions and reactions (not the root
    message)
  - a Linear issue: comments, state and assignment changes
  - a GitLab MR: comments, pipelines, failed jobs, and MR state
  - Slack: replies, edits, deletions, mentions and reactions

  Every subscription the harness makes on its own uses these defaults: when a
  session starts a thread, replies in one, is handed a subject by a router, or
  owns a real fork's task. Sessions can narrow further with **presets**
  (`people_only`, `conversation`, `outcomes`, `failures`) or their own filter.
  Subscribing to everything is an explicit `all: true`.
- **No catch-all triggers.** A trigger must match something specific: a
  source, a type, a subject or a filter. A trigger matching `{}` (or only
  wildcards) is refused, because catching whatever nothing else claims is the
  job of the fallback, the employee's router.

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

#### Visualisation

The harness is a web of sessions, runs, events and links. The UI has to make
it easy to see what is happening, and why:

- **Session trees.** Forks and loops drawn as an actual tree graph: each node
  is a session with its status, slug, employee and token use. You can zoom,
  collapse subtrees, and click through to any session.
- **Origins.** For any session or run, a **lineage view** showing where it came
  from: the outside event (a Linear issue, a Slack message), the trigger or
  subscription that routed it, the context that handled it, and the forks, loops
  and procedure forks it started. You can follow it both ways: from an event to
  everything it caused, and from a session back to the event that started it.
- **Triggers.** A map of triggers and subscriptions: which sources and event
  types go to which contexts and employees, how often each one fired, and
  recent events per trigger. Events that nothing matched, and that went to the
  router, stand out.
- **History timeline.** A session's history drawn as its entry tree, with
  rewinds, summaries, offloads and pointers shown as branches.
- **Links graph.** For a contact, project, procedure or memory, a graph of what
  it's linked to.

All of these update live over the WebSocket.

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

#### Employees

- **Employee page** (`/employees/<id>`, linked from the employee switcher and
  Settings → Employees): its profile (handle, role, model, router context,
  its accounts in each system), its **SSH public key** with a copy button,
  fingerprint, creation date and **Rotate** (with a confirmation that the
  old key stops working), the [guided setup](#guided-setup) of its
  integrations under a short "how integrations work", and its own MCP
  servers.
- **New employee** (admins), in Settings → Employees and on every employee
  page: a short dialog, then straight to the new employee's page with its
  integrations as the next step. See [adding an employee](#multiple-employees).

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

Most of the sections above are what any serious harness needs. These are the
parts that make meatless-proxy different. Each one is specified in detail in
the section it links to.

### Context that is never lost

- **History is a tree, not a transcript.** Every entry a session ever saw is
  kept, content-addressed and immutable. A session is just a pointer into the
  tree ([execution model](execution.md#history-as-an-entry-tree)).
- **Rewind instead of compaction.** When a context gets heavy, the session
  jumps back to an earlier point and appends a summary of what it did after it.
  The detail stays one lookup away, and the prefix up to the rewind point stays
  cached ([context management](#context-management-rewind-not-compaction)).
- **Offload to documentation.** A message in the history can be replaced by a
  pointer to a chapter in a docs file, written first if needed. The knowledge
  ends up in the project's docs instead of dying with the session.
- **Real compaction only as a last resort**, recorded, and still reversible
  from the stored history.

### Work that forks, fans out and folds back

- **Fork anywhere, loop over anything.** Any session can fork at any point, or
  split into *n* children, one per item. The parent waits for them or doesn't
  ([sessions](#sessions)).
- **Ephemeral or committed runs.** A long-lived context handles each event in
  a run that's discarded afterwards, and only commits what's worth keeping, so
  it stays small for years ([runs](#runs-ephemeral-or-committed)).
- **Procedures as warm contexts.** Each procedure has a context that already
  knows it. Every instance runs in a fork of it: nothing to re-read, and the
  provider's prompt cache is shared ([procedures](#procedures)).
- **Real forks become tasks.** A fork that is real work shows up in the task
  system, where people track work ([runaway protection](#real-forks-go-through-the-task-system)).

### Routing without a person in the middle

- **Triggers to contexts, not to new sessions.** New work goes to the context
  assigned to that kind of work ([triggers](#triggers)).
- **Subscriptions skip routing.** A session working on a ticket, a PR or a
  thread subscribes to it, and replies reach it directly, filtered with JSON
  queries ([subscriptions](#subscriptions)).
- **Harness chat as a routing fabric.** Channels map to contexts, threads to
  sessions, and `@employee#session` tags address one exact session
  ([harness chat](#harness-chat)).
- **Trust follows the route.** Expected input (a subscription, a tag) is
  trusted; anything else is treated critically, the way a person would treat
  an unexpected email ([untrusted input](#untrusted-input)).

### Employees, not agents

- **No single operator.** The harness talks to the whole company. Anyone can
  reach it, and it reaches out to whoever ownership says
  ([principles](#no-single-operator)).
- **Employees as workspaces.** Several AI employees split the company between
  them to keep contexts small. Each has its own identity, SSH key, git store,
  filesystem, memories and personality, and they chat with each other
  ([identity](#multiple-employees)).
- **AI-to-AI, directly.** Other agents, such as a person's own Claude Code or
  another company's harness, connect over MCP and are notified when something
  happens for them ([the harness as an MCP server](#the-harness-as-an-mcp-server)).
- **A self-scripting engine.** The model orchestrates its own work with a
  standard library for a person, plus memory ([self-scripting](#a-self-scripting-engine)).

### Safety that doesn't depend on the model

- **Hard limits outside the model.** No merging or deploying, only PRs.
  Secrets are injected at call time and never shown to it. Containers can only
  reach allowlisted destinations through a proxy.
- **Policies as hooks.** Checklist evidence, docs maintenance, commit on stop,
  budgets and AI-to-AI streak limits are enforced by the harness, not
  requested in the prompt ([policy hooks](#policy-hooks)).
- **Crash safety for the outside world.** A run that crashes resumes from its
  journal and never blindly repeats a Slack post or ticket creation
  ([side effects](execution.md#side-effects)).
