// The web app's one entry (T21, D-02): index.html loads this module and nothing else.
//
// Its static imports are the styles and modules that import no package: the two self-hosted font
// faces (Figtree and Bricolage Grotesque, the upright weight axis only; R-17, OD-27) and the app's
// stylesheet, which Vite links in index.html's head before any script runs; boot/pre-boot.ts;
// session/document.ts (with router/paths.ts); and strings/boot.ts. Then preBoot() removes the
// router's scroll cache and sets zod's jitless before zod loads (boot/pre-boot.ts), and only after
// that does the one dynamic import load the app. By ES module
// semantics nothing in that import's graph (React, the router, Query, zod) evaluates before the
// call, however the bundler splits chunks, so router-core never reads a scroll cache a previous
// person left (K-08, K-61). scripts/guards/web-source.test.ts (WS-10) holds this file and its static
// graph to that, and T21 item 2 binds later chunking changes to it.
import '@fontsource-variable/figtree/index.css'
import '@fontsource-variable/bricolage-grotesque/index.css'
import './styles/app.css'
import { preBoot } from './boot/pre-boot.ts'
import { browserDocumentEnv, reloadForUpdate } from './session/document.ts'
import { BOOT } from './strings/boot.ts'

preBoot(window, () => reloadForUpdate(browserDocumentEnv()))

// The app's chunk, or a file it needs, failed to load. Vite's preload helper fires vite:preloadError
// first, and preBoot() reloads at most once a minute, since a deploy that's gone needs the new
// index.html. When it doesn't reload, the error reaches the catch, which says so in #root as plain
// text, with no React (textContent, so the CSP holds). Vite moves the import's own .then inside its
// helper, so the catch hangs off the outer promise, where a failure the helper throws arrives too.
import('./app/boot.tsx')
  .then(app => app.boot())
  .catch(() => {
    const root = document.getElementById('root')
    if (root) root.textContent = BOOT.cantReach
  })
