import Md from 'react-markdown'
import { Link } from 'react-router'
import remarkGfm from 'remark-gfm'
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
            if (href.startsWith('/')) return <Link to={href}>{children}</Link>
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            )
          },
        }}
      >
        {src}
      </Md>
    </div>
  )
}
