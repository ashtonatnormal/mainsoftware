// The copy the api client gives a failure the server didn't describe (T21, P6). Every refusal the
// server sends carries its own British message (MESSAGES in @hearth/shared), and the client shows
// that; these are for what never reached the server or came back unreadable.
export const API_COPY = {
  // No answer: offline, the request was cut off, or it ran past its time limit.
  network: "Hearth can't be reached. Check your connection, then try again.",
} as const
