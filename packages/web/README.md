# @mp/web

The web UI (layer L6): Vite, React 19, TypeScript, Tailwind CSS v4 and shadcn/ui,
styled after Linear per [docs/stylebook.md](../../docs/stylebook.md). It depends
only on `@mp/api`.

```sh
npm run dev -w @mp/web          # against the server on :3000 (Vite proxies /api, /healthz, /readyz and /ws)
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
| `src/components/` | app shell (sidebar, employee switcher, ⌘K command menu that also finds chat messages, `G`-then-key shortcuts), status icons, history timeline, recent ephemeral runs, session tree graph, entry tree, links graph, schema-generated properties form (lists of objects and references shown readably, raw JSON on edit), markdown document editor, charts, chat composer (`@` autocomplete) and chat message (reactions, edit, delete), split view (stacks on phones) |
| `src/pages/` | Inbox, Now, Sessions, Session detail (History, Branches, Tree, Runs, Checklist, Threads, Usage), Lineage, Triggers, Events, Chat, Projects / Contacts / Procedures / Skills / Memory (with a record's docs), Files, Usage, Settings. Every page is its own chunk (`React.lazy` in `src/app.tsx`) |
| `src/lib/` | pure logic: `tree-layout.ts` (tidy tree), `lineage.ts` (lineage columns), `entry-tree.ts` (entry tree lanes), `schema-form.ts` (forms from kind schemas), `usage-series.ts` (bucket parsing, labels, empty buckets filled with 0), `routing.ts` (matched / unmatched / not delivered), `chat.ts` (DM labels, tag suggestions, reactions, search grouping), `names.ts` (titles of referenced records), `doclinks.ts`, `status.ts`, `format.ts`; `api.tsx` (data provider, `useLoad`, `useLive`) |
| `src/mock/` | a complete in-memory `ApiClient` with fake data and a simulator that streams model output, tool calls, entries, usage, events and chat |
| `scripts/seed-demo.ts` | seeds a small fake company into a running server through the API (no model calls) |
| `scripts/screenshots.ts` | screenshots of every page in dark and light (playwright-core with a system Chromium), with a report of console errors and horizontal scroll |

Data comes from `@mp/api`'s `createApiClient` and `createLiveClient`; pages load over
HTTP and apply live events from `/ws` (streamed deltas are applied in place, chat
messages, edits, deletions and reactions are replaced in place, other changes trigger a
debounced reload). With `VITE_MOCK=1` the same interfaces are served by `src/mock`.
Placeholders, hints and examples come from real records (employee handles, people's
chat handles) or are generic; nothing outside `src/mock` knows a mock name.

### Chat

Slack-like, per the spec's "Everyday chat features": channels, DMs and threads; `/`
focuses message search (results grouped by channel, a click opens the message in its
thread, highlighted); `@` suggests employees, their active sessions (`@employee#slug`)
and people, keyboard navigable; unread counts and a mentions badge per channel, marked
read while a channel or thread is open and the tab is visible; edit and delete your own
messages ("(edited)", "message deleted"); reactions (✅ 👀 👍 ❤️ 🎉 ❌) as chips that
toggle; "New message" opens a DM with any employee or person.

## Screenshots (real server, seeded demo data)

Taken against the real server with `scripts/seed-demo.ts`, three real requests (two in
#requests, one DM) answered by the model, and `scripts/screenshots.ts`:

```sh
DATABASE_SCHEMA=demo MP_BOOTSTRAP=1 PORT=3113 npx tsx packages/server/src/main.ts
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
