# @mp/web

The web UI (layer L6): Vite, React 19, TypeScript, Tailwind CSS v4 and shadcn/ui,
styled after Linear per [docs/stylebook.md](../../docs/stylebook.md). It depends
only on `@mp/api`.

```sh
npm run dev -w @mp/web          # against the server on :3000 (Vite proxies /api, /auth, /healthz, /readyz and /ws)
npm run dev:mock -w @mp/web     # with the in-browser mock API and live stream (VITE_MOCK=1)
npm run build -w @mp/web        # typecheck + build into packages/web/dist
npm run build:mock -w @mp/web && npm run preview -w @mp/web
npm test -w @mp/web             # vitest (jsdom), project "web"
```

The build splits the app by route, plus vendor chunks for React, the UI kit, charts
(recharts) and markdown (react-markdown/remark), so the first load only fetches the shell
and the page it opens.

## Structure

| Path | What |
|------|------|
| `src/styles/globals.css` | the stylebook tokens verbatim (`:root` / `.dark`), shadcn's `@theme inline` mapping, extra Linear tokens (`text-fg-tertiary`, `bg-level-2`, status colours), the type scale (`text-tiny` … `text-title3`), 510/590/680 weights, focus, selection, motion |
| `src/components/ui/` | shadcn/ui components (generated with `npx shadcn add`, then tuned for density: 13 px menus and buttons, 32 px buttons, 2 px accent focus ring) |
| `src/components/` | app shell (sidebar, employee switcher, ⌘K command menu that also finds chat messages, `G`-then-key shortcuts), status icons, history timeline, recent ephemeral runs, session tree graph, entry tree, links graph, schema-generated properties form (lists of objects shown readably, raw JSON on edit; references are picked by name with `<RecordPicker kinds>`, a typeahead over `GET /api/records/:kind?text=`, never typed as ids), markdown document editor, charts, chat composer (`@` autocomplete) and chat message (reactions, edit, delete), split view (stacks on phones) |
| `src/pages/` | Login (a sign-in link, or single sign-on when the server has OIDC), Inbox, Now, Sessions, Session detail (History, Preview, Branches, Tree, Runs, Checklist, Threads, Usage), Lineage, Triggers, Events, Chat, Employee (profile, SSH key, guided integration setup, its MCP servers), Procedures (list and page, see below), Projects / Contacts / Skills / Memory (with a record's docs), Files, Usage, Settings. Every page is its own chunk (`React.lazy` in `src/app.tsx`) |
| `src/lib/` | pure logic: `tree-layout.ts` (tidy tree), `lineage.ts` (lineage columns), `entry-tree.ts` (entry tree lanes), `schema-form.ts` (forms from kind schemas), `usage-series.ts` (bucket parsing, labels, empty buckets filled with 0), `auth.tsx` (the signed-in person, `RequireAuth`, `Can`, the CSRF cookie), `routing.ts` (matched / unmatched / not delivered), `chat.ts` (DM labels, tag suggestions, reactions, search grouping), `names.ts` (titles of referenced records), `doclinks.ts`, `status.ts`, `format.ts`; `api.tsx` (data provider, `useLoad`, `useLive`) |
| `src/mock/` | a complete in-memory `ApiClient` with fake data and a simulator that streams model output, tool calls, entries, usage, events and chat |
| `scripts/seed-demo.ts` | seeds a small fake company into a running server through the API (no model calls) |
| `scripts/screenshots.ts` | screenshots of every page in dark and light (playwright-core with a system Chromium), with a report of console errors and horizontal scroll |

### Sign-in

Everything but `/login` needs a signed-in person: `RequireAuth` loads `GET /api/me` and sends
everyone else to `/login?next=…`, and any 401 from the API does the same. The session cookie goes
along by itself, and the data layer echoes the `mp_csrf` cookie in `x-mp-csrf`. The sidebar footer
shows who you are and your access, with API tokens and Sign out. Actions your access doesn't allow
are hidden (the server refuses them anyway): viewers get no message boxes, no "New" buttons and
read-only forms; only admins see the kill switch and the admin settings (employees, secrets,
triggers, limits, people and access with sign-in links, MCP servers). Settings → API tokens creates a token
(shown once), lists and revokes yours. The mock (`VITE_MOCK=1`) is signed in as an admin.

`src/components/mcp-servers.tsx` is `<McpServers employeeId? />`: the MCP servers of an employee, or
the global ones without `employeeId` (Settings → MCP servers mounts that one), for admins only. It
shows each server's status, auth and tools, connects OAuth (the server's callback comes back with
`?mcp_oauth=connected|error`, shown as a toast), and adds or edits servers; token and client secret
values are write-only, never pre-filled. The mock (`src/mock/mcp.ts`) has a config server, a global
token server and an employee's OAuth server that needs a sign-in; its Connect signs in at once.

### Employees and guided setup

`src/pages/employee.tsx` is `/employees/:id`, linked from the employee switcher and Settings →
Employees: the profile, the SSH public key (copy, fingerprint, created, Rotate with a confirmation),
the Integrations section and `<McpServers employeeId>`. `src/components/integration-setup.tsx` has a
card per integration (Not set up / Needs attention / Connected, from the server's checks) that opens a
step-by-step panel: each step's status, what the server found, the documentation from
`src/lib/setup-docs.ts`, values to copy (`src/components/copy.tsx`), a secret form (write-only,
validated by the server) and the step's action. `?setup=<integration>` opens a panel. Members see it
read-only. `src/components/new-employee-dialog.tsx` is the **New employee** button and dialog (admins):
the handle follows the name until edited, a taken handle is shown on the field, and a created employee
opens its page with `?new=1`. Settings → Integrations is an overview linking to each employee's setup.
The mock (`src/mock/setup.ts`) has Slack connected, GitLab needing attention and Linear not set up for
the demo employee.

### Projects and who works on them

The employee page's **Projects** section (`src/components/employee-projects.tsx`) lists the projects the employee
works on (`GET /api/employees/:id/projects`) with its roles, each owner and repository; members and admins add one
with the `RecordPicker` and a role (`RoleSelect`: member or owner), remove one, or press **New project**.
`src/components/new-project-dialog.tsx` is that dialog (name, description, repository URLs, docs links, an employee
owner, preset to the page's employee) over `POST /api/projects`; the Projects list's **New project** opens it too,
instead of the generic record form. A project's page shows `ProjectPeopleSection`
(`src/components/project-people.tsx`): the employees and people on it, owners first, with the same add and remove.
In GitLab's setup, the projects step (`src/components/gitlab-projects.tsx`) shows which GitLab projects are already
harness projects of the employee, with **Add as project** per row and **Add selected** (`add-projects`).
`RecordPicker` takes a `filter`, so AI contacts aren't offered twice next to employees. The mock
(`src/mock/projects.ts`) keeps assignments as links like the server, and its GitLab account reaches
`acme/payments-api` (already the Payments project), `acme/invoices` and `acme/infra`.

### Procedures

`src/pages/procedures.tsx` over the typed procedures API (`@mp/api` `PROCEDURE_ROUTES`), not the generic records:

- **`/procedures`**: a one-line explainer, then a row per procedure with its purpose, how it starts (from its enabled
  triggers, in plain words, or "Manual only"), owner, approvals, runs in the last 30 days, the last run's state and
  time, and the context state (Ready / Out of date / Not built). Search, an owner filter, archived ones on request,
  and an empty state with **New procedure**. Narrow screens fold the columns into one line of facts.
- **`/procedures/:id`**: the name, purpose, owner and the employee it runs as, with **Run now**, **Edit** (name,
  purpose, owner), **Duplicate** and **Archive** / **Unarchive**. **When it runs** lists "whenever someone starts it"
  and each trigger as a sentence ("When someone posts in #deploys", "Every Monday at 09:00 (Europe/Belgrade)"),
  with an on/off switch, an inline editor and remove for admins, and **Add a trigger**. **Steps** renders the body;
  **Edit steps** opens `StepsEditor` (textarea and live preview side by side, Write / Preview tabs under 1024 px);
  saving is a new version, and **History** lists versions with who changed what, reads any of them and restores
  its steps. **Runs** lists each instance (a fork of the context): state, who or what started it (a trigger, a
  person's Run now, another session), when, how long, its outcome, linked to the session. The side panel has the
  **Context** (state and why, when it was built and from which version, the session, **Rebuild context** or
  **Build context**), **Approvals** (who approves at which step, edited inline, and runs waiting now) and details.
  Everything reloads on live `records:procedure|run|session|trigger` events.
- **New procedure** (`src/components/new-procedure-dialog.tsx`): what it is (name, when it applies, the employee
  that runs it, an owner from `RecordPicker`), the steps from a template (When to use, Steps, Done when, Escalate
  if), how it starts (admins; members are told it starts manually) and approvals (a person or a role, with the step).
  One `createProcedure` call with an idempotency key per opening, so a double submit makes one procedure; then its
  page. **Duplicate** opens it prefilled.
- `src/components/start-form.tsx` builds a `ProcedureStart` from choices (a channel from the channel list, an @tag, a
  schedule preset or cron with a time zone, a GitLab / Linear / Slack event with its field, or another source), with
  the raw filter under **Advanced**, and says what it built in a sentence (`describeStart`). The server's catch-all
  refusal shows under the form.

The mock (`src/mock/procedures.ts`, data in `src/mock/procedures-data.ts`) has six procedures: channel, @tag,
schedule, GitLab and Linear triggers and a manual-only one; a month of instances in every state; and contexts that
are ready, out of date after an edit, or not built.

Chat shows a router context's messages as the employee (its name, `@handle` quieter, the AI badge), and `@`
suggestions leave router contexts out.

Data comes from `@mp/api`'s `createApiClient` and `createLiveClient`; pages load over
HTTP and apply live events from `/ws` (streamed deltas are applied in place, chat
messages, edits, deletions and reactions are replaced in place, other changes trigger a
debounced reload). With `VITE_MOCK=1` the same interfaces are served by `src/mock`.
Placeholders, hints and examples come from real records (employee handles, people's
chat handles) or are generic; nothing outside `src/mock` knows a mock name.

### Live previews

The session page has a **Preview** tab while the session's environment exposes ports
(`GET /api/sessions/:id/preview`), in `src/components/preview-panel.tsx`: a port picker, the frame with
`sandbox="allow-scripts allow-forms allow-same-origin"` (safe because previews have their own origin,
see docs/spec.md "Live previews"), the running commit as a badge, Reload and Full screen. Every load,
reload and full-screen tab mints its own short-lived token (`POST /api/previews/token`) and uses its
`url`, which exchanges the token for the preview origin's cookie; the harness cookie never goes there.
A `preview.commit` live event reloads the frame on the new commit. Viewers see a note instead of the
frame (tokens are for members). `?tab=preview&port=5173` opens the tab on a port, which is the link
`env.preview` gives employees. The mock serves a static `data:` page per port and moves the demo
commit now and then.

### Chat

Slack-like, per the spec's "Everyday chat features": channels, DMs and threads; `/`
focuses message search (results grouped by channel, a click opens the message in its
thread, highlighted); `@` suggests employees, their active sessions (`@employee#slug`)
and people, keyboard navigable; unread counts and a mentions badge per channel, marked
read while a channel or thread is open and the tab is visible; edit and delete your own
messages ("(edited)", "message deleted"); reactions (✅ 👀 👍 ❤️ 🎉 ❌) as chips that
toggle; "New message" opens a DM with any employee or person.

Images (`components/chat-attachments.tsx`): the composer (channels and threads) has an
attach button and takes pasted and dropped images, uploading each at once
(`usePendingAttachments`: thumbnails with progress and remove; only PNG, JPEG, GIF and
WebP, at most 10); a message shows its images as thumbnails (`AttachmentGrid`, one image
larger) and a click opens `Lightbox` (Esc closes, ←/→ move, download link). The mock keeps
uploads as object URLs and seeds images on the PAY-123 thread and the staging disk incident
(`mock/attachments.ts`).

## Screenshots (real server, seeded demo data)

Taken against the real server with `scripts/seed-demo.ts`, three real requests (two in
#requests, one DM) answered by the model, and `scripts/screenshots.ts`:

```sh
DATABASE_SCHEMA=demo MP_BOOTSTRAP=1 PORT=3113 npx tsx packages/server/src/main.ts
# sign in with the link it logs, make an API token in Settings → API tokens, then:
export MP_TOKEN=mpt_…
npx tsx packages/web/scripts/seed-demo.ts http://localhost:3113
# … post a few requests in #requests and a DM, then:
npx tsx packages/web/scripts/screenshots.ts --base http://localhost:3113            # the README set
npx tsx packages/web/scripts/screenshots.ts --base http://localhost:3113 --all --width 390 --out /tmp/shots
```

| | Dark | Light |
|-|------|-------|
| Sessions | ![](docs/screenshots/sessions-dark.png) | ![](docs/screenshots/sessions-light.png) |
| Session detail | ![](docs/screenshots/session-detail-dark.png) | ![](docs/screenshots/session-detail-light.png) |
| History with ephemeral runs | ![](docs/screenshots/session-history-dark.png) | ![](docs/screenshots/session-history-light.png) |
| Entry tree (branches) | ![](docs/screenshots/entry-tree-dark.png) | ![](docs/screenshots/entry-tree-light.png) |
| Session tree | ![](docs/screenshots/session-tree-dark.png) | ![](docs/screenshots/session-tree-light.png) |
| Lineage | ![](docs/screenshots/lineage-dark.png) | ![](docs/screenshots/lineage-light.png) |
| Triggers | ![](docs/screenshots/triggers-dark.png) | ![](docs/screenshots/triggers-light.png) |
| Chat thread | ![](docs/screenshots/chat-dark.png) | ![](docs/screenshots/chat-light.png) |
| Chat `@` autocomplete | ![](docs/screenshots/chat-autocomplete-dark.png) | ![](docs/screenshots/chat-autocomplete-light.png) |
| Chat search | ![](docs/screenshots/chat-search-dark.png) | ![](docs/screenshots/chat-search-light.png) |
| DM with a reaction | ![](docs/screenshots/chat-dm-dark.png) | ![](docs/screenshots/chat-dm-light.png) |
| Project | ![](docs/screenshots/project-dark.png) | ![](docs/screenshots/project-light.png) |
| Usage | ![](docs/screenshots/usage-dark.png) | ![](docs/screenshots/usage-light.png) |

## Tests

`test/*.test.ts(x)` (vitest, jsdom, Testing Library): tree layout (no overlaps,
centring, collapse), lineage builder (columns, longest path, cycles, origin chain),
entry tree rows (lanes, rewound/offloaded/run branches), schema form generation and
parsing, the API and live clients (mock WebSocket), the mock API (contract
behaviour, CAS conflicts, live events, simulator), and page renders against the mock
(Now streaming, Sessions filters, Session detail and tree collapse, Branches,
Lineage, Triggers, Chat posting, Usage, a project's generated form, Secrets, Inbox), and
`polish.test.tsx`: usage buckets and labels, routing outcomes, recent-run summaries, chat
helpers (tag suggestions, DM labels, reactions, search grouping), label and link helpers,
and the chat page's autocomplete, search, reactions, edit, delete, new DM and unread badges.
`employee.test.tsx`: the employee page (profile, SSH key, card states), the GitLab panel and "Add it for me", the
secret form (a refused token, a stored one never shown again), members read-only, rotating the key, the new
employee dialog (derived handle, a taken handle, a missing name), and the Settings → Integrations overview links.
`projects.test.tsx`: the employee page's Projects section (roles, owner, remove, add with a role, empty, read-only
for viewers), the New project dialog (owner preset, repositories and docs, a missing name, a taken name, from the
Projects list with a picked owner), a project's people (owners first, the AI badge and handle, adding an employee, no
duplicate AI contacts), and GitLab's Add as project.
`procedures.test.tsx`: the list (starts, owners, approvals, context states, search, owner filter, empty state), the
page (triggers in words, approvals, runs, rebuilding an out-of-date context, Run now linking to the run, adding a
schedule trigger, the catch-all message, editing steps with the preview and a new version, history, archiving,
read-only for viewers), and New procedure (one call, once on a double submit, template, @tag, a role approver; a
missing name or purpose; members told about triggers).
`auth.test.tsx`: signed-out people land on the login page (and a later 401 sends them there),
login errors and the single sign-on button, the sidebar's user menu and sign-out, what viewers,
members and admins see (kill switch, settings sections, chat message box), and the tokens page.

## Notes

- Cost shows "no pricing configured" (or `—` in tables) when calls were made but cost
  nothing, instead of `$0`.
- Usage over time fills empty buckets with 0 (hours for 24 hours, days for 7 and 14 days)
  and draws a lone bucket as a bar.
- Chart colours use the stylebook's `--chart-*` tokens in the order 1, 3, 2, 5, 4
  so indigo and blue are never adjacent; more than five series fold into "Other".
  The tokens themselves fail a strict lightness-band check, so charts always carry
  a legend and a breakdown table.
- The markdown editor is a plain textarea with a live preview, the stylebook's open
  question.
- `biome.json` here only enables Tailwind directives for the CSS parser; it extends
  the root config.
