// What the page says before the app has loaded (T21, D-02). main.ts loads this table statically,
// before preBoot() runs, so it imports nothing (WS-10): a string here may not come from
// @hearth/shared or any other package.
export const BOOT = {
  // The app's own code couldn't be fetched, or GET /api/session failed: shown as plain text in
  // #root, with no React and no styles of its own.
  cantReach: "Can't reach Hearth. Check your connection, then reload.",
} as const
