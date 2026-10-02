import { globMatch } from '@mp/core'

/**
 * Tools on demand (`TOOLS_ON_DEMAND`): a session is offered its everyday tools (the core set) and loads
 * the rest when it needs them (`tools.find`, `tools.load`, or by calling one by name). Every model call
 * carries the definitions of the tools it is offered, so the rarely used ones only cost context in the
 * sessions that use them. The session's toolset stays the permission boundary: only tools in it, and
 * allowed, are offered or loaded.
 */

/** The tools that load the others. A session without them in its toolset is offered all of its tools. */
export const LOADER_TOOLS: readonly string[] = ['tools.find', 'tools.load']

/**
 * The everyday tools, offered from the start: replies, reading and writing code, environments, the
 * session tools that script and manage work and context, memory, time, and the most used tools of each
 * first-party integration. Tools that match no on-demand group (e.g. a configured MCP server's) are
 * offered from the start too.
 */
export const CORE_TOOLS: readonly string[] = [
  'chat.attachment_text',
  'chat.post',
  'chat.react',
  'chat.read',
  'chat.reply',
  // A session with a checklist (a procedure's, a template's) checks items with evidence before it may finish.
  'checklist.check',
  'checklist.show',
  'code.run',
  'directory.find_contact',
  'directory.find_procedure',
  'directory.find_project',
  'directory.get_contact',
  'directory.get_project',
  'directory.projects_of',
  'directory.update_contact',
  'docs.read',
  'docs.search',
  'env.exec',
  'env.up',
  'fs.list',
  'fs.read',
  'fs.share',
  'fs.write',
  'git.checkout',
  'git.commit',
  'git.diff',
  'git.edit_file',
  'git.list_files',
  'git.push',
  'git.read_file',
  'git.status',
  'git.write_file',
  'image.view',
  'memory.recall',
  'memory.remember',
  'procedures.run',
  'projects.list_files',
  'projects.read_file',
  'sessions.commit',
  'sessions.compact',
  'sessions.create',
  'sessions.discard',
  'sessions.finish',
  'sessions.fork',
  'sessions.get',
  'sessions.message',
  'sessions.offload',
  'sessions.restore',
  'sessions.rewind',
  'sessions.save_metadata',
  'sessions.wait',
  'skills.list',
  'skills.load',
  'time.now',
  'tools.find',
  'tools.load',
  'mcp.slack.post_message',
  'mcp.slack.react',
  'mcp.slack.read_thread',
  'mcp.slack.reply',
  'mcp.gitlab.create_merge_request',
  'mcp.gitlab.get_file',
  'mcp.gitlab.list_tree',
  'mcp.linear.comment',
  'mcp.linear.get_issue',
]

export interface ToolGroup {
  /** Short name, also matched by tools.find. */
  name: string
  /** What the tools are for, in a few words. */
  about: string
  /** Tool names or patterns (`globMatch`); core tools among them are not on demand. */
  tools: string[]
  /** The tools as the prompt lists them. */
  list: string
}

/** The tools loaded on demand, by what they are for. The prompt lists one line per group. */
export const ON_DEMAND_GROUPS: readonly ToolGroup[] = [
  {
    name: 'scheduling',
    about: 'reminders, recurring reports, coming back later',
    tools: ['schedule.*', 'sessions.follow_up'],
    list: 'schedule.create/list/update/cancel/run_now, sessions.follow_up',
  },
  {
    name: 'triggers',
    about: 'start work on matching events',
    tools: ['triggers.*'],
    list: 'triggers.create/list/update/disable',
  },
  {
    name: 'subscriptions',
    about: 'events about a ticket, merge request or thread delivered here',
    tools: ['subscriptions.*'],
    list: 'subscriptions.subscribe/list/unsubscribe',
  },
  {
    name: 'chat',
    about: 'channels and members, editing, search, saving attachments',
    tools: ['chat.*'],
    list: 'chat.create_channel/add_member/remove_member/invite/archive/edit/delete/search/save_attachment',
  },
  {
    name: 'sessions',
    about: 'fan-out, finding and linking sessions, templates',
    tools: ['sessions.*'],
    list: 'sessions.loop/list/search/look_up/tree/link/unlink/save_template',
  },
  {
    name: 'checklists',
    about: 'adding items, asking for a review',
    tools: ['checklist.*'],
    list: 'checklist.add_item/request_review',
  },
  {
    name: 'docs and memory',
    about: 'writing knowledge docs, memory upkeep',
    tools: ['docs.*', 'memory.*'],
    list: 'docs.write/write_chapter/list/backlinks, memory.verify/forget/link',
  },
  {
    name: 'files and git',
    about: 'moving files, git history, merging new base commits',
    tools: ['fs.*', 'code.*', 'git.*'],
    list: 'fs.move/delete, code.reset, git.log/sync',
  },
  {
    name: 'environments',
    about: 'live previews, desktop screenshots, logs, stopping',
    tools: ['env.*'],
    list: 'env.preview/screenshot/logs/down',
  },
  {
    name: 'projects',
    about: 'branches awaiting review, harness-hosted local projects, procedure details',
    tools: ['projects.*', 'directory.*'],
    list: 'projects.branches/create_local, directory.get_procedure',
  },
  {
    name: 'slack',
    about: 'forms, files, channels, users, DMs',
    tools: ['mcp.slack.*'],
    list: 'mcp.slack.ask/upload_file/get_file/post_blocks/read_channel/list_channels/lookup_user/open_dm/update_message/unreact',
  },
  {
    name: 'gitlab',
    about: 'merge request reviews, issues, pipelines, job logs',
    tools: ['mcp.gitlab.*'],
    list: 'mcp.gitlab.get_merge_request/merge_request_changes/comment_merge_request/reply_discussion/pipeline_status/job_log/get_issue/create_issue…',
  },
  {
    name: 'linear',
    about: 'searching, creating and updating issues',
    tools: ['mcp.linear.*'],
    list: 'mcp.linear.search_issues/create_issue/update_issue/list_teams…',
  },
]

const core = new Set(CORE_TOOLS)

/** Whether a tool waits to be loaded: it belongs to an on-demand group and isn't a core tool. */
export function isOnDemandTool(name: string): boolean {
  if (core.has(name)) return false
  return ON_DEMAND_GROUPS.some((g) => g.tools.some((p) => globMatch(p, name)))
}

/** The group of an on-demand tool. */
export function groupOf(name: string): ToolGroup | undefined {
  if (core.has(name)) return undefined
  return ON_DEMAND_GROUPS.find((g) => g.tools.some((p) => globMatch(p, name)))
}

/**
 * Which tools of a toolset wait to be loaded, or undefined when the toolset can't load tools (no
 * tools.load in it: a router context, a reviewer, a narrowed template) and so is offered whole.
 */
export function onDemandFor(toolset: readonly string[]): ((name: string) => boolean) | undefined {
  return toolset.includes('tools.load') ? isOnDemandTool : undefined
}

/** The tools of a toolset offered now: the core ones and the ones loaded. */
export function offeredTools(toolset: readonly string[], loaded: readonly string[]): string[] {
  const on = onDemandFor(toolset)
  if (!on) return [...toolset]
  const have = new Set(loaded)
  return toolset.filter((n) => !on(n) || have.has(n))
}

/** The prompt section naming what can be loaded, one line per group. */
export function onDemandPromptSection(): string {
  return `## Tools on demand
Your everyday tools are loaded; these load when you need them: tools.find { query } searches them, tools.load { names } adds them from your next step for the rest of this session (calling one by name loads it too). Look before saying you can't do something.
${ON_DEMAND_GROUPS.map((g) => `- ${g.name[0]!.toUpperCase()}${g.name.slice(1)} (${g.about}): ${g.list}`).join('\n')}`
}
