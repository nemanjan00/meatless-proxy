/**
 * Models write Markdown, and Slack renders mrkdwn: `**bold**` came out with its asterisks and `- ` lists flat.
 * This turns the common Markdown into mrkdwn before a message is sent. Code spans and blocks are left as they are.
 * Mentions are not guessed from names (two people can share one): the model writes <@U123> itself.
 * https://api.slack.com/reference/surfaces/formatting
 */
export function toSlackMrkdwn(text: string): string {
  // Code blocks and spans stay untouched: split them out first.
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
  return parts.map((part, i) => (i % 2 === 1 ? part : convertProse(part))).join('')
}

function convertProse(s: string): string {
  return (
    s
      // Links: [text](https://…) → <https://…|text>.
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<$2|$1>')
      // Headings → a bold line.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '*$1*')
      // Bold, strike: **x** / __x__ → *x*, ~~x~~ → ~x~.
      .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '*$1*')
      .replace(/__(?=\S)([^\n]*?\S)__/g, '*$1*')
      .replace(/~~(?=\S)([^\n]*?\S)~~/g, '~$1~')
      // Bullets: "- x" / "* x" at a line start → "• x" (Slack has no list syntax; a leading "*" would read as bold).
      .replace(/^([ \t]*)[-*+][ \t]+(?=\S)/gm, '$1• ')
  )
}
