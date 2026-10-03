/**
 * "Firefox on macOS" — what a person recognizes of a `User-Agent`, not the whole header (the notification keeps this,
 * never the raw string). Unknown parts are left out; nothing known at all is null.
 */
export function describeBrowser(agent: string | null): string | null {
  if (!agent) return null;
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /OPR\//.test(agent)
      ? 'Opera'
      : /Firefox\//.test(agent)
        ? 'Firefox'
        : /Chrome\//.test(agent)
          ? 'Chrome'
          : /Safari\//.test(agent)
            ? 'Safari'
            : /curl\//.test(agent)
              ? 'curl'
              : undefined;
  const system = /iPhone|iPad/.test(agent)
    ? 'iOS'
    : /Android/.test(agent)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(agent)
        ? 'macOS'
        : /Windows/.test(agent)
          ? 'Windows'
          : /Linux/.test(agent)
            ? 'Linux'
            : undefined;
  if (browser && system) return `${browser} · ${system}`;
  return browser ?? system ?? null;
}
