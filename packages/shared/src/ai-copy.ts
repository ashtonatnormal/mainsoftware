// The words no text the app shows may hold before its AI stages (T21; decision 8, D41,
// OD-06). Stages C0 to C6 build no AI, so no screen may suggest any: no "Ask", no "AI", no
// assistant or agent, no "coming soon", and no sparkle mark. apps/web's strings/strings.test.ts
// holds every string table to it (ST-02), and the e2e suite's noAiCopy check holds every visible
// text and accessible name to it, so the unit test and the screen check share one list. From C0.9
// the privacy notice is held to it too: every branch of the generator (notice-text.ts), and the
// DPO's free text, which publishing refuses when it matches (free_text_ai_copy, C0.9 PD-62). It
// lives here so the server can check it; apps/web/src/strings/ai-copy.ts re-exports it. It imports
// nothing, so anything can load it.
export const AI_COPY: readonly RegExp[] = [
  /\bask(?:s|ed|ing)?\b/i,
  /\bAI\b/,
  /\bassistants?\b/i,
  /\bagents?\b/i,
  /\bco-?pilots?\b/i,
  /\bcoming soon\b/i,
  /[✦✧✨]/u,
]

// The first AI_COPY pattern a text matches, for a failure message; undefined when it holds none.
export function aiCopyIn(text: string): RegExp | undefined {
  return AI_COPY.find(pattern => pattern.test(text))
}
