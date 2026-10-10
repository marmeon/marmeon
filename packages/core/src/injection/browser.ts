import { readFileSync } from 'node:fs';
import { dirname, join, matchesGlob, relative, sep } from 'node:path';

/**
 * A package's browser-only sources: globs relative to the package directory, from its package.json —
 * `"marmeon": { "browser": ["src/client/**", "src/page.ts"] }`.
 *
 * The injection transform leaves these files alone. A browser class is never built by the
 * container, so it needs neither a list nor a reason — and every string attached to it would be shipped to
 * every browser (`"Cannot inject src/client/…"`: 0.8 KB gzip in the client core alone).
 */
export function browserSources(packageDir: string): readonly string[] {
  const json = readPackageJson(join(packageDir, 'package.json'));
  const browser: unknown = json?.marmeon?.browser;
  if (browser === undefined) return [];
  if (!Array.isArray(browser) || !browser.every((glob) => typeof glob === 'string')) {
    throw new TypeError(`${join(packageDir, 'package.json')}: "marmeon.browser" must be a list of globs relative to the package, e.g. ["src/client/**"].`);
  }
  return browser;
}

/** Whether `file` (relative to the package directory) matches one of the package's browser globs. */
export function matchesBrowserSource(packageRelative: string, globs: readonly string[]): boolean {
  const path = packageRelative.split(sep).join('/');
  return globs.some((glob) => matchesGlob(path, glob));
}

const packageOf = new Map<string, { dir: string; globs: readonly string[] } | null>();

/**
 * Whether `file` is a browser-only source of the package it belongs to (the nearest package.json above it).
 * For the load hook and the Vite plugin, which see one file at a time; package.json files are read once.
 */
export function isBrowserSource(file: string): boolean {
  const found = owningPackage(dirname(file));
  return found !== null && found.globs.length > 0 && matchesBrowserSource(relative(found.dir, file), found.globs);
}

function owningPackage(dir: string): { dir: string; globs: readonly string[] } | null {
  const cached = packageOf.get(dir);
  if (cached !== undefined) return cached;
  let found: { dir: string; globs: readonly string[] } | null;
  if (readPackageJson(join(dir, 'package.json')) !== undefined) {
    found = { dir, globs: browserSources(dir) };
  } else {
    const parent = dirname(dir);
    found = parent === dir ? null : owningPackage(parent);
  }
  packageOf.set(dir, found);
  return found;
}

function readPackageJson(path: string): { marmeon?: { browser?: unknown } } | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined; // none, or not readable: other tools report a broken package.json
  }
}
