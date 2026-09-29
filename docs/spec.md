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
| `owner`       | contact id                    | the person accountable for the project |
| `members`     | list of {contact id, role}    | role on this project, e.g. `reviewer`  |
| `links`       | list of {system, ref}         | repos, task boards, chat channels      |

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

## Unique features

_None specified yet._
