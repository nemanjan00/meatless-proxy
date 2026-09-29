# Security

meatless-proxy runs AI employees that act on company systems, so security
reports are taken seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository. You'll get a reply,
and a fix or a plan, as soon as possible.

Include what you found, how to reproduce it, and what an attacker could do
with it.

## What's in scope

The harness itself: the server, API, WebSocket, MCP server, runner, tools, and
the Docker, git and secrets adapters. The areas that matter most:

- **Prompt injection** that makes an employee act beyond what the requester
  may ask for, or leak data, despite the [untrusted input rules](docs/spec.md#untrusted-input).
- **Crossing the hard limits:** pushing to protected branches, merging,
  deploying, or reaching production (see [no production access](docs/spec.md#no-production-access)).
- **Secrets** reaching the model, logs, the history or the UI.
- **Container escapes or egress** past the proxy allowlist.
- **Authentication and access control** in the web UI, API, WebSocket or MCP
  server.

## Known, accepted risks

- The app container has the host's **full Docker socket** (see
  [deployment](docs/execution.md#deployment)), which is root-level control of
  that host. Run it on a host dedicated to it.
- An employee's permission decisions are the model's judgment and are
  **not deterministic** ([permissions](docs/spec.md#permissions)). The hard
  limits above are what must hold regardless.
