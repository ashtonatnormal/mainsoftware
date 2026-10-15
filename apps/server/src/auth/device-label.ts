// How the device list names a device (ACC-04), from the User-Agent at sign-in: for example
// 'iPhone · Safari', as 0003's devices.label says. The User-Agent itself is never stored, and
// there is no location (no IP geolocation). Rules are checked in order and the first match wins.

const SYSTEMS: readonly [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'Chromebook'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
]

const BROWSERS: readonly [RegExp, string][] = [
  [/EdgA?\/|EdgiOS\//, 'Edge'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/CriOS\/|Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]

const first = (rules: readonly [RegExp, string][], text: string, fallback: string) =>
  rules.find(([pattern]) => pattern.test(text))?.[1] ?? fallback

export function deviceLabel(userAgent: string | undefined): string {
  const text = userAgent ?? ''
  return `${first(SYSTEMS, text, 'Device')} · ${first(BROWSERS, text, 'Browser')}`
}
