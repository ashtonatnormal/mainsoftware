// What the sign-in screen says (T20; T21 item 13, OD-01, D46, D29): British
// English, short and active. It never confirms that a number is registered (PRD-53, T14 item 3):
// the code step says the same for any number, and nothing claims a text was sent, because a number
// off the roster gets the same answer and no text, and the global cap or the transfer gate can skip
// a send too. A refusal's own words come from the server (MESSAGES in @hearth/shared); this table
// adds only the step instructions, the tries left, the wait and the lock's end.
//
// No string here may read as AI (strings/strings.test.ts, ST-02): "ask" is one of the words it
// refuses, so a code is something you "get", and an Owner "can reset" a PIN.

// "1 minute", "5 minutes".
const minutes = (n: number) => (n === 1 ? '1 minute' : `${n} minutes`)
// "1 try", "3 tries".
const tries = (n: number) => (n === 1 ? '1 try' : `${n} tries`)

export const SIGN_IN = {
  // The route's title, for the document's title before a step names its own.
  title: 'Sign in',
  heading: 'Sign in to Hearth',
  // Why the last document left (session/document.ts, takeLeftReason): this tab's own Sign out, or
  // anything else (the server ended the session, another tab signed in or out).
  signedOutHere: "You've signed out.",
  signedOut: "You've been signed out.",

  // Each step's h1, which is also the document's title (X6; strings/shell.ts documentTitle).
  steps: {
    phone: 'Sign in to Hearth',
    code: 'Enter your code',
    set_pin: 'Choose a PIN',
    enter_pin: 'Enter your PIN',
    pin_locked: 'Your PIN is locked',
    signed_in: 'Signed in',
  },
  // The document's title for each step, where it differs from the h1.
  titles: {
    phone: 'Sign in',
  },

  // The phone step.
  phoneLabel: 'Mobile number',
  phoneHint: 'Start with + and your country code. For a Singapore number, the 8 digits are enough.',
  sendCode: 'Send code',

  // The code step. The number is shown as the server will read it (formatE164), so a bare 8-digit
  // number shows the +65 it was taken to have.
  codeIntro: (number: string, digits: number, validMinutes: number) =>
    `If ${number} is registered on Hearth, we'll text it a ${digits}-digit code. It can take a minute to arrive, and it works for ${minutes(validMinutes)}.`,
  codeLabel: (digits: number) => `${digits}-digit code`,
  // The code in the field isn't the right number of digits: said before anything is sent.
  enterCode: (digits: number) => `Enter the ${digits}-digit code.`,
  signIn: 'Sign in',
  resend: 'Send a new code',
  // Why "Send a new code" waits (SHL-07): two quick taps would spend the number's three requests
  // in ten minutes (PRD-53), and every text is paid.
  resendWait: 'You can get a new code 30 seconds after the last one.',
  resendReady: 'You can get a new code now.',
  // A new request replaces the old code (T14 item 4), and still claims no send.
  newCode: 'If the number is registered, a new code is on its way. Earlier codes no longer work.',
  differentNumber: 'Use a different number',
  triesLeft: (n: number) => `${tries(n)} left.`,

  // The PIN steps (AQ-02: the roles only an Owner grants keep a PIN as well as the code).
  setPinWhy:
    "Because of your role, you also need a 6-digit PIN. You'll enter it when you sign in on a new device and before admin actions, not every time you open the app.",
  newPin: 'New PIN',
  newPinHint: '6 digits. Avoid repeated digits, runs like 123456 and common PINs.',
  newPinAgain: 'New PIN again',
  pinMismatch: "The PINs don't match. Enter the same 6 digits twice.",
  pinAgainMissing: 'Enter your new PIN again.',
  ifForgotten: "If you forget it, an Owner can reset it after checking it's you.",
  setPin: 'Set PIN and sign in',
  enterPinWhy: 'Because of your role, Hearth needs your PIN when you sign in on a new device.',
  pinLabel: 'PIN',
  forgotPin: 'Forgotten your PIN?',
  forgotPinBody: "An Owner can reset it after checking it's you. Then sign in again with a code and choose a new PIN.",
  // How many wrong PINs are left (T14 item 9): before a 15-minute lock, or, once the next lock
  // would be the 10th failure's, before the lock only an Owner's reset ends (pin-lock.ts).
  pinTries: (n: number, untilReset: boolean) =>
    untilReset
      ? `${tries(n)} left before your PIN locks until an Owner resets it.`
      : `${tries(n)} left before a 15-minute lock.`,
  startAgain: 'Start again',
  // The locked view. A timed lock always outlasts the attempt (10 minutes against 15), so the way
  // on is a new code once it ends.
  lockedTimed: 'Too many wrong PINs. Wait for the lock to end, then try again.',
  lockEnds: (time: string) => `The lock ends at ${time}. You'll need a new code after then.`,
  lockEndsUnknown: "You'll need a new code once the lock ends.",
  lockedReset: "Your PIN is locked. An Owner can reset it after checking it's you.",

  // A refusal with a wait (429): retryAfterSeconds, which the server rounds up to whole minutes.
  tooMany: (wait: string) => `Too many tries. Try again in ${wait}.`,
  // A wait as words: up to 59 minutes in minutes, from an hour in hours, rounded up.
  wait: (seconds: number) => {
    const inMinutes = Math.max(1, Math.ceil(seconds / 60))
    if (inMinutes < 60) return minutes(inMinutes)
    const hours = Math.ceil(inMinutes / 60)
    return hours === 1 ? 'about 1 hour' : `about ${hours} hours`
  },

  // Said once a request has taken a second (WCAG 4.1.3); also the busy button's reason.
  busy: {
    sending: 'Sending…',
    checking: 'Checking…',
  },
  signedIn: 'Signed in. Opening Hearth…',
} as const
