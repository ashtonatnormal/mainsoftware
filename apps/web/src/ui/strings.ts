// The kit's own copy (T21, R-78): British English, short and active (CLAUDE.md, Conventions).
// Screens keep theirs in strings/; strings/strings.test.ts reads both for American spellings and
// for words that would suggest AI (ST-01, ST-02).
export const UI = {
  close: 'Close',
  undo: 'Undo',
  back: 'Back',
  skipToContent: 'Skip to content',
  notifications: 'Notifications',
  // A PIN field's switch between dots and digits (ui/PinField.tsx).
  showPin: 'Show PIN',
} as const
