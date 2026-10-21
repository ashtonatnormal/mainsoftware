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

// One module a file loads, read from the syntax tree: an import or re-export (static), an
// import() call (dynamic), a require() (static, and never right in browser code), or Vite's
// import.meta.glob (glob).
export interface WebLoad {
  // undefined when the module is chosen at run time, or by a glob's patterns.
  specifier: string | undefined
  // `import type` and `export type` only. An import whose names are each marked `type`
  // (`import { type A } from 'x'`) still loads x under verbatimModuleSyntax, so it counts.
  typeOnly: boolean
  dynamic: boolean
  // import.meta.glob, eager or not: Vite turns it into static imports ({ eager: true }) or dynamic
  // ones, of whatever files its patterns match, so no reading of the source can follow it.
  glob?: true
}

// `import.meta.glob`, called or not (Vite rewrites only a call, but any use of it is a load).
const isImportMetaGlob = (node: ts.Node) =>
  ts.isPropertyAccessExpression(node) &&
  ts.isMetaProperty(node.expression) &&
  node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
  node.name.text.startsWith('glob')

const literalOf = (node: ts.Node | undefined) => (node && ts.isStringLiteralLike(node) ? node.text : undefined)

export function loadsOf(path: string, source: string): WebLoad[] {
  const found: WebLoad[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const typeOnly = ts.isImportDeclaration(node) ? !!node.importClause?.isTypeOnly : node.isTypeOnly
      found.push({ specifier: literalOf(node.moduleSpecifier), typeOnly, dynamic: false })
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      found.push({ specifier: literalOf(node.moduleReference.expression), typeOnly: node.isTypeOnly, dynamic: false })
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found.push({ specifier: literalOf(node.arguments[0]), typeOnly: false, dynamic: true })
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      found.push({ specifier: literalOf(node.arguments[0]), typeOnly: false, dynamic: false })
    } else if (isImportMetaGlob(node)) {
      found.push({ specifier: undefined, typeOnly: false, dynamic: false, glob: true })
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return found
}

// WS-10 (D-02, T21 item 2): main.ts, the one entry, removes the router's scroll cache (preBoot)
// before any library code evaluates, and only then loads the app by one dynamic import. That holds
// however the bundler splits chunks, as long as main.ts's static import graph reaches no package:
// - every module main.ts loads statically, followed through relative and `@/` imports, is a .css
//   file (a package's stylesheet included) or a module that loads no package (`import type` aside);
// - none of them loads anything dynamically, except main.ts itself, and none (main.ts included)
//   uses import.meta.glob, whose eager form would put a package in the static graph unseen;
// - main.ts makes exactly one dynamic import, of ENTRY_APP, in a top-level statement after the one
//   that calls preBoot().
// `read` gives a file under apps/web/src/ by its path there, or undefined when there is none.
export const ENTRY = 'main.ts'
export const ENTRY_APP = './app/boot.tsx'

export function entryGraph(read: (path: string) => string | undefined): { files: string[]; problems: string[] } {
  const files: string[] = []
  const problems: string[] = []
  const queue = [ENTRY]
  const seen = new Set<string>()
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    if (seen.has(path)) continue
    seen.add(path)
    const source = read(path)
    if (source === undefined) {
      problems.push(`${path}: no such file`)
      continue
    }
    files.push(path)
    if (path.endsWith('.css')) continue
    for (const load of loadsOf(path, source)) {
      if (load.glob) {
        problems.push(`${path}: loads modules by import.meta.glob, which this guard can't follow`)
        continue
      }
      const name = load.specifier ?? '(a name chosen at run time)'
      if (load.dynamic) {
        if (path !== ENTRY) problems.push(`${path}: loads ${name} dynamically; only ${ENTRY} may`)
        continue
      }
      if (load.typeOnly) continue
      if (load.specifier === undefined) {
        problems.push(`${path}: loads ${name}`)
        continue
      }
      if (/\.css(?:\?.*)?$/.test(load.specifier)) {
        const target = srcTarget(path, load.specifier)
        if (target !== undefined) queue.push(target)
        continue
      }
      const target = srcTarget(path, load.specifier)
      if (target === undefined) problems.push(`${path}: imports the package ${load.specifier}`)
      else queue.push(target)
    }
  }
  return { files, problems: [...problems, ...entryOrder(read(ENTRY))] }
}

// main.ts's own shape: one dynamic import, of ENTRY_APP, in a top-level statement after preBoot().
function entryOrder(source: string | undefined): string[] {
  if (source === undefined) return []
  const file = parse(ENTRY, source)
  const problems: string[] = []
  const dynamic = loadsOf(ENTRY, source).filter(load => load.dynamic)
  if (dynamic.length !== 1 || dynamic[0]?.specifier !== ENTRY_APP)
    problems.push(
      `${ENTRY}: makes ${dynamic.length} dynamic imports (${dynamic.map(load => load.specifier).join(', ')}); exactly one, of ${ENTRY_APP}, is allowed`,
    )
  const statementIndex = (test: (node: ts.Node) => boolean): number =>
    file.statements.findIndex(statement => {
      let hit = false
      const visit = (node: ts.Node): void => {
        if (hit) return
        if (test(node)) hit = true
        else ts.forEachChild(node, visit)
      }
      visit(statement)
      return hit
    })
  const preBoot = file.statements.findIndex(
    statement =>
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      ts.isIdentifier(statement.expression.expression) &&
      statement.expression.expression.text === 'preBoot',
  )
  const loadsApp = statementIndex(
    node => ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword,
  )
  if (preBoot === -1) problems.push(`${ENTRY}: calls preBoot() in no top-level statement of its own`)
  else if (loadsApp !== -1 && loadsApp <= preBoot) problems.push(`${ENTRY}: loads the app before preBoot() has run`)
  return problems
}

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

// WS-02: the __ members a file writes may be written only where this names them. CODE_FROM_STRINGS
// sees `window.__x` only when it is spelt so; dunderWrites() sees a write through an alias too.
export const DUNDER_WRITES_ALLOWED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // zod's own settings object, which zod adopts when it loads (zod/v4/core/core.js:
  // `globalThis.__zod_globalConfig ??= {}`). preBoot() sets jitless there before zod loads, so zod
  // builds no code from strings and the CSP's missing 'unsafe-eval' raises no violation report on
  // every load (pre-boot.ts item 4, T21 item 2; boot/zod-preset.test.ts checks zod still adopts
  // it).
  ['boot/pre-boot.ts', new Set(['__zod_globalConfig'])],
])

const UPDATES = new Set([ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken])
const isDunder = (name: string) => name.startsWith('__')

// A string key written literally: 'a', "a" or `a`.
const literalKey = (node: ts.Node | undefined) => (node && ts.isStringLiteralLike(node) ? node.text : undefined)

// The __ members an access chain passes through: `w.__a.b = 1` writes into __a, so it names __a.
function dunderChain(target: ts.Expression): string[] {
  const names: string[] = []
  for (
    let at = bare(target);
    ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at);
    at = bare(at.expression)
  ) {
    const name = accessedName(at)
    if (name !== undefined && isDunder(name)) names.push(name)
  }
  return names
}

// The members a destructuring assignment writes (`({ a: w.__x } = o)`, `[w.__y] = list`). A default
// (`[w.__z = 1] = list`) is an assignment of its own, which the walk meets anyway.
function patternTargets(left: ts.Expression): ts.Expression[] {
  const at = bare(left)
  if (ts.isObjectLiteralExpression(at))
    return at.properties.flatMap(property =>
      ts.isPropertyAssignment(property)
        ? patternTargets(property.initializer)
        : ts.isSpreadAssignment(property)
          ? patternTargets(property.expression)
          : [],
    )
  if (ts.isArrayLiteralExpression(at))
    return at.elements.flatMap(element => patternTargets(ts.isSpreadElement(element) ? element.expression : element))
  if (ts.isBinaryExpression(at)) return []
  return [at]
}

// The __ keys an object literal names (`{ __a: f }`, `{ '__b': f }`, `{ ['__c']: f }`, `{ __d }`,
// `{ __e() {} }`).
function dunderKeys(node: ts.Expression | undefined): string[] {
  const at = node === undefined ? undefined : bare(node)
  if (at === undefined || !ts.isObjectLiteralExpression(at)) return []
  return at.properties.flatMap(property => {
    const name = property.name
    const key =
      name === undefined
        ? undefined
        : ts.isIdentifier(name)
          ? name.text
          : ts.isComputedPropertyName(name)
            ? literalKey(name.expression)
            : literalKey(name)
    return key !== undefined && isDunder(key) ? [key] : []
  })
}

// Calls that define members by key: Object.assign(o, { __a }), Object.defineProperty(o, '__b', d),
// Object.defineProperties(o, { __c: d }), Reflect.set(o, '__d', v), Reflect.defineProperty(o, '__e', d).
function definedDunders(call: ts.CallExpression): string[] {
  const callee = bare(call.expression)
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return []
  const how = `${callee.expression.text}.${callee.name.text}`
  const [, second, ...rest] = call.arguments
  if (how === 'Object.assign') return [second, ...rest].flatMap(dunderKeys)
  if (how === 'Object.defineProperties') return dunderKeys(second)
  if (how === 'Object.defineProperty' || how === 'Reflect.set' || how === 'Reflect.defineProperty') {
    const key = literalKey(second)
    return key !== undefined && isDunder(key) ? [key] : []
  }
  return []
}

// Every write to a __-prefixed member in a file, on any object, by the member's name: an
// assignment of any operator (destructuring and for…of/in targets included), ++ and --, delete,
// and the calls above. A window hook can hide behind an alias the source can't trace (a parameter
// typed as the window, a cast, a variable), so no object is let off; DUNDER_WRITES_ALLOWED names
// the exceptions. A key held in a variable (`w[k] = f`) can't be seen.
export function dunderWrites(path: string, source: string): string[] {
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      found.push(...patternTargets(node.left).flatMap(dunderChain))
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && UPDATES.has(node.operator))
      found.push(...dunderChain(node.operand))
    if (ts.isDeleteExpression(node)) found.push(...dunderChain(node.expression))
    if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && !ts.isVariableDeclarationList(node.initializer))
      found.push(...patternTargets(node.initializer).flatMap(dunderChain))
    if (ts.isCallExpression(node)) found.push(...definedDunders(node))
    ts.forEachChild(node, visit)
  }
  visit(parse(path, source))
  return found
}

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
// check or a privacy or safety control; T21 item 13, D46). Nothing under these folders, and no file
// whose path names sign-in or session, imports a module in flags/ or one of these names, wherever
// it comes from. The session runtime alone may hold flagsQuery: a flags nudge invalidates it
// (T17 item 11), and the stalled gateway's probe fetches it to learn only whether the session still
// holds (T19 item 11); neither reads a flag.
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
// A path segment that names sign-in or session code: `sign-in`, `signin`, `SignInScreen.tsx`,
// `sign-in-model.ts`, `session`, `sessions`, `load-session.ts` (but not `signing`). WS-11 reads
// every runtime file under NO_FLAGS_DIRS or with such a name, and refuses a folder so named
// anywhere but those two (`screens/sign-in/`), so sign-in code can't land where it isn't read.
export const NAMES_SIGN_IN_OR_SESSION = /[sS]ign[-_]?[iI]n(?![a-z])|[sS]ession/

// Whether the rule reads this file: it sits under sign-in/ or session/, or a folder or its own
// name names sign-in or session.
export const isSignInOrSessionCode = (path: string) =>
  NO_FLAGS_DIRS.some(dir => path.startsWith(dir)) ||
  path.split('/').some(segment => NAMES_SIGN_IN_OR_SESSION.test(segment))

// A folder under apps/web/src/ that names sign-in or session other than the top-level sign-in/ and
// session/ (T21 item 13: the sign-in screens live in sign-in/).
export function misplacedSignInOrSessionFolder(path: string): boolean {
  if (NO_FLAGS_DIRS.some(dir => path.startsWith(dir))) return false
  return path
    .split('/')
    .slice(0, -1)
    .some(segment => NAMES_SIGN_IN_OR_SESSION.test(segment))
}

// WS-12: passkeys are dormant (OD-01, D46): no WebAuthn ceremony in the browser code. Read from
// the syntax tree, so comments say nothing and formatting hides nothing, it refuses:
// - the name publicKey anywhere (a key, a shorthand `{ publicKey }`, a binding, a JSX attribute)
//   and the string 'publicKey', which is how either ceremony's options are passed;
// - the name PublicKeyCredential, in a value or a type;
// - `create` read from navigator.credentials: directly (`navigator.credentials.create`,
//   `?.create`, `['create']`), through a name bound to it (`const c = navigator.credentials`, or
//   `const { credentials } = navigator`, then `c.create`), or destructured from it
//   (`const { create } = navigator.credentials`).
// Aliases are followed by name, file-wide and through further aliases, not by scope; code that
// hides the read further (Reflect.get, a computed key) is a reviewer's to catch. credentials.get()
// stays allowed, since the WebOTP API reads an SMS code through it with `otp:` options.
const WEBAUTHN_NAMES = new Set(['publicKey', 'PublicKeyCredential'])
const NAVIGATOR_HOLDERS = new Set(['window', 'globalThis', 'self'])

// An expression with its parentheses, casts and non-null assertions taken off.
function bare(node: ts.Expression): ts.Expression {
  let at = node
  while (
    ts.isParenthesizedExpression(at) ||
    ts.isAsExpression(at) ||
    ts.isNonNullExpression(at) ||
    ts.isSatisfiesExpression(at) ||
    ts.isTypeAssertionExpression(at)
  )
    at = at.expression
  return at
}

// The property an access reads: `a.name` or `a['name']`.
function accessedName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return node.argumentExpression.text
  return undefined
}

// The name a binding element reads from its object: `{ create }` or `{ create: make }` read create.
function boundProperty(element: ts.BindingElement): string | undefined {
  const key = element.propertyName ?? element.name
  return ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined
}

// Adds a name to a set, and says whether it was new.
function addName(names: Set<string>, name: string): boolean {
  if (names.has(name)) return false
  names.add(name)
  return true
}

export function webAuthnUses(path: string, source: string): string[] {
  const file = parse(path, source)
  const navigators = new Set(['navigator'])
  const credentials = new Set<string>()

  // `navigator`, `window.navigator` (or globalThis's, self's), or a name bound to one of them.
  const isNavigator = (node: ts.Expression): boolean => {
    const at = bare(node)
    if (ts.isIdentifier(at)) return navigators.has(at.text)
    if (!(ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at))) return false
    const holder = bare(at.expression)
    return accessedName(at) === 'navigator' && ts.isIdentifier(holder) && NAVIGATOR_HOLDERS.has(holder.text)
  }
  // `<navigator>.credentials`, or a name bound to it.
  const isCredentials = (node: ts.Expression): boolean => {
    const at = bare(node)
    if (ts.isIdentifier(at)) return credentials.has(at.text)
    if (!(ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at))) return false
    return accessedName(at) === 'credentials' && isNavigator(at.expression)
  }

  // Binds names to navigator or navigator.credentials: `const n = navigator`, `c = n.credentials`,
  // `const { credentials: c } = navigator`. Says whether any name was new.
  const bind = (name: ts.BindingName | ts.Expression, value: ts.Expression): boolean => {
    let added = false
    if (ts.isIdentifier(name)) {
      if (isCredentials(value)) added = addName(credentials, name.text) || added
      if (isNavigator(value)) added = addName(navigators, name.text) || added
    } else if (ts.isObjectBindingPattern(name) && isNavigator(value)) {
      for (const element of name.elements)
        if (boundProperty(element) === 'credentials' && ts.isIdentifier(element.name))
          added = addName(credentials, element.name.text) || added
    }
    return added
  }
  const collect = (node: ts.Node): boolean => {
    let added = false
    if (ts.isVariableDeclaration(node) && node.initializer) added = bind(node.name, node.initializer) || added
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      added = bind(bare(node.left), node.right) || added
    ts.forEachChild(node, child => {
      added = collect(child) || added
    })
    return added
  }
  // An alias may be bound before the name it reads is known, so collect until nothing is new.
  let more = true
  while (more) more = collect(file)

  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && WEBAUTHN_NAMES.has(node.text)) found.push(node.text)
    if (ts.isStringLiteralLike(node) && WEBAUTHN_NAMES.has(node.text)) found.push(`'${node.text}'`)
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      accessedName(node) === 'create' &&
      isCredentials(node.expression)
    )
      found.push('credentials.create')
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
      const readsCreate = (pattern: ts.ObjectBindingPattern) =>
        pattern.elements.some(element => boundProperty(element) === 'create')
      if (isCredentials(node.initializer) && readsCreate(node.name)) found.push('{ create } = credentials')
      // `const { credentials: { create } } = navigator`.
      if (
        isNavigator(node.initializer) &&
        node.name.elements.some(
          element =>
            boundProperty(element) === 'credentials' &&
            ts.isObjectBindingPattern(element.name) &&
            readsCreate(element.name),
        )
      )
        found.push('{ credentials: { create } } = navigator')
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

// WS-13: the code and PIN fields leave paste, copy and autofill alone (WCAG 3.3.8, SHL-49,
// T21 item 13): a pasted code and a password manager are the help 3.3.8 says a memory test at
// sign-in must allow. Markup rendered in Node never carries an event handler, so the rule reads
// source: the fields themselves (CLIPBOARD_FIELD_FILES), everything under sign-in/, and every file
// that renders either field (C0.16's re-authentication sheet, wherever it lands). From the syntax
// tree, so comments say nothing, it refuses in those files:
// - a clipboard or beforeinput handler's name, in any case, Capture or not (onPaste, onCopyCapture,
//   onCut, onBeforeInput as a JSX attribute or a key, input.onpaste);
// - the strings 'paste', 'copy', 'cut' and 'beforeinput', and those handler names as strings, which
//   is how addEventListener('paste', …) or a spread `{ ['onPaste']: f }` would reach them.
// A beforeinput handler is refused too, since it can cancel a paste (inputType insertFromPaste).
// What is pasted is cleaned in onChange (normaliseCode), never stopped.
export const CLIPBOARD_FIELD_FILES = new Set([
  'ui/CodeField.tsx',
  'ui/PinField.tsx',
  'ui/Field.tsx',
  'ui/code-field.ts',
])
export const CLIPBOARD_DIRS = ['sign-in/'] as const
const AUTH_FIELDS = new Set(['ui/CodeField.tsx', 'ui/PinField.tsx'])
const CLIPBOARD_HANDLER = /^on(?:paste|copy|cut|beforeinput)(?:capture)?$/i
const CLIPBOARD_EVENT = /^(?:paste|copy|cut|beforeinput)$/i

// Whether WS-13 reads this file (a path under apps/web/src/, and its source).
export function takesAuthInput(path: string, source: string): boolean {
  if (CLIPBOARD_FIELD_FILES.has(path) || CLIPBOARD_DIRS.some(dir => path.startsWith(dir))) return true
  if (path.endsWith('.css')) return false
  return loadsOf(path, source).some(load => {
    const target = load.specifier === undefined ? undefined : srcTarget(path, load.specifier)
    return target !== undefined && AUTH_FIELDS.has(target)
  })
}

// Where a file names a clipboard handler or event, as the guard reports it.
export function clipboardHandlers(path: string, source: string): string[] {
  const names = identifiersOf(path, source).filter(name => CLIPBOARD_HANDLER.test(name))
  const strings = stringsOf(path, source).filter(text => CLIPBOARD_HANDLER.test(text) || CLIPBOARD_EVENT.test(text))
  return [...names, ...strings.map(text => `'${text}'`)]
}

export const matchesOf = (pattern: RegExp, text: string) => [...text.matchAll(pattern)].map(match => match[0])
