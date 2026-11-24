import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const api = 'http://localhost:3000'

/**
 * The build's version: GIT_SHA (the image build passes the commit), else the checkout's commit, else
 * `dev`. Baked into the bundle as __APP_VERSION__ and written to dist/version.json, which the running
 * app checks to offer a refresh after a deployment (src/lib/app-version.ts).
 */
function buildVersion(): string {
  if (process.env.GIT_SHA?.trim()) return process.env.GIT_SHA.trim()
  try {
    return (
      execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || 'dev'
    )
  } catch {
    return 'dev'
  }
}

function appVersion(version: string): Plugin {
  return {
    name: 'vegan:app-version',
    config: () => ({ define: { __APP_VERSION__: JSON.stringify(version) } }),
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ version })}\n` })
    },
  }
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss(), appVersion(buildVersion())],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': api,
      '/auth': api,
      '/healthz': api,
      '/readyz': api,
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Pages are split by route (React.lazy in src/app.tsx); heavy libraries get their own chunks,
    // so a page only loads the charts or the markdown renderer when it needs them.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'charts',
              priority: 10,
              test: /node_modules[\\/](recharts|d3-[^\\/]+|victory-vendor|decimal\.js-light|es-toolkit|immer|reselect|@reduxjs|react-redux|redux)/,
            },
            {
              name: 'markdown',
              priority: 20,
              test: /node_modules[\\/](react-markdown|remark-[^\\/]+|rehype-[^\\/]+|micromark[^\\/]*|mdast-[^\\/]+|hast-[^\\/]+|unist-[^\\/]+|unified|vfile[^\\/]*|property-information|space-separated-tokens|comma-separated-tokens|html-url-attributes|decode-named-character-reference|character-entities[^\\/]*|devlop|bail|trough|is-plain-obj|zwitch|longest-streak|markdown-table|ccount|escape-string-regexp|trim-lines|style-to-[^\\/]+|inline-style-parser|estree-util-[^\\/]+)/,
            },
            {
              name: 'react',
              priority: 40,
              test: /node_modules[\\/](react|react-dom|react-is|scheduler|react-router|use-sync-external-store)[\\/]/,
            },
            {
              name: 'ui',
              priority: 30,
              test: /node_modules[\\/](clsx|tailwind-merge|class-variance-authority|radix-ui|@radix-ui|cmdk|@floating-ui|lucide-react|sonner|react-resizable-panels|@tanstack|react-hook-form)/,
            },
          ],
        },
      },
    },
  },
})
