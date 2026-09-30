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
| `src/pages/` | Login (a sign-in link, or single sign-on when the server has OIDC), Inbox, Now, Sessions, Session detail (History, Preview, Branches, Tree, Runs, Checklist, Threads, Usage), Lineage, Triggers, Events, Chat, Employee (profile, SSH key, guided integration setup, its MCP servers), Procedures (list and page, see below), Memory, Skills and People (see below), Projects (with a record's docs), Files, Usage, Settings. Every page is its own chunk (`React.lazy` in `src/app.tsx`) |
| `src/lib/` | pure logic: `tree-layout.ts` (tidy tree), `lineage.ts` (lineage columns), `entry-tree.ts` (entry tree lanes), `schema-form.ts` (forms from kind schemas), `usage-series.ts` (bucket parsing, labels, empty buckets filled with 0), `auth.tsx` (the signed-in person, `RequireAuth`, `Can`, the CSRF cookie), `routing.ts` (matched / unmatched / not delivered), `chat.ts` (DM labels, tag suggestions, reactions, search grouping), `names.ts` (titles of referenced records), `doclinks.ts`, `status.ts`, `format.ts`; `api.tsx` (data provider, `useLoad`, `useLive`) |
| `src/mock/` | a complete in-memory `ApiClient` with fake data and a simulator that streams model output, tool calls, entries, usage, events, chat and new inbox items |
| `scripts/seed-demo.ts` | seeds a small fake company into a running server through the API (no model calls) |
| `scripts/screenshots.ts` | screenshots of every page in dark and light (playwright-core with a system Chromium), with a report of console errors and horizontal scroll |

### Sign-in

Everything but `/login` needs a signed-in person: `RequireAuth` loads `GET /api/me` and sends
everyone else to `/login?next=…`, and any 401 from the API does the same. The session cookie goes
along by itself, and the data layer echoes the `mp_csrf` cookie in `x-mp-csrf`. The sidebar footer
shows who you are and your access, with API tokens and Sign out. Actions your access doesn't allow
are hidden (the server refuses them anyway): viewers get no message boxes, no "New" buttons and
read-only forms; only admins see the kill switch and the admin settings (employees, secrets,
triggers, limits, pricing, people and access with sign-in links, MCP servers). Settings → API tokens creates a token
(shown once), lists and revokes yours. The mock (`VITE_MOCK=1`) is signed in as an admin.

The employee's **Network** control (`src/components/network-setting.tsx`) reads the deployment's
network defaults from `me.deployment` (`useDeploymentNetwork`): an unset setting shows as
"Deployment default (…)" with what that is here, and choosing it saves `network: null`, which
clears the field. Where direct networks are off, it says a direct setting means no network.

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
with the `RecordPicker` and a role (`RoleSelect`: member, reviewer or owner), remove one, or press **New project**.
`src/components/new-project-dialog.tsx` is that dialog (name, description, repository URLs, docs links, an employee
owner, preset to the page's employee) over `POST /api/projects`; the Projects list's **New project** opens it too,
instead of the generic record form. A project's page shows `ProjectPeopleSection`
(`src/components/project-people.tsx`): the employees and people on it, owners first, with the same add and remove.
Admins can pick **Local repository** in the dialog (`POST /api/projects/local`): the harness hosts the repository. A
local project's page then has `LocalRepositorySection` (`src/components/local-repository.tsx`,
docs/spec.md#local-projects): **To review** lists the branches ahead of `main`, each opening its commits, changed files
and coloured diff with **Merge** (a 409 shows the conflicting files) and **Delete branch** (confirmed) for those who
can merge; merged branches fold away; **Files** browses `main` read-only; admins get **Attach a remote** (URL, optional
https URL, whose SSH key pushes). The mock (`src/mock/projects.ts`) models local repositories in memory;
`mockPushBranch` adds a branch as an employee's push would.
In GitLab's setup, the projects step (`src/components/gitlab-projects.tsx`) shows which GitLab projects are already
harness projects of the employee, with **Add as project** per row and **Add selected** (`add-projects`). Admins get
the whole list from `gitlabProjects` (a debounced server-side search, **Load more** with the total, an All / Not added
/ Added filter, and a selection kept across pages and searches, added in batches of 50); each row's default branch is
checked through `gitlabProjectProtection`, four at a time. Members see the status check's first page, read-only.
`RecordPicker` takes a `filter`, so AI contacts aren't offered twice next to employees. The mock
(`src/mock/projects.ts`) keeps assignments as links like the server, and its GitLab account reaches
`acme/payments-api` (already the Payments project), `acme/invoices` and `acme/infra`, then 150 more
(`src/mock/gitlab-projects.ts`, some Maintainer or Owner, some with an unprotected or no default branch).

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

### Memory, skills and people

Over the typed knowledge API (`@mp/api` `KNOWLEDGE_ROUTES`), not the generic records:

- **`/memory`** (`src/pages/memory.tsx`): an explainer, a filter bar (search, employee or shared, kind, what it's about,
  who taught it, about me, sort; in the URL, with counts from the server's facets) and a row per memory: its kind icon,
  a lock when it's personal, the summary, chips for people and projects, the employee, when it was learned and last
  used. **`/memory/:id`** opens it in a drawer: details, who remembers it, what it's about, when it comes up, where it
  came from (person, session, message), last use, history with correction notes, and **Correct it** (a required note),
  **Edit**, **Still true** and **Forget** (confirmed). **Add memory** (`src/components/new-memory-dialog.tsx`, members):
  summary, kind, details, who remembers it, what it's about and when it comes up, with a note when it's about a person.
- **`/skills`** (`src/pages/skills.tsx`): an explainer, then company-wide skills and each project's, with what each helps
  with, when to use it, who used it lately, "off" and "replaces company". **`/skills/:id`**: the instructions with an
  editor with a live preview (`steps-editor.tsx`), **Versions** with restore, **Edit** (name, description, when to use
  it, where it applies), an on/off switch, usage, procedures naming it, **Download SKILL.md**, **Duplicate**, **Delete**.
  **New skill** / **Import** (`src/components/new-skill-dialog.tsx`): from a template, or a pasted or uploaded `SKILL.md`.
- **`/contacts`** ("People", `src/pages/people.tsx`): people, AI employees and agents in tabs, access and team filters,
  deactivated on request, search over names, emails, teams and handles; rows with the avatar, title, email and handles,
  projects, access and last sign-in (admins). AI employees link to their employee page. **Add person**
  (`src/components/new-person-dialog.tsx`, admins): name, email, access, title, team, manager, handles and **Send a
  sign-in link** (shown to copy, and sent as a Slack DM when possible). **`/contacts/:id`**: profile, projects, memories
  about them (count and a link to the filtered Memory page), recent requests, API tokens (list and revoke), and a side
  panel with access, sign-ins, **Sign-in link** and **Deactivate** / **Reactivate** (confirmed).

The mock (`src/mock/knowledge.ts`, data in `src/mock/knowledge-data.ts`) applies the same memory privacy and access rules
as the server, with thirteen memories (personal ones, one corrected), seven skills (one switched off, one project skill
replacing a company one, one with three versions), people with access and handles, a deactivated person, a local agent,
sign-ins, tokens and when employees used each memory and skill.

### Notifications

`NotificationsProvider` (`src/lib/notifications.tsx`, mounted in the app shell) holds the inbox for the Inbox
page and the sidebar badge, and subscribes to `person:<contactId>`. A new `inbox.item` is added to the list and
told, unless its channel is muted: a toast (`src/components/inbox-toast.tsx`: avatar, name with an AI badge,
place, two lines, Open / Mark read; warning style for paused runs, limits and alerts), a WebAudio chime and a
desktop notification while the tab is hidden, as the person's preferences say. There's no toast while the
visible page shows that channel, thread or session; more than 3 within 10 s become one grouped toast
(`Burst`, `src/lib/notify.ts`). `inbox.read` from any tab marks items read and dismisses their toasts. The
unread count is in the badge and the document title. Settings → Notifications
(`src/components/notification-settings.tsx`) edits the preferences (`GET/PUT /api/me/notifications`): toasts,
desktop (asks for permission, explains a refusal), hide DM text, sound, and muted channels from a picker.
The mock (`src/mock/notifications.ts`) keeps the preferences in memory and has a notifier that sends a
mention, reply, DM, paused run or alert: every 45 s in `dev:mock` (`window.mpMock.notifier` has `push()`,
`start(ms)` and `stop()`), and only on `data.notifier.push()` in tests.
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

### Environments and desktops

`src/pages/environments.tsx` is `/environments` (sidebar, `G` `V`): every running environment the
viewer may see (`GET /api/environments`), grouped by employee, with its session, what it runs (the
profile badge or a build badge, the image and its size, and on wide screens the profile's description;
the full image in a tooltip), its session's state and idle time (`done · idle 23h`), network, previews,
desktop, uptime, the `env.exec` in progress with its elapsed
time, and live metrics (CPU, memory used / limit, network, PIDs), updated from `env.stats` on the
`environments` channel (`env.changed` reloads the list). Filters (employee, following the switcher,
and "With desktop") live in the URL. Each row opens a drawer (`src/components/environment.tsx`) with
the logs (refreshed every 3 s), the processes per container (on demand), per-container metrics, the
image (reference, profile and what it has, how it was built and on what, ID, digest, size, build date,
platform, source) and the details (session state, activity, limits); Stop (only with `canStop`) asks
first. Admins get **Stop idle** in the filter bar: it lists what has been idle an hour or more (a dry
run of `POST /api/environments/stop-idle`) and stops those after a confirmation. On a phone the row
keeps the title, state icon and actions. Desktop environments get a live view-only thumbnail
card that opens the full viewer. `src/components/desktop-viewer.tsx` is `<DesktopViewer>`: it mints a
single-use desktop token (`POST /api/environments/:id/desktop`) and frames the viewer on the preview
origin with the preview sandbox, view-only by default, with **Take control** for admins and the
session's requester (`canControl`), Reload and New tab (a fresh token). The session page has an
**Environment** card in its properties panel, and its Preview tab shows the desktop
(`?tab=preview&desktop=1`, or a Desktop / App switch when there are ports too). The mock
(`src/mock/environments.ts`) has four environments (a dev server with a database behind the proxy, a
desktop, a direct network, and one built from a Dockerfile, left running by a session that finished
yesterday) whose metrics move every 5 s.

### Schedules

`src/pages/schedules.tsx` is `/schedules` (sidebar under Routing, next to Triggers; `G` `H`): every scheduled task
and pending follow-up (`GET /api/schedules`, following the employee switcher), grouped Upcoming, Paused and
Finished, with All / Tasks / Follow-ups tabs. A row shows the instruction, the schedule in words with its time zone,
the next run ("next in 3h", the exact local time on hover), the last run's state, age and output linked to its
session, the report target and the employee; on a phone the facts wrap under the title. With `canManage` (admins and
the person who asked) a row has Run now (tasks only), Pause / Resume, Edit and Delete (after a confirmation).
**New scheduled task** (members) and Edit open `ScheduleDialog`: the employee, the instruction, Once (a date-time
picker) or Recurring (every weekday, day, week on a day, month on a day, every hour, or custom cron), the time zone
(the browser's by default), where to report (a channel, optional) and a fresh session per run; the preview asks the
server (`GET /api/schedules/preview`) and shows the schedule in words and its next firings, or why it's refused.
Form helpers are in `src/lib/schedules.ts`; the mock (`src/mock/schedules.ts`) has six tasks in every state and a
small stand-in for the server's cron math.

### Sessions list

`src/pages/sessions.tsx` is `/sessions`: status tabs, a text search, Sort (recent activity, newest, oldest,
title A–Z) and Group by (status, employee, tree) on the first line; Employee, Project, Requested by (a
`RecordPicker` over contacts, then the person with a clear button), Started from, "Hide finished routers" and
Clear filters on the second, with the count. Everything is in the URL (`filter`, `q`, `sort`, `group`,
`employee`, `project`, `requester`, `origin`, `retired=1`). The page's `?employee=` wins over the sidebar's
employee switcher (`all` means every employee) and leaves the switcher alone; without it the list follows the
switcher. The server filters, sorts and pages (100 rows a page, "Load more"); the status tabs filter what's
loaded. Rows (36 px) show the last activity with the exact time on hover, the requester's avatar and the
project tag. Grouping and sorting are pure functions in `src/lib/session-list.ts` (`groupSessions`,
`compareSessions`). The mock mirrors the server in `src/mock/session-list.ts`, which also seeds sessions from
every origin across the employees and projects, and a retired router.

### Chat

Slack-like, per the spec's "Everyday chat features": channels, DMs and threads; `/`
focuses message search (results grouped by channel, a click opens the message in its
thread, highlighted); `@` suggests employees, their active sessions (`@employee#slug`)
and people, keyboard navigable; unread counts and a mentions badge per channel, marked
read while a channel or thread is open and the tab is visible; edit and delete your own
messages ("(edited)", "message deleted"); reactions (✅ 👀 👍 ❤️ 🎉 ❌) as chips that
toggle; "New message" opens a DM with any employee or person.

Activity (`components/chat-activity.tsx`, `lib/chat-activity.ts`): under each message in a channel, and at the
bottom of a thread, `ActivityRows` shows who the thread set to work: a spinner (a static dot with reduced motion),
the employee's avatar, "Billing Bot #pay-123-refund is working…" (or queued, waiting, or paused in the warning
colour) and the current step; a click opens the session; three or more collapse into "3 working".
`useChatActivity(channelId)` loads `GET /api/chat/channels/:id/activity` and follows `chat.activity` and
`chat.activity.done`: a hand-off briefly says "Handed to @…#…", "looked, no reply needed" stays 10 s, a failure
stays with a link to the session's runs, and "Nobody picked this up" hints to tag someone or use #requests. A
message you send that should set someone to work (`expectsWork`: it tags an employee or session, it's in a DM
with an employee or a channel routed to a context, or it replies in a thread an AI is in) says "Delivering…"
until the first news about its thread (30 s at most). The mock (`mock/chat-activity.ts`) seeds workers on the
PAY-123, deploy and staging-disk threads; tagging an employee there (or posting in #billing) has its router pick
the message up, hand it to a new session that answers in the thread, and a "thanks" gets a look and no reply.

Attachments (`components/chat-attachments.tsx`): the composer (channels and threads) has an
attach button (a paperclip, "Attach files") and takes pasted and dropped files of any type,
uploading each at once (`usePendingAttachments`: image thumbnails or file tiles with progress
and remove; at most 10, 10 MB each, no empty files; the server types them by content). A message
(`AttachmentGrid`) shows its images as thumbnails (one image larger; a click opens `Lightbox`:
Esc closes, ←/→ move, download link) and other files as chips (`FileAttachment`: an icon by
type, the name, the size, a Download link); a text file up to 256 KB also gets `TextPreview`
(`api.attachmentText`): the first 8 lines in a `<pre>`, "Show all N lines" to expand, rendered
as text, never HTML. A saved
description is the image's alt text and the lightbox caption (`DescriptionCaption`:
"Description (AI)", or edited by a person; the visible text behind a toggle; edit, clear and
redo for whoever the server's `canEdit` allows). The mock keeps
uploads as object URLs (text files also as their text) and seeds images on the PAY-123 thread
and the staging disk incident, two of them with descriptions, plus a `free-disk.sh` script on
the incident (`mock/attachments.ts`).

Files (`pages/files.tsx`): an employee's files as a tree, read and edited in place (markdown rendered;
binary files shown with their size and a Download, never as text). The line above the tree names the
current directory: the folder last opened (closing one goes back to its parent), or the folder of the open
file. People who may write there (admins anywhere but `/shared`, members under a `write` share) get an
Upload button with a multi-file picker, and can drop files onto the list: onto a folder row to upload into
that folder, anywhere else into the current directory. `useFileUploads` (`components/file-upload.tsx`)
lists the directory first and asks before replacing a file that's there (Replace, Skip existing, Cancel),
then sends the files one at a time as base64 (`api.writeFile(…, { encoding: 'base64' })`, version `0` for
a new file so one that appeared meanwhile isn't overwritten), with a panel of their states, bytes sent and
errors (over 10 MB is refused before sending). The listing reloads after. The mock's `writeFile` takes the
encoding, the version-0 rule, the 10 MB limit and refuses non-admins, like the server.

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
`sessions-list.test.tsx`: the Sessions list's sort (rows in every group, the URL, trees by latest activity),
filters (project, started from, requester, employee, finished routers) through the URL, Clear filters, the empty
state, and the mock API's filters and origins.
`notifications.test.tsx`: a toast for a new item (Open, Mark read), none while viewing its thread or channel
(but one when the tab is hidden), grouping, the warning style, the badge and title from new items and other tabs'
reads, muted channels, toasts off, desktop notifications only while hidden (a click opens the item, DM text
hidden on request, never without permission), and Settings → Notifications (toggles, muting, a refused permission).
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
`knowledge.test.tsx`: Memory (explainer, rows, filters, members not seeing others' memories, the drawer with source
and history, a correction needing a note, forgetting after a confirmation, adding one about a person, viewers without Add),
Skills (grouping, when to use, usage, off and replaces-company marks, New skill from the template and a taken name,
importing a SKILL.md, editing with the preview, versions and restore, switching off, SKILL.md parsing), and People (the
list and its filters, Add person with a Slack-sent link, members without Add, a person's page with memories, requests
and tokens, revoking a token, changing access, a sign-in link, deactivating after a confirmation, editing handles, and
what members don't see).
`chat-activity.test.tsx`: the activity state (delivering, outcomes and their notices, expiry, load, `expectsWork`)
and the chat page: a worker under its message updating live to paused and failed, "3 working", "Delivering…"
replaced by the router and then the hand-off, nothing for plain chat, and a static dot with reduced motion.
`schedules.test.tsx`: the form's cron presets and back, the mock's words and next firings, the page's groups, words,
next runs and last runs linked to sessions, the Follow-ups tab, Run now, Pause/Resume and Delete, creating a
recurring task from a preset with the preview, a one-off, a refused cron, and what members, viewers and admins may do.
`auth.test.tsx`: signed-out people land on the login page (and a later 401 sends them there),
login errors and the single sign-on button, the sidebar's user menu and sign-out, what viewers,
members and admins see (kill switch, settings sections, chat message box), and the tokens page.

## Notes

- Cost shows "no pricing configured" (or `—` in tables) when calls were made but cost
  nothing, instead of `$0`; on the usage page admins get a link to Settings → Pricing.
- Settings → Limits (`src/components/limits-settings.tsx`): the effective limits of every employee,
  each employee and each requester with an override, in plain words ("Max 8 runs at once per
  employee"), each marked default or override, with a small bar of usage against each daily budget;
  the overrides with create, edit and delete (target, fields with "No limit", the budget period,
  checked before sending). Settings → Pricing (`src/components/pricing-settings.tsx`): the models in
  use with their price and where it comes from, the prices set here (per model: input, cached input,
  output per 1M tokens), and the built-in and `PRICING` tables to copy from.
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
