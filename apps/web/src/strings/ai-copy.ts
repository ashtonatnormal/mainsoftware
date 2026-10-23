// The words no text the app shows may hold before its AI stages (T21; decision 8, D41, OD-06).
// The list moved to packages/shared (ai-copy.ts) in C0.9, so the server holds the privacy notice's
// free text to it when the DPO publishes (C0.9 PD-62). This file keeps its exports, so
// strings.test.ts (ST-02), the e2e suite's noAiCopy check and every screen test read the same list
// through the same path; the e2e side loads @hearth/shared under Node already.
export { AI_COPY, aiCopyIn } from '@hearth/shared'
