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
// these, so code reaches them through window or globalThis, or through types from a package such as
// @types/dom-speech-recognition (banned above). BROWSER_AI finds those uses in source; Biome also
// refuses the bare names (biome.json).
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
    // Speech recognition, by name in any form: SpeechRecognitionResult and the like don't match.
    String.raw`\b(?:webkit)?SpeechRecognition\b`,
    // The built-in AI APIs through window, globalThis or self, by property or by key.
    String.raw`\b(?:window|globalThis|self)\s*(?:\??\.\s*|\[\s*['"\x60])(?:${BANNED_GLOBALS.join('|')})\b`,
    // Their entry points, which classes of ours that share a name don't have.
    String.raw`\b(?:LanguageModel|Summarizer|Translator|LanguageDetector|Writer|Rewriter|Proofreader)\s*\.\s*(?:create|availability|capabilities)\s*\(`,
    // Chrome's earlier window.ai namespace.
    String.raw`\bai\s*\??\.\s*(?:languageModel|summarizer|translator|languageDetector|writer|rewriter|assistant)\b`,
  ].join('|'),
)

// The getUserMedia constraint for the browser's ML voice isolation, unless it turns it off.
// livekit-client asks for it by default, so C2's rooms must set `voiceIsolation: false` (in
// audioCaptureDefaults), which this allows; `{ exact: false }` is allowed too.
export const BANNED_CONSTRAINT = /\bvoiceIsolation\b(?!['"]?\s*:\s*(?:false\b|\{\s*exact\s*:\s*false\s*\}))/

// Public CDNs that serve npm packages as browser code. Hearth's code comes through npm, where the
// lockfile check and npm audit see it, so nothing loads code from these.
export const CDN_URL =
  /(?:https?:)?\/\/(?:esm\.sh|esm\.run|cdn\.skypack\.dev|unpkg\.com|(?:cdn|fastly|gcore)\.jsdelivr\.net|jspm\.dev|ga\.jspm\.io|cdnjs\.cloudflare\.com|deno\.land|cdn\.esm\.sh)\b[^\s'"`)<>]*/g

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
