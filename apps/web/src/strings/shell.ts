// What the shell and its screens say (T21; D29, OD-02, OD-05, decision 8): British English,
// short and active (CLAUDE.md, Conventions). An empty screen says only what is true now: no
// promise of a feature to come, no "coming soon" and no AI copy (strings/strings.test.ts, ST-02).
// The owner may reword any of it in the PR's screenshots.
export const SHELL = {
  appName: 'Hearth',
  // The two navigations (the tab bar and the rail) share one name; only one is shown at a time.
  mainNav: 'Main',
  nav: {
    today: 'Today',
    chats: 'Chats',
    rooms: 'Rooms',
    tasks: 'Tasks',
    calendar: 'Calendar',
    drive: 'Drive',
    more: 'More',
  },
  // Each tab's empty state (OD-02).
  empty: {
    today: 'Nothing for today yet',
    chats: 'No chats yet',
    rooms: 'No rooms yet',
    tasks: 'No tasks yet',
    calendar: 'No events yet',
    drive: 'No files yet',
  },
  notFound: {
    title: 'Page not found',
    body: "We couldn't find that page.",
    toChats: 'Go to Chats',
  },
  // A screen that failed inside the shell, or outside it.
  error: {
    title: 'Something went wrong',
    body: 'This screen hit a problem.',
    retry: 'Try again',
    toChats: 'Go to Chats',
  },
  // The boot couldn't learn who the page belongs to (GET /api/session failed).
  bootError: {
    title: "Can't reach Hearth",
    body: 'Check your connection, then try again.',
    retry: 'Try again',
  },
  // The app failed above every screen (app/App.tsx's RootErrorBoundary).
  crashed: {
    title: 'Something went wrong',
    body: 'Hearth hit a problem. Reload the page to carry on.',
    reload: 'Reload',
  },
  // The avatar menu (OD-05).
  account: {
    menu: 'Account',
    trigger: (name: string) => `Account, ${name}`,
    // Everyone's (C0.9 PD-47).
    settings: 'Settings',
    signOut: 'Sign out',
    signOutFailed: "Couldn't sign out. Check your connection and try again.",
    // The DPO's entry (C0.9 PD-26), shown only when the session's capabilities say so.
    dataProtection: 'Data protection',
  },
  // The privacy notice's screen, outside the shell (C0.9 PD-46), and Settings with its sections
  // (PD-47). What they say is in strings/notice.ts, which only their lazy chunks load.
  notice: 'Privacy notice',
  settings: {
    title: 'Settings',
    privacy: 'Privacy',
  },
  // The DPO's pages' titles (C0.9 PD-26, PD-48, PD-70). Everything else they say is in
  // strings/dpo.ts, dpo-purposes.ts, dpo-transfers.ts, dpo-contact.ts and dpo-notice.ts, which only
  // their lazy chunks load (PD-31).
  dpo: {
    purposes: 'Processing register',
    transfers: 'Transfer register',
    // The DPO's business contact, which the notice prints (C0.9 PD-70).
    contact: 'Contact details',
    // Not /notice's title, so the move there after publishing and back reads as one (C0.9 PD-48).
    notice: 'Publish the notice',
  },
  // The Search bar, built and not shown until C1.7 (OD-04). Never "Search & Ask".
  search: {
    label: 'Search',
    submit: 'Search',
  },
} as const

// The document's title for a screen: "Chats – Hearth", or the screen's own title when it already
// names Hearth ("Can't reach Hearth").
export const documentTitle = (screen: string): string =>
  screen.includes(SHELL.appName) ? screen : `${screen} – ${SHELL.appName}`
