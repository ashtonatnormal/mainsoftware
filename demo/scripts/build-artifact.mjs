// Turns dist/index.html (Vite build) into a single self-contained page for a
// claude.ai Artifact: inlines the JS and CSS, and drops the <html>/<head>/<body>
// wrappers because the Artifact host adds its own document skeleton.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const dist = 'dist'
let html = readFileSync(join(dist, 'index.html'), 'utf8')

const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"[^>]*>/g)]
const js = [...html.matchAll(/<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"[^>]*><\/script>/g)]
if (!js.length) throw new Error('No module script found in dist/index.html')

const fonts = [...html.matchAll(/<link [^>]*fonts\.(googleapis|gstatic)\.com[^>]*>/g)].map(m => m[0]).join('\n')
const styles = css.map(m => `<style>\n${readFileSync(join(dist, m[1]), 'utf8')}\n</style>`).join('\n')
const scripts = js.map(m => `<script type="module">\n${readFileSync(join(dist, m[1]), 'utf8').replace(/<\/script/gi, '<\\/script')}\n</script>`).join('\n')

const page = `<title>Hearth</title>
${fonts}
${styles}
<div id="root"></div>
${scripts}
`
mkdirSync('artifact', { recursive: true })
writeFileSync('artifact/hearth-demo.html', page)
console.log(`artifact/hearth-demo.html: ${(page.length / 1024).toFixed(0)} KB`)
