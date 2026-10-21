import { documentHeaders } from '@hearth/shared'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The Hearth PWA's build and dev server (T8, T21). The browser talks only to its own origin: in
// development Vite proxies /api to the api role and /ws to the realtime role, so the session cookie
// and the server's Origin check work as they will behind CloudFront (OD-11).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `@/*` → src/*, read from tsconfig.json, as Vitest's root config does.
  resolve: { tsconfigPaths: true },
  build: {
    // The manifest names the entry and the chunks it loads, so the bundle budget can be measured (T21).
    manifest: true,
    // Every asset stays a file, never a data: URL, which the app's CSP doesn't allow (T21).
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    // The app origin is fixed: APP_ORIGIN in .env.example is http://localhost:5173, and the server
    // refuses a state change from any other Origin. strictPort fails rather than moving to 5174.
    port: 5173,
    strictPort: true,
    // The document headers and CSP come from the one builder (D-04, T21 item 7), relaxed for dev
    // only by 'unsafe-inline' on script-src (React Refresh's preamble) and style-src (Vite injects
    // CSS as <style>). connect-src stays the allow-list, so a new outbound host is blocked here first.
    headers: documentHeaders('http://localhost:5173', { dev: true }),
    // changeOrigin and rewriteWsOrigin stay off, so the browser's own Origin reaches the server's
    // checks (the root Origin hook and the WebSocket upgrade). Both entries take the object form:
    // Vite turns a bare string target into { target, changeOrigin: true }.
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000' },
      '/ws': { target: 'ws://127.0.0.1:3001', ws: true },
    },
  },
})
