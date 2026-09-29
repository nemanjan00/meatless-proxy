/**
 * The integration setup documentation, shown on the employee page next to each step. The
 * server checks each step for real (packages/server/src/setup); this is what tells an admin
 * how to do it. The package READMEs keep the manual steps as the fallback.
 */

export interface StepDoc {
  /** Short paragraphs; `code` spans are written with backticks. */
  text: string[]
  /** Secrets this step's form takes (the integration's secret fields). */
  fields?: string[]
  /** The action button of this step, and its label. */
  action?: { name: string; label: string }
  /** Links that help with this step. */
  links?: { label: string; href: string }[]
}

export interface IntegrationDoc {
  /** One line on the card. */
  summary: string
  /** What the employee can do with it once connected. */
  gives: string
  steps: Record<string, StepDoc>
}

/** How integrations work, at the top of the employee page's Integrations section. */
export const HOW_INTEGRATIONS_WORK = [
  'Each employee has its own identity in every system: its own Slack bot, its own GitLab account, its own Linear member. It never uses a person’s account.',
  'Its tools act as that account, with the token you paste here. Tokens are stored as secrets scoped to the employee and are never shown again, not even to the model.',
  'Events come in through webhooks, signed by the system and verified by the harness, and triggers route them to the employee.',
  'Its router context reads each new event and decides: answer it, hand it to the session already working on it, or start new work.',
]

export const INTEGRATION_DOCS: Record<string, IntegrationDoc> = {
  slack: {
    summary: 'Its own Slack bot: it reads the channels it’s in, answers mentions and DMs, and replies in threads.',
    gives: 'post, reply, read channels and threads, react, look up users, open DMs',
    steps: {
      app: {
        text: [
          'Every employee is its own Slack app, so people see who they’re talking to. “Create Slack app” opens Slack with this employee’s manifest filled in: its name, bot scopes, event subscriptions and request URL. Pick the workspace and create it.',
          'Slack checks the request URL when the app is saved, which only works once the signing secret is set (next step). If it fails now, save anyway and retry it under Event Subscriptions afterwards.',
        ],
        links: [{ label: 'Your Slack apps', href: 'https://api.slack.com/apps' }],
      },
      tokens: {
        text: [
          'In the app, open Install App and install it to the workspace. Then copy the Bot User OAuth Token (`xoxb-…`) from OAuth & Permissions, and the Signing Secret from Basic Information → App Credentials.',
          'The harness checks the token with Slack before it saves it, and records the bot’s Slack user on the employee’s contact.',
        ],
        fields: ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'],
      },
      events: {
        text: [
          'Green once Slack has sent a signed request to this employee’s webhook: the URL check when the app is saved, or any event. Requests with a wrong signature don’t count.',
          'If it stays open, go to Event Subscriptions in the app and press Retry next to the request URL.',
        ],
      },
      channels: {
        text: [
          'The bot only sees the channels it’s a member of. Run the invite command in each channel it should read or post in. DMs to the app work without an invite.',
        ],
      },
      routing: {
        text: [
          'A trigger decides which Slack events reach the employee. The recommended one sends its mentions and DMs to its router context, in ephemeral runs: the router answers or starts a session that then owns the thread.',
        ],
        action: { name: 'add-trigger', label: 'Add recommended trigger' },
      },
    },
  },
  gitlab: {
    summary:
      'Its own GitLab account: it pushes its own branches over SSH, opens merge requests, and follows pipelines and reviews.',
    gives: 'projects, branches and files, merge requests, comments, pipelines and job logs, issues',
    steps: {
      instance: {
        text: [
          'The GitLab the employee works on. Leave it for gitlab.com; for a self-hosted instance, set its URL here or `GITLAB_BASE_URL` on the server.',
        ],
        fields: ['GITLAB_BASE_URL'],
      },
      account: {
        text: [
          'Create an account just for this employee, with a name that says it’s an AI. On GitLab Premium or Ultimate, use a service account (group Settings → Service accounts, or Admin → Service accounts). Otherwise create a dedicated user.',
          'It must not be an administrator. Its access comes from project membership (step 5).',
        ],
      },
      token: {
        text: [
          'Create a personal access token for that account with the `api` scope and an expiry, and paste it. The harness checks it with GitLab first, and records the account’s username on the employee’s contact.',
          'You get a warning when it expires within 30 days.',
        ],
        fields: ['GITLAB_TOKEN'],
      },
      'ssh-key': {
        text: [
          'The employee pushes over SSH with its own key. “Add it for me” adds the key to the account with its token; you can also add it by hand under User settings → SSH Keys, or as a deploy key with write access.',
          'After rotating the key, add it again: the old one stops working and is removed from the account.',
        ],
        action: { name: 'add-ssh-key', label: 'Add it for me' },
      },
      projects: {
        text: [
          'Add the account to the projects it works on as Developer: enough to push branches and open merge requests, not to merge. Protect each default branch so only people can merge into it.',
          'Employees never merge, deploy or push to protected branches. The harness refuses, and GitLab should enforce it too.',
        ],
      },
      webhooks: {
        text: [
          'Nobody registers GitLab webhooks by hand: the harness adds one to every repository of the projects the employee is on, with a secret it generates, and repairs them when they drift. It needs `PUBLIC_URL`, and Maintainer rights through the provisioning token (`GITLAB_HOOKS_TOKEN`) or the employee’s own token.',
        ],
        action: { name: 'register-webhooks', label: 'Register webhooks now' },
      },
      routing: {
        text: [
          'Its own merge requests need no trigger: it follows them by itself. The recommended trigger sends open issues assigned to its account to its router context.',
        ],
        action: { name: 'add-trigger', label: 'Add recommended trigger' },
      },
    },
  },
  linear: {
    summary: 'Its own Linear member: it takes issues assigned to it, comments, and updates their state.',
    gives: 'search, create and update issues, comments, assignees, states and labels',
    steps: {
      'api-key': {
        text: [
          'Invite a member just for the employee, sign in as it, and create a key under Settings → Account → Security & access → Personal API keys. Paste it here; the harness checks it with Linear first.',
        ],
        fields: ['LINEAR_API_KEY'],
        links: [{ label: 'Linear API settings', href: 'https://linear.app/settings/account/security' }],
      },
      webhook: {
        text: [
          'Linear sends issue and comment changes to the harness. “Create webhook” registers it with a fresh signing secret; that needs a Linear admin’s key.',
          'Otherwise create it by hand under Settings → API → Webhooks with the URL below, the resource types Issues, Comments and Issue labels, then paste the signing secret Linear shows.',
        ],
        fields: ['LINEAR_WEBHOOK_SECRET'],
        action: { name: 'create-webhook', label: 'Create webhook' },
      },
      routing: {
        text: [
          'The recommended trigger sends issues assigned to the employee to its router context, which starts a session for each.',
        ],
        action: { name: 'add-trigger', label: 'Add recommended trigger' },
      },
    },
  },
}
