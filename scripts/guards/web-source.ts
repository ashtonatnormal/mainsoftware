// The web app's source rules (T21; read by web-source.test.ts). Each rule reads one file of
// apps/web/src, with its comments stripped, and names what breaks it. They read source, not the
// built bundle (scripts/check-web-dist.ts checks that), so a rule here can say where to look.
//
// Paths below are relative to apps/web/src/ (`session/runtime.ts`).
import ts from 'typescript'
import { moduleImports } from './imports'

export const WEB_DIR = 'apps/web/'
export const WEB_SRC = 'apps/web/src/'

// Test files run under Vitest in Node and never ship, so the source rules read runtime code only.
// tsconfig coverage (WS-09) reads tests too.
export const isRuntimeSource = (path: string) => /\.(?:tsx?|css)$/.test(path) && !/\.test\.tsx?$/.test(path)

const kindOf = (path: string) => (/\.tsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

const parse = (path: string, source: string) =>
  ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kindOf(path))

// A file's code without its comments: a script printed back by TypeScript (strings, template text
// and JSX kept), a stylesheet with its /* */ comments removed.
export function codeOf(path: string, source: string): string {
  if (path.endsWith('.css')) return source.replace(/\/\*[\s\S]*?\*\//g, '')
  return ts.createPrinter({ removeComments: true }).printFile(parse(path, source))
}

const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self'])

function inType(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isTypeNode(at) || ts.isTypeQueryNode(at) || ts.isInterfaceDeclaration(at) || ts.isTypeAliasDeclaration(at))
      return true
    if (ts.isStatement(at) || ts.isSourceFile(at)) return false
  }
  return false
}

// Whether an identifier reads the value it names: not a declaration's own name, a property's key,
// an import's local name, or a name in a type (`typeof fetch` in a type reads nothing at run time).
function readsValue(id: ts.Identifier): boolean {
  const parent = id.parent
  if (inType(id)) return false
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false
  if (ts.isQualifiedName(parent)) return false
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isBindingElement(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === id
  )
    return false
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false
  if (ts.isExportSpecifier(parent)) return false
  if (ts.isJsxAttribute(parent) || ts.isLabeledStatement(parent)) return false
  return true
}

// Where a file reads one of these globals as a value: a bare name (`fetch(…)`, `{ fetch }`) or
// through the global object (`window.fetch`, `globalThis['fetch']`).
export function globalReads(path: string, source: string, names: ReadonlySet<string>): string[] {
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text) && readsValue(node)) found.push(node.text)
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text) &&
      names.has(node.name.text)
    )
      found.push(`${node.expression.text}.${node.name.text}`)
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      names.has(node.argumentExpression.text)
    )
      found.push(`${node.expression.text}['${node.argumentExpression.text}']`)
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return found
}

// The text of every string a file holds: literals, template text and JSX attribute values.
export function stringsOf(path: string, source: string): string[] {
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      found.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return found
}

// Every identifier a file names, wherever it stands (an import, a property access, a JSX tag), in
// order; strings and comments hold none.
export function identifiersOf(path: string, source: string): string[] {
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) found.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return found
}

// The names a file imports, with the module each comes from (`import type` names included, and a
// default or namespace import under the local name it binds).
export function importedNames(path: string, source: string): { specifier: string; name: string }[] {
  const found: { specifier: string; name: string }[] = []
  for (const statement of parse(path, source).statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    const clause = statement.importClause
    if (clause?.name) found.push({ specifier, name: clause.name.text })
    const bindings = clause?.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) found.push({ specifier, name: bindings.name.text })
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        found.push({ specifier, name: (element.propertyName ?? element.name).text })
  }
  return found
}

// Where an import in apps/web/src lands, as a path relative to apps/web/src/ (`flags/FlagSlot.tsx`),
// or undefined for a package. Both `@/…` and relative specifiers resolve.
export function srcTarget(fromPath: string, specifier: string): string | undefined {
  let joined: string
  if (specifier.startsWith('@/')) joined = specifier.slice(2)
  else if (specifier.startsWith('.')) joined = `${fromPath.split('/').slice(0, -1).join('/')}/${specifier}`
  else return undefined
  const parts: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

// Every module a file loads, as written (dynamic import() included).
export const specifiersOf = (path: string, source: string) =>
  moduleImports(source, path).flatMap(i => (i.specifier === undefined ? [] : [i.specifier]))

// --- The rules' patterns. Each takes the file's code with comments stripped. ---

// WS-01: browser storage that outlives a document. sessionStorage is allowed in two files (D-02).
export const STORAGE = /\b(?:localStorage|indexedDB|caches)\b/g
export const SESSION_STORAGE = /\bsessionStorage\b/g
export const SESSION_STORAGE_FILES = new Set(['boot/pre-boot.ts', 'session/document.ts'])

// WS-02: the one QueryClient, and no code made from strings or hung on the window.
export const NEW_QUERY_CLIENT = /\bnew\s+QueryClient\s*\(/g
export const QUERY_CLIENT_FILE = 'session/query-client.ts'
export const CODE_FROM_STRINGS =
  /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(|\b(?:window|globalThis|self)\s*(?:\.\s*__|\[\s*['"`]__)/g

// WS-03: the network, only through its two clients, and only to this origin.
export const FETCH_FILES = new Set(['api/http.ts'])
export const WEBSOCKET_FILES = new Set(['live/gateway-client.ts', 'session/runtime.ts'])
export const ABSOLUTE_URL = /^\s*(?:(?:https?|wss?):\/\/|\/\/[^/\s])/i

// WS-04: colour only through the tokens.
export const COLOUR_LITERAL =
  /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi
export const COLOUR_LITERAL_FILES = new Set(['styles/tokens.css'])
const COLOUR_UTILITY =
  '(?:text|bg|border(?:-[xytrblse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|divide|decoration|caret|accent|placeholder|shadow|inset-shadow|inset-ring|drop-shadow|scrollbar-thumb|scrollbar-track)'
const PALETTE =
  '(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe)'
export const DEFAULT_PALETTE = new RegExp(
  `(?<![\\w-])${COLOUR_UTILITY}-(?:white|black|${PALETTE}-(?:50|[1-9]00|950))(?![\\w-])`,
  'g',
)
export const ARBITRARY_COLOUR = new RegExp(
  `(?<![\\w-])${COLOUR_UTILITY}-(?:\\[(?:#|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|var)\\(|color:)|\\((?:--|color:))`,
  'gi',
)

// WS-05: dimming by opacity, a token's colour made see-through on text, and text sized by hand.
export const OPACITY = /(?<![\w-])opacity-(?:\d|\[|\()/g
export const ARBITRARY_TEXT = /(?<![\w-])text-(?:\[|\()/g
// `text-<colour token>/NN`, for the colour names app.css maps (Tailwind's own `text-sm/6` sets a
// line height and is not a colour).
export function textOpacity(colours: readonly string[]): RegExp {
  return new RegExp(`(?<![\\w-])text-(?:${colours.map(c => c.replace(/[-]/g, '\\-')).join('|')})\\/`, 'g')
}

// WS-06: a focus ring is never taken away.
export const NO_OUTLINE_CLASS = /(?<![\w-])outline-(?:none|0|hidden)(?![\w-])/g
export const NO_OUTLINE_CSS = /\boutline(?:-width)?\s*:\s*(?:none|0)(?:px)?\s*[;}!]/gi

// WS-07: no HTML from strings.
export const HTML_FROM_STRINGS =
  /\b(?:dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe)\b|\bdocument\s*\.\s*write(?:ln)?\b/g

// WS-08: no Popover API (Safari 17; the floor is iOS 16.4) and no process.env in browser code.
export const POPOVER = /\b(?:show|hide|toggle)Popover\b|\bpopover(?:Target(?:Action)?)?\s*=|\bpopovertarget/gi
export const PROCESS_ENV = /\bprocess\s*\.\s*env\b/g

// WS-11: sign-in and session code read no flag (CLAUDE.md: flags gate features, never an access
// check or a privacy or safety control; AUTH-DESIGN §10.5, D46). Nothing under these folders imports
// a module in flags/ or one of these names, wherever it comes from. The session runtime alone may
// hold flagsQuery: a flags nudge invalidates it (R-47), and the stalled gateway's probe fetches it
// to learn only whether the session still holds (T19 item 11, R-48); neither reads a flag.
export const NO_FLAGS_DIRS = ['sign-in/', 'session/'] as const
export const FLAG_READERS = new Set([
  'useFlag',
  'useFlags',
  'flagsQuery',
  'FlagSlot',
  'AiSlot',
  'AI_SLOTS',
  'readFlagsAnswer',
  'FLAGS',
  'FlagsResponse',
])
export const FLAGS_QUERY_HOLDERS = new Set(['session/runtime.ts'])
export const FLAGS_PATH = /\/api\/flags\b/

// WS-12: passkeys are dormant (OD-01, D46): no WebAuthn ceremony in the browser code, neither the
// create call nor the publicKey options either ceremony takes. credentials.get() alone stays
// allowed, since the WebOTP API reads an SMS code through it with `otp:` options.
export const WEBAUTHN = /\bcredentials\s*\.\s*create\s*\(|\bPublicKeyCredential\b|\bpublicKey\s*:/g

export const matchesOf = (pattern: RegExp, text: string) => [...text.matchAll(pattern)].map(match => match[0])
