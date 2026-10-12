// Vite builds every VITE_* variable into the browser bundle, so a server secret must never carry
// the prefix (CLAUDE.md, Database). vite-env.test.ts reads every source and config file and
// .env.example for VITE_ names shaped like a secret. Names ending in _PUBLIC_KEY, such as the
// VAPID key Web Push needs, are public by design.

// Vite matches the prefix exactly but takes any name after it, so VITE_apiKey reaches the browser
// too; the words are matched without regard to case.
const VITE_NAME = /\bVITE_\w+/g
const SECRET_WORD = /SECRET|TOKEN|PASSWORD|PRIVATE|KEY|DATABASE|DB_URL|PG/i

export function viteNames(text: string): string[] {
  return [...new Set(text.match(VITE_NAME) ?? [])]
}

export function isSecretShaped(name: string): boolean {
  return SECRET_WORD.test(name.slice('VITE_'.length)) && !/_PUBLIC_KEY$/i.test(name)
}

// Files where a variable name can appear: code, config, CI workflows, shell scripts, Dockerfiles and
// any .env file git tracks (.env.example, or a .env.production committed on purpose: Vite ships its
// VITE_ values to the browser). Ignored .env files are never read. Docs and lockfiles are skipped.
export function mayNameVariables(path: string): boolean {
  if (/(^|\/)(package-lock|npm-shrinkwrap)\.json$/.test(path)) return false
  return (
    /\.([cm]?[jt]sx?|json|jsonc|html|ya?ml|toml|sh|dockerfile)$/i.test(path) ||
    /(^|\/)(Dockerfile|Containerfile)(\.[^/]*)?$/.test(path) ||
    /(^|\/)\.env(\.[^/]*)?$/.test(path)
  )
}

// Vite's envPrefix decides which variables reach the browser; it stays VITE_, the one prefix the
// check above knows.
export const ENV_PREFIX = /\benvPrefix\b/
export const isViteConfig = (path: string) => /(^|\/)vite(st)?\.config\.[cm]?[jt]s$/.test(path)
