# Web UI stylebook

The [web UI](spec.md#web-ui) copies **Linear's styling**: dark by default, calm,
dense, keyboard-first, a single indigo accent on near-black greys, and Inter. It
is built with **[shadcn/ui](https://ui.shadcn.com)**. The tokens below are
defined as shadcn's CSS variables, so every shadcn component picks up the look
without changes.

**Sources.** Colour, type, radius, shadow and motion values were taken from
the CSS served by linear.app on 2026-09-29. linear.app is Linear's marketing
site. The app itself needs a login and wasn't inspected, so the
[density](#density-and-layout) values are an adaptation of those tokens for an
app screen.

**What we copy and what we don't.** We copy the look: colours, type scale,
spacing, radii, motion, and the layout patterns. We don't copy Linear's name,
logo, icons, illustrations or marketing imagery, and we don't use their
commercial fonts (see [type](#type)).

## Stack

- **shadcn/ui** on React and Tailwind CSS v4. Components are copied into the
  repo and owned by us, per shadcn's model.
- **lucide-react** icons (shadcn's default), at 16 px, 1.5 px stroke.
- **Inter Variable** for UI text, **JetBrains Mono** for code, ids and logs.
  Both are open-source (OFL).

## Themes

- **Dark is the default** and the one to design for first. Light is fully
  supported.
- The theme follows the system setting until the user picks one. It's
  switched with the `.dark` class, per shadcn.

## Colour

### Linear's palette

| Role              | Dark      | Light     | Used for                                  |
|-------------------|-----------|-----------|-------------------------------------------|
| bg level 0        | `#08090a` | `#ffffff` | app background                            |
| bg level 1        | `#0f1011` | `#f8f8f8` | sidebar, panels, cards                    |
| bg level 2        | `#141516` | `#f4f4f4` | popovers, muted areas                     |
| bg level 3        | `#191a1b` | `#f0f0f0` | raised elements on panels                 |
| bg secondary      | `#1c1c1f` | `#f9f8f9` | secondary buttons, selected rows          |
| bg tertiary       | `#232326` | `#f4f2f4` | hover                                     |
| border primary    | `#23252a` | `#e9e8ea` | default borders, dividers                 |
| border secondary  | `#34343a` | `#e4e2e4` | inputs                                    |
| border tertiary   | `#3e3e44` | `#dcdbdd` | strong borders, focused inputs            |
| text primary      | `#f7f8f8` | `#282a30` | main text                                 |
| text secondary    | `#d0d6e0` | `#3c4149` | secondary text, row titles in lists       |
| text tertiary     | `#8a8f98` | `#6f6e77` | metadata, labels, placeholders            |
| text quaternary   | `#62666d` | `#86848d` | disabled, timestamps, faint hints         |
| brand             | `#5e6ad2` | `#7070ff` | primary buttons, selection                |
| accent            | `#7170ff` | `#7170ff` | focus ring, active states                 |
| accent hover      | `#828fff` | `#8989f0` | links, hovered accent                     |
| accent tint       | `#18182f` | `#f1f1ff` | accent backgrounds (selected nav item)    |

Named colours (same in both themes): red `#eb5757`, orange `#fc7840`, yellow
`#f0bf00`, green `#27a644`, teal `#00b8cc`, blue `#4ea7fc`, indigo `#5e6ad2`.

### Status colours

Session and [run states](execution.md#runs) use Linear's status language: a
small coloured icon in front of the title, never a coloured row.

| State      | Colour                 | Icon (lucide)      |
|------------|------------------------|--------------------|
| queued     | text quaternary        | `circle-dashed`    |
| running    | yellow `#f0bf00`       | `circle-dot` (animated) |
| suspended / waiting | blue `#4ea7fc` | `circle-pause`     |
| paused     | orange `#fc7840`       | `circle-alert`     |
| completed  | indigo `#5e6ad2`       | `circle-check`     |
| failed     | red `#eb5757`          | `circle-x`         |
| cancelled  | text tertiary          | `circle-slash`     |

## Type

- **Family:** `"Inter Variable", "SF Pro Display", -apple-system,
  BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`, with Linear's font
  features `font-feature-settings: "cv01", "ss03"` and
  `font-variation-settings: "opsz" auto`.
- **Mono:** `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace`.
  Linear uses Berkeley Mono, which is commercial.
- **Weights:** 400 normal, 510 medium, 590 semibold, 680 bold. These are
  Linear's in-between variable weights. Use medium for emphasis in the UI and
  semibold for titles. Bold is rare.

| Token     | Size             | Line height | Letter spacing | Used for                          |
|-----------|------------------|-------------|----------------|-----------------------------------|
| tiny      | 10 px (0.625rem) | 1.5         | −0.015em       | badges, counters                  |
| micro     | 12 px (0.75rem)  | 1.4         | 0              | labels, metadata, table headers   |
| mini      | 13 px (0.8125rem)| 1.5         | −0.01em        | **default UI text**: lists, sidebar, buttons, menus |
| small     | 14 px (0.875rem) | 1.5         | −0.013em       | form fields, chat messages        |
| regular   | 15 px (0.9375rem)| 1.6         | −0.011em       | docs and session documents (reading) |
| title 1   | 17 px (1.0625rem)| 1.4         | −0.012em       | panel titles                      |
| title 2   | 20 px (1.25rem)  | 1.33        | −0.012em       | page titles                       |
| title 3   | 24 px (1.5rem)   | 1.33        | −0.012em       | document titles                   |

Titles are semibold. Larger titles (32 px and up, −0.022em) are for empty
states and onboarding only.

## Shape, depth and motion

- **Radius:** 4 px (small controls, badges), 6 px (buttons, inputs, menu items),
  8 px (popovers, dropdowns), 12 px (cards, dialogs, panels), full (avatars,
  pills). shadcn's `--radius: 0.5rem` produces exactly these steps: `sm` 4,
  `md` 6, `lg` 8, `xl` 12.
- **Borders over shadows.** Surfaces are separated by 1 px borders and a step
  in background level. Shadows only for things that float: popovers, menus,
  dialogs, toasts.
- **Shadows** (dark / light):
  - low `0 2px 4px #0000001a` / `0 1px 4px -1px #00000017`
  - medium `0 4px 24px #00000033` / `0 3px 12px #00000017`
  - high `0 7px 32px #00000059` / `0 7px 24px #0000000f`
- **Focus:** a 2 px ring in the accent colour, 2 px offset, only on keyboard
  focus (`:focus-visible`).
- **Selection:** the brand colour at 20 % for text selection and selected rows.
- **Motion:** quick 100 ms for hover and press, regular 250 ms for panels and
  dialogs, eased with `cubic-bezier(.25, .46, .45, .94)` (ease-out-quad).
  Nothing bounces. Respect `prefers-reduced-motion`.

## Density and layout

The app is dense, like Linear's app. The layout follows its patterns:

- **Sidebar** (bg level 1, 240 px, collapsible). At the top is the
  **employee switcher**: each [employee](spec.md#multiple-employees) is a
  workspace, like Linear's workspace switcher. Below it:
  - Inbox: threads you were pulled into, approvals, paused runs
  - Now
  - Sessions
  - Chat
  - Projects
  - Procedures
  - Contacts
  - Memory
  - Usage
  - Settings
- **Lists**, for sessions, projects, contacts and memories:
  - rows 36 px high, 13 px text
  - a status icon, then the title in text secondary
  - metadata (links, avatars, timestamps) right-aligned in text tertiary
  - a hairline border between groups, not between rows
  - grouping and filters in a bar above the list
- **Detail view**, like a Linear issue: the document takes the main column
  (max 720 px, 15 px reading text). A right-hand **properties panel**
  (280 px) shows the record's fields (core and extension fields, from the
  schema) and its links, edited inline.
- **Session view:** the history is a timeline of entries (messages, tool calls
  collapsed to one line, summaries and pointers marked). The fork tree is in a
  side panel, and threads and usage are in tabs.
- **Command menu** (`⌘K` / `Ctrl K`) to jump anywhere and run any action. Every
  common action has a keyboard shortcut, shown in menus and tooltips as
  `<kbd>` hints.
- **Spacing** on a 4 px grid: 8 px inside controls, 12–16 px inside panels,
  24 px page padding.
- **Empty states:** one line of text tertiary and one action, with no
  illustration.

## shadcn components

| Need                          | shadcn component                               |
|-------------------------------|------------------------------------------------|
| app shell, sidebar            | `Sidebar`                                      |
| command menu                  | `Command` in a `Dialog`                        |
| lists and tables              | `Table` + TanStack Table (shadcn's data table pattern) |
| properties panel, forms       | `Form` (react-hook-form + zod), generated from the record's schema |
| menus                         | `DropdownMenu`, `ContextMenu`                  |
| pickers (status, contact, project) | `Popover` + `Command`                     |
| side panels, fork tree        | `Resizable`, `Sheet`, `Collapsible`            |
| status, tags                  | `Badge`                                        |
| people, employees             | `Avatar`                                       |
| hints                         | `Tooltip`, `Kbd`                               |
| notifications                 | `Sonner`                                       |
| usage charts                  | `Chart` (Recharts)                             |
| tabs, dialogs, scroll areas   | `Tabs`, `Dialog`, `ScrollArea`                 |

shadcn has no markdown editor and no tree view. The fork tree is built from
`Collapsible`. The markdown editor is still an open question (see below).

## Tokens

The theme as shadcn CSS variables (Tailwind v4 `globals.css`). The `@theme
inline` block that maps these to Tailwind utilities stays as shadcn generates
it. The last group holds extra tokens for the parts of Linear's palette that
shadcn has no slot for.

```css
:root {
  --radius: 0.5rem;
  --font-sans: "Inter Variable", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;

  --background: #ffffff;
  --foreground: #282a30;
  --card: #ffffff;
  --card-foreground: #282a30;
  --popover: #ffffff;
  --popover-foreground: #282a30;
  --primary: #7070ff;
  --primary-foreground: #ffffff;
  --secondary: #f9f8f9;
  --secondary-foreground: #282a30;
  --muted: #f4f2f4;
  --muted-foreground: #6f6e77;
  --accent: #eeedef;
  --accent-foreground: #282a30;
  --destructive: #eb5757;
  --border: #e9e8ea;
  --input: #dcdbdd;
  --ring: #7170ff;
  --chart-1: #7170ff;
  --chart-2: #4ea7fc;
  --chart-3: #27a644;
  --chart-4: #f0bf00;
  --chart-5: #fc7840;
  --sidebar: #f9f8f9;
  --sidebar-foreground: #3c4149;
  --sidebar-primary: #7070ff;
  --sidebar-primary-foreground: #ffffff;
  --sidebar-accent: #eeedef;
  --sidebar-accent-foreground: #282a30;
  --sidebar-border: #e9e8ea;
  --sidebar-ring: #7170ff;

  /* Linear palette beyond shadcn's slots */
  --fg-secondary: #3c4149;
  --fg-tertiary: #6f6e77;
  --fg-quaternary: #86848d;
  --bg-level-1: #f8f8f8;
  --bg-level-2: #f4f4f4;
  --bg-level-3: #f0f0f0;
  --accent-tint: #f1f1ff;
  --status-running: #f0bf00;
  --status-waiting: #4ea7fc;
  --status-paused: #fc7840;
  --status-completed: #5e6ad2;
  --status-failed: #eb5757;
}

.dark {
  --background: #08090a;
  --foreground: #f7f8f8;
  --card: #0f1011;
  --card-foreground: #f7f8f8;
  --popover: #141516;
  --popover-foreground: #f7f8f8;
  --primary: #5e6ad2;
  --primary-foreground: #ffffff;
  --secondary: #1c1c1f;
  --secondary-foreground: #f7f8f8;
  --muted: #141516;
  --muted-foreground: #8a8f98;
  --accent: #232326;
  --accent-foreground: #f7f8f8;
  --destructive: #eb5757;
  --border: #23252a;
  --input: #34343a;
  --ring: #7170ff;
  --sidebar: #0f1011;
  --sidebar-foreground: #d0d6e0;
  --sidebar-primary: #5e6ad2;
  --sidebar-primary-foreground: #ffffff;
  --sidebar-accent: #1c1c1f;
  --sidebar-accent-foreground: #f7f8f8;
  --sidebar-border: #23252a;
  --sidebar-ring: #7170ff;

  --fg-secondary: #d0d6e0;
  --fg-tertiary: #8a8f98;
  --fg-quaternary: #62666d;
  --bg-level-1: #0f1011;
  --bg-level-2: #141516;
  --bg-level-3: #191a1b;
  --accent-tint: #18182f;
}

body {
  font-feature-settings: "cv01", "ss03";
  font-variation-settings: "opsz" auto;
  font-size: 0.8125rem;
  line-height: 1.5;
  letter-spacing: -0.01em;
}
```

## Open questions

- Which markdown editor for docs and session documents: Tiptap, Milkdown, or a
  plain editor with a live preview? It has to support links to contacts,
  projects and sessions by id.
- Should the app be checked against Linear's app itself (which needs a
  login), to refine the density values?
