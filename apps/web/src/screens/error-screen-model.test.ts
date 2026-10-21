import { describe, expect, it } from 'vitest'
import { SHELL } from '@/strings/shell.ts'
import { failureAnnouncement, isLoadFailure, retryFor } from './error-screen-model.ts'

describe("T21 item 5: the router's error screen (screens/error-screen-model.ts)", () => {
  it("ER-01 T21 items 2 and 5: Try again reloads the page when a screen's code failed to load in any engine, and loads the route again for anything else", () => {
    const failedLoads = [
      // Chromium, which keeps the failed import in the document's module map.
      new TypeError('Failed to fetch dynamically imported module: https://localhost:5180/assets/MoreScreen-a1b2.js'),
      // Firefox.
      new TypeError('error loading dynamically imported module: https://localhost:5180/assets/MoreScreen-a1b2.js'),
      // WebKit.
      new TypeError('Importing a module script failed.'),
      // Vite's preload helper, when the chunk's stylesheet failed.
      new Error('Unable to preload CSS for https://localhost:5180/assets/MoreScreen-a1b2.css'),
    ]
    for (const error of failedLoads) {
      expect(isLoadFailure(error), error.message).toBe(true)
      expect(retryFor(error), error.message).toBe('reload')
    }
    const others: unknown[] = [
      new Error('chunk'),
      new TypeError("Cannot read properties of undefined (reading 'name')"),
      // Only a message that starts with one of the engines' texts counts.
      new Error('Loader said: Failed to fetch dynamically imported module'),
      'Failed to fetch dynamically imported module',
      { message: 42 },
      null,
      undefined,
    ]
    for (const error of others) {
      expect(isLoadFailure(error), String(error)).toBe(false)
      expect(retryFor(error), String(error)).toBe('invalidate')
    }
  })

  it("ER-02 X11 WCAG 4.1.3: inside the shell, whose h1 names only the place, the failure is announced assertively; above it the screen's own h1 says it", () => {
    expect(failureAnnouncement(true)).toEqual({ text: SHELL.error.title, politeness: 'assertive' })
    expect(failureAnnouncement(false)).toBeUndefined()
  })
})
