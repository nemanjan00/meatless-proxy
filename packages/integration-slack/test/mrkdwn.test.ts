import { describe, expect, it } from 'vitest'
import { toSlackMrkdwn } from '../src/index.ts'

describe('toSlackMrkdwn', () => {
  it('turns what a model wrote live into mrkdwn', () => {
    const md = [
      '<@U068DQCPCP7> — here is what I can do:',
      '',
      '## Capabilities',
      '- **Knowledge base first**, then live data',
      '* Direct store access (see [the docs](https://example.com/docs))',
      '~~old~~ new',
    ].join('\n')
    expect(toSlackMrkdwn(md)).toBe(
      [
        '<@U068DQCPCP7> — here is what I can do:',
        '',
        '*Capabilities*',
        '• *Knowledge base first*, then live data',
        '• Direct store access (see <https://example.com/docs|the docs>)',
        '~old~ new',
      ].join('\n'),
    )
  })

  it('leaves mrkdwn, mentions, and code alone', () => {
    const ok = '*bold* _it_ <@U123> <https://x.example|x> `**not bold**`\n```\n- not a list\n**raw**\n```'
    expect(toSlackMrkdwn(ok)).toBe(ok)
  })
})
