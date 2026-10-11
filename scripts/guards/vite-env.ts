// Vite builds every VITE_* variable into the browser bundle, so a server secret must never carry
// the prefix (CLAUDE.md, Database). vite-env.test.ts reads every source and config file and
// .env.example for VITE_ names shaped like a secret. Names ending in _PUBLIC_KEY, such as the
// VAPID key Web Push needs, are public by design.
const VITE_NAME = /\bVITE_[A-Z0-9_]*[A-Z0-9]/g
const SECRET_WORD = /SECRET|TOKEN|PASSWORD|PRIVATE|KEY|DATABASE|DB_URL|PG/

export function viteNames(text: string): string[] {
  return [...new Set(text.match(VITE_NAME) ?? [])]
}

export function isSecretShaped(name: string): boolean {
  return SECRET_WORD.test(name.slice('VITE_'.length)) && !name.endsWith('_PUBLIC_KEY')
}

// Files where a variable name can appear: code, config, CI workflows, shell scripts and env files.
// Docs are prose and are skipped, as is the lockfile.
export function mayNameVariables(path: string): boolean {
  if (path === 'package-lock.json') return false
  return /\.([cm]?[jt]sx?|json|jsonc|html|ya?ml|toml|sh)$/.test(path) || /(^|\/)\.env\.example$/.test(path)
}

// Vite's envPrefix decides which variables reach the browser; it stays VITE_, the one prefix the
// check above knows.
export const ENV_PREFIX = /\benvPrefix\b/
export const isViteConfig = (path: string) => /(^|\/)vite(st)?\.config\.[cm]?[jt]s$/.test(path)
