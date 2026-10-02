import Md from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChatLink } from '@/components/links.tsx'
import { linkifyDoc, markTags } from '@/lib/doclinks.ts'
import { cn } from '@/lib/utils.ts'

/**
 * Renders a markdown document: `[[kind:id|label]]` links become in-app links,
 * and chat tags (`@employee#session-slug`) are highlighted.
 */
export function Markdown({
  text,
  className,
  resolve,
  tags = false,
}: {
  text: string
  className?: string
  resolve?: (kind: string, id: string) => string | undefined
  tags?: boolean
}) {
  let src = linkifyDoc(text, resolve)
  if (tags) src = markTags(src)
  return (
    <div className={cn('prose-doc', className)}>
      <Md
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (url.startsWith('tag:') || url.startsWith('/') || /^https?:/.test(url) ? url : '')}
        components={{
          a: ({ href = '', children }) => {
            if (href.startsWith('tag:'))
              return <span className="rounded-sm bg-accent-tint px-0.5 font-medium text-[#828fff]">{children}</span>
            return <ChatLink href={href}>{children}</ChatLink>
          },
        }}
      >
        {src}
      </Md>
    </div>
  )
}
