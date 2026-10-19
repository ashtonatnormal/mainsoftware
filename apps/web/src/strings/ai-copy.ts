// The words no text the app shows may hold before its AI stages (T21; R-35, decision 8, D41,
// OD-06). Stages C0 to C6 build no AI, so no screen may suggest any: no "Ask", no "AI", no
// assistant or agent, no "coming soon", and no sparkle mark. strings/strings.test.ts holds every
// string table to it (ST-02), and the e2e suite's noAiCopy check holds every visible text and
// accessible name to it, so the unit test and the screen check share one list. It imports nothing,
// so the e2e side can load it under plain Node.
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
