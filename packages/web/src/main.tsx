import '@fontsource-variable/inter'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './styles/globals.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from '@/app.tsx'
import type { DataLayer } from '@/lib/api.tsx'
import { createServerDataLayer } from '@/lib/data-layer.ts'

async function dataLayer(): Promise<DataLayer> {
  if (import.meta.env.VITE_MOCK === '1') {
    const { createMockDataLayer } = await import('@/mock/index.ts')
    return createMockDataLayer({ simulate: true, latencyMs: 60 })
  }
  return createServerDataLayer()
}

dataLayer().then((data) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <App data={data} />
      </BrowserRouter>
    </StrictMode>,
  )
})
