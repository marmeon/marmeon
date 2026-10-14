/** What a `User-Agent` tells about the browser and the system — each `undefined` when it is not one of the known ones. */
export interface DeviceDescription {
  readonly browser: string | undefined;
  readonly system: string | undefined;
}

// Order matters: Edge, Opera and Samsung Internet also say "Chrome", and Chrome also says "Safari".
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:Edg|EdgA|EdgiOS|Edge)\//, 'Edge'],
  [/\b(?:OPR|OPT|Opera|OPiOS)\//, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\b(?:Chrome|CriOS)\//, 'Chrome'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\bSafari\//, 'Safari'],
];

// Android also says "Linux", and iOS says "like Mac OS X": the specific ones first. iPadOS 13+ sends a Macintosh agent and
// is told apart from a Mac only where the agent still says "iPad".
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\bAndroid\b/, 'Android'],
  [/\biPad\b/, 'iPadOS'],
  [/\b(?:iPhone|iPod)\b/, 'iOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b|\bX11\b/, 'Linux'],
];

/**
 * A rough reading of a `User-Agent` for a list of sign-ins: the browser and the system, separately so an app can word
 * them in its own language ("{browser} on {system}"). A heuristic without a dependency — an unknown or missing agent gives
 * `undefined`, and a spoofed one says what the client wants.
 */
export function describeDevice(userAgent: string | undefined): DeviceDescription {
  if (!userAgent) return { browser: undefined, system: undefined };
  return {
    browser: BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1],
    system: SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1],
  };
}
