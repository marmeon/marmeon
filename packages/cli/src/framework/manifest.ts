import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** A version a registry serves, not a range or a tag: `1.0.0`, `1.0.0-rc.1`. */
export const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** An exact version with well-formed prerelease and build identifiers, the only form that joins an install command (`EXACT` is the looser form `check` has always used). */
export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** The names of the framework's packages, as a package manager may be told them. */
export const FRAMEWORK_NAME = /^(?:marmeon|@marmeon\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

/** `workspace:*`, `file:…`, `link:…`, `catalog:`, `npm:…`: a package that is not looked up by version. */
export const PROTOCOL = /^[a-z]+:/;

export interface Manifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly packageManager?: unknown;
  readonly workspaces?: unknown;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

export const isFramework = (name: string): boolean => name === 'marmeon' || name.startsWith('@marmeon/');

/** The manifest in `file`, or `undefined` when it cannot be read or is not JSON (anything else, a stack overflow included, is thrown). */
export function readManifest(file: string): Manifest | undefined {
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof manifest === 'object' && manifest !== null ? (manifest as Manifest) : undefined;
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && 'code' in error)) return undefined;
    throw error;
  }
}

/** The places `node_modules/<name>` is looked for from `dir`. pnpm keeps the dependencies of a package beside it (`…/node_modules/@marmeon/core` next to `…/node_modules/@marmeon/storage`). */
const candidatesAt = (dir: string, name: string): string[] => [join(dir, 'node_modules', name), ...(basename(dir) === 'node_modules' ? [join(dir, name)] : [])];

/**
 * The installed package `name` as `from` (the app's root or a package's real directory) resolves it: `node_modules/<name>` there or in a parent.
 * A copy whose `package.json` has no readable version is passed over (what `check` has always done); {@link resolveFirst} is the strict form.
 * With `within`, the search ends at that directory (the app's own packages are never taken from above the app).
 */
export function resolveInstalled(from: string, name: string, within?: string): { readonly dir: string; readonly manifest: Manifest } | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    for (const candidate of candidatesAt(dir, name)) {
      if (!existsSync(join(candidate, 'package.json'))) continue;
      const real = realpathSync.native(candidate);
      const manifest = readManifest(join(real, 'package.json'));
      if (manifest?.version !== undefined) return { dir: real, manifest };
    }
    if (dir === within || dirname(dir) === dir) return undefined;
  }
}

/**
 * The first directory with a `package.json` that `name` resolves to from `from`, as Node would load it, however that file looks:
 * `manifest` is `undefined` when it cannot be parsed, and its `version` is whatever it says. The caller refuses what it cannot judge.
 * With `within`, the search ends at that directory. With `cache`, a manifest is read once per real directory.
 */
export function resolveFirst(from: string, name: string, within?: string, cache?: Map<string, Manifest | undefined>): { readonly dir: string; readonly manifest: Manifest | undefined } | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    for (const candidate of candidatesAt(dir, name)) {
      if (!existsSync(join(candidate, 'package.json'))) continue;
      const real = realpathSync.native(candidate);
      if (cache?.has(real)) return { dir: real, manifest: cache.get(real) };
      const manifest = readManifest(join(real, 'package.json'));
      cache?.set(real, manifest);
      return { dir: real, manifest };
    }
    if (dir === within || dirname(dir) === dir) return undefined;
  }
}
