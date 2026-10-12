// The AI-free guard (D41, BUILD-PLAN C0.1). Stages C0–C6 make no model calls, so no package that
// calls a model, recognises speech, detects voice activity, runs on-device ML or reads text from
// images may be installed or imported. ai-free.test.ts checks every package.json (npm aliases
// included), every npm lockfile (so a dependency of a dependency counts too), every import, and
// every script and HTML file for the browser's own speech recognition and built-in AI, for the ML
// voice-isolation constraint, and for code loaded from a public CDN, which would bypass npm and so
// every check above. Biome's noRestrictedGlobals (biome.json) also refuses the bare globals in plain
// JavaScript. From A0, packages/model becomes the one place a model SDK may live, and this guard
// gets an exception for it then.

// `*` stands for any run of characters, so '@ai-sdk/*' is the whole scope and '*whisper*' any
// name containing "whisper". Add a newly found package to the group it belongs to.
export const BANNED_PACKAGES: Record<string, string[]> = {
  'a model SDK': [
    'openai',
    '@openai/*',
    '@anthropic-ai/*',
    'ai', // the Vercel AI SDK
    '@ai-sdk/*',
    'langchain',
    '@langchain/*',
    'llamaindex',
    '@llamaindex/*',
    'mastra',
    '@mastra/*',
    '@google/genai',
    '@google/generative-ai',
    '@google-ai/*',
    '@google-cloud/vertexai',
    '@google-cloud/aiplatform',
    '@google-cloud/translate',
    '@google-cloud/text-to-speech',
    '@google-cloud/language',
    '@google-cloud/dialogflow*',
    'ibm-watson',
    '@aws-sdk/client-bedrock*',
    '@aws-sdk/client-sagemaker*',
    '@aws-sdk/client-comprehend*',
    '@aws-sdk/client-lex*',
    '@aws-sdk/client-qbusiness',
    '@aws-sdk/client-qconnect',
    '@aws-sdk/client-qapps',
    '@aws-sdk/client-translate',
    '@aws-sdk/client-polly',
    '@azure/openai',
    '@azure/ai-*',
    '@azure-rest/ai-*',
    '@mistralai/*',
    'cohere-ai',
    'groq-sdk',
    'replicate',
    'ollama',
    'together-ai',
    'voyageai',
    '@mixedbread-ai/*',
    '@fal-ai/*',
    '@cerebras/*',
    'portkey-ai',
    '@huggingface/*',
    '@xenova/*',
    '@livekit/agents*',
  ],
  'speech-to-text or speech detection': [
    '*whisper*',
    '*speech-recognition*', // wrappers that call the browser's SpeechRecognition from node_modules
    'annyang',
    'deepspeech*',
    '@deepgram/*',
    'assemblyai',
    '@google-cloud/speech',
    '@aws-sdk/client-transcribe*',
    'microsoft-cognitiveservices-speech-sdk',
    '@speechmatics/*',
    '@soniox/*',
    '@gladiaio/*',
    'revai-node-sdk',
    '@google-cloud/video-intelligence',
    'vosk*',
    'sherpa-onnx*',
    '@picovoice/*',
    '@ricky0123/*', // Silero VAD for the browser and Node
    'node-vad',
    'webrtcvad',
    '*fvad*',
    'echogarden',
    '@echogarden/*',
    'elevenlabs',
    '@elevenlabs/*',
  ],
  'on-device ML or noise suppression': [
    'onnxruntime-*',
    'onnxjs',
    'cld3-asm', // a neural language detector
    '@tensorflow/*',
    '@tensorflow-models/*',
    '@mediapipe/*',
    '@vladmandic/*',
    'ml5',
    '@mlc-ai/*',
    '@wllama/*',
    'node-llama-cpp',
    '@node-llama-cpp/*',
    '@livekit/krisp-noise-filter',
    '@livekit/noise-cancellation*',
    '*rnnoise*',
    '*noise-suppress*',
    '@types/dom-chromium-ai', // types for the browser's built-in AI
  ],
  OCR: [
    '*tesseract*',
    '@aws-sdk/client-textract',
    '@aws-sdk/client-rekognition*',
    '@google-cloud/vision',
    '@google-cloud/documentai',
    '@azure/cognitiveservices-*',
    'scribe.js*',
    'ocrad.js',
    '@gutenye/ocr-*',
    '@paddlejs-models/*',
  ],
}

// The browser's own speech recognition and built-in AI. TypeScript's DOM types declare none of
// these, so typed code reaches them through window, globalThis or self, a cast, a local `declare`,
// or types from a package such as @types/dom-speech-recognition (banned above). BROWSER_AI finds
// those uses in code, with comments stripped; Biome also refuses the bare globals (biome.json).
export const BANNED_GLOBALS = [
  'SpeechRecognition',
  'webkitSpeechRecognition',
  'LanguageModel',
  'Summarizer',
  'Translator',
  'LanguageDetector',
  'Writer',
  'Rewriter',
  'Proofreader',
]
export const BROWSER_AI = new RegExp(
  [
    // Names no ordinary code of ours uses, anywhere: SpeechRecognitionResult and the like don't match.
    String.raw`\b(?:webkit)?SpeechRecognition\b`,
    String.raw`\b(?:LanguageModel|Summarizer|LanguageDetector|Rewriter|Proofreader)\b`,
    // Translator and Writer are common words, so only as the browser's: through window, globalThis
    // or self, after a cast, as an `in` check, or by their entry points.
    String.raw`\b(?:window|globalThis|self)\s*(?:\??\.\s*|\[\s*['"\x60])(?:Translator|Writer)\b`,
    String.raw`\)\s*(?:\??\.\s*|\[\s*['"\x60])(?:Translator|Writer)\b`,
    String.raw`['"\x60](?:Translator|Writer)['"\x60]\s+in\b`,
    String.raw`\b(?:Translator|Writer)\s*\??\.\s*(?:create|availability|capabilities)\s*\(`,
    // Chrome's earlier window.ai namespace, by its entry points (ai.* feature flags don't match).
    String.raw`\bai\s*\??\.\s*(?:languageModel|summarizer|translator|languageDetector|writer|rewriter|assistant)\s*\??\.\s*(?:create|capabilities|availability)\s*\(`,
  ].join('|'),
)

// The getUserMedia constraint for the browser's ML voice isolation, unless it turns it off.
// Matched in code with comments stripped: reading the setting (`.voiceIsolation`) is allowed, and so
// is setting it to false (`voiceIsolation: false`, `{ exact: false }` or `{ ideal: false }`); any
// other key, shorthand or assignment is refused. livekit-client asks for it by default and this
// guard can't see library defaults, so every C2 capture path passes `voiceIsolation: false`: the
// Room's audioCaptureDefaults (which reach only room.localParticipant) and every standalone
// createLocalTracks, createLocalAudioTrack or usePreviewTracks call, which use the library's own
// defaults. The stock components-react PreJoin can't turn it off, so C2 doesn't use it.
export const BANNED_CONSTRAINT =
  /(?<!\.\s*)\bvoiceIsolation\b(?!['"]?\s*:\s*(?:false\b|\{\s*(?:exact|ideal)\s*:\s*false\s*\}))|\.\s*voiceIsolation\s*=(?![=>])(?!\s*false\b)/

// Public CDNs that serve npm packages as browser code, with any subdomain (jsDelivr has several).
// Hearth's code comes through npm, where the lockfile check and npm audit see it, so nothing loads
// code from these. A denylist can't name every CDN; C0.8's Content Security Policy is the backstop.
export const CDN_URL =
  /(?:https?:)?\/\/(?:[\w-]+\.)*(?:esm\.sh|esm\.run|skypack\.dev|unpkg\.com|npmcdn\.com|jsdelivr\.net|jspm\.dev|jspm\.io|cdnjs\.cloudflare\.com|deno\.land)\b[^\s'"`)<>]*/gi

const banned = Object.entries(BANNED_PACKAGES).flatMap(([why, globs]) =>
  globs.map(glob => ({ why, glob, re: new RegExp(`^${glob.split('*').map(escapeRegExp).join('.*')}$`) })),
)

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Why a package is banned, e.g. 'a model SDK', or undefined if it's allowed.
export function bannedReason(name: string): string | undefined {
  return banned.find(b => b.re.test(name))?.why
}

// The package a dependency value installs when it isn't the dependency's own name: an npm alias
// such as "npm:openai@^4" installs openai under another name.
export function aliasTarget(value: unknown): string | undefined {
  return typeof value === 'string' ? value.match(/^npm:(@[^/@]+\/[^/@]+|[^/@]+)/)?.[1] : undefined
}

// Every package a package-lock.json installs, including nested copies, by the folder it's installed
// in and by its own name (an npm alias or a tarball installs a package under another folder name).
export function lockfilePackages(lock: { packages?: Record<string, { name?: string }> }): string[] {
  return Object.entries(lock.packages ?? {}).flatMap(([path, entry]) => {
    const folder = path.includes('node_modules/') ? path.slice(path.lastIndexOf('node_modules/') + 13) : undefined
    return [...new Set([folder, entry.name])].filter((name): name is string => !!name)
  })
}
