// What the sign-in screen says (T21, T20; AUTH-DESIGN §10, OD-01, R-78): British English, short and
// active. It never confirms that a number is registered (PRD-53). C0.8 S11 adds each step's copy.
export const SIGN_IN = {
  // The route's title, for the document's title before a step names its own.
  title: 'Sign in',
  heading: 'Sign in to Hearth',
  // Why the last document left (session/document.ts, takeLeftReason): this tab's own Sign out, or
  // anything else (the server ended the session, another tab signed in or out).
  signedOutHere: "You've signed out.",
  signedOut: "You've been signed out.",
} as const
