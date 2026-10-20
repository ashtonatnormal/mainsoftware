// What the live connection's banner says (T21 item 4, X11). It shows nothing while the connection
// is up or has been down for under 30 s, so a short drop never chatters; it says "Reconnecting…"
// once the client has been failing for 30 s, and "Connected again." once it is back. After a new
// deploy the page reloads itself at most once a minute (T21 item 4); a second need within the
// minute asks the person to reload.
export const LIVE = {
  reconnecting: 'Reconnecting…',
  connectedAgain: 'Connected again.',
  updated: 'Hearth has been updated. Reload to continue.',
  reload: 'Reload',
} as const
