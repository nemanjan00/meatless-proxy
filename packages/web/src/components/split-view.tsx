import type { ReactNode } from 'react'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable.tsx'
import { useIsMobile } from '@/hooks/use-mobile.ts'

/**
 * A detail view: the main column and a resizable properties panel on the
 * right. On phones the panel goes below the main column and the page scrolls
 * as one.
 */
export function SplitView({
  main,
  side,
  sideSize = 300,
  sideMin = 240,
  sideMax = 420,
}: {
  main: ReactNode
  side: ReactNode
  sideSize?: number
  sideMin?: number
  sideMax?: number
}) {
  const mobile = useIsMobile()
  if (mobile)
    return (
      <div className="h-full overflow-auto">
        {main}
        <div className="border-t">{side}</div>
      </div>
    )
  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full">
      <ResizablePanel minSize={420}>
        <div className="h-full overflow-auto">{main}</div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={sideSize} minSize={sideMin} maxSize={sideMax}>
        {side}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
