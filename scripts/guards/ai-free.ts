// The AI-free guard (D41, BUILD-PLAN C0.1). Stages C0–C6 make no model calls, so no package that
// calls a model, recognises speech, detects voice activity, runs on-device ML or reads text from
// images may be installed or imported. ai-free.test.ts checks every package.json, the lockfile (so
// a dependency of a dependency counts too) and every import in the repo. Biome's
// noRestrictedGlobals (biome.json) refuses the browser's own speech recognition and built-in AI.
// From A0, packages/model becomes the one place a model SDK may live, and this guard gets an
// exception for it then.

// `*` stands for any run of characters, so '@ai-sdk/*' is the whole scope and '*whisper*' any
// name containing "whisper". Add to the group a package belongs to.
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
    '@google-cloud/vertexai',
    '@google-cloud/aiplatform',
    '@aws-sdk/client-bedrock*',
    '@aws-sdk/client-sagemaker*',
    '@aws-sdk/client-comprehend*',
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
    '@huggingface/*',
    '@xenova/*',
    '@livekit/agents*',
  ],
  'speech-to-text or speech detection': [
    '*whisper*',
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
    'elevenlabs',
    '@elevenlabs/*',
  ],
  'on-device ML or noise suppression': [
    'onnxruntime-*',
    '@tensorflow/*',
    '@tensorflow-models/*',
    '@mediapipe/*',
    '@livekit/krisp-noise-filter',
    '@jitsi/rnnoise-wasm',
    '@shiguredo/noise-suppression',
  ],
  OCR: ['tesseract*', '@aws-sdk/client-textract', '@aws-sdk/client-rekognition', '@google-cloud/vision'],
}

// The browser's own speech recognition and built-in AI, refused by Biome (biome.json).
export const BANNED_GLOBALS = [
  'SpeechRecognition',
  'webkitSpeechRecognition',
  'Summarizer',
  'Translator',
  'LanguageDetector',
  'LanguageModel',
]

// The getUserMedia constraint that turns on the browser's ML voice isolation.
export const BANNED_CONSTRAINT = /\bvoiceIsolation\b/

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

// Every package name a package-lock.json installs, including nested copies.
export function lockfilePackages(lock: { packages?: Record<string, { name?: string }> }): string[] {
  return Object.entries(lock.packages ?? {}).flatMap(([path, entry]) => {
    const name = path.includes('node_modules/') ? path.slice(path.lastIndexOf('node_modules/') + 13) : entry.name
    return name ? [name] : []
  })
}
