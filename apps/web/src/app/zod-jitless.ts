// zod without code made from strings (T21; K-01, K-05, WS-02). zod 4 compiles an object schema's
// parser with `new Function` when it can, and finds out whether it can by trying `new Function('')`
// once, when the first object schema is built. The app's CSP has no 'unsafe-eval'
// (packages/shared/src/web-headers.ts), so the browser blocks that probe: zod catches the error, but
// the browser still reports the violation, and every page load would send /api/csp-report a report
// that fills the log's cap and hides the real ones.
//
// jitless turns the compiler and its probe off. zod reads the flag when a schema is built, not when
// it parses, so this must run before anything builds one: app/boot.tsx imports this file first,
// ahead of @hearth/shared and every module that loads it. main.ts's static graph reaches no package
// (WS-10), so nothing has built a schema before boot.tsx loads.
import { z } from 'zod'

z.config({ jitless: true })
