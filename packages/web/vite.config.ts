import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const api = 'http://localhost:3000'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': api,
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
