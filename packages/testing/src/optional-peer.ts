import { lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Whether `directory` or an ancestor of it has an entry `node_modules/<name>` — the walk Node's resolver does. Any entry counts, a dangling link too. */
async function walk(name: string, start: string): Promise<boolean> {
  let directory = start;
  for (;;) {
    try {
      await lstat(join(directory, 'node_modules', name));
      return true;
    } catch (error) {
      // Only "there is nothing" says absent; a permission error or the like leaves it unknown, which counts as installed.
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return true;
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

/** Walks from the directory of `from` as written (`--preserve-symlinks` resolves from there) and from its real path. A path it cannot read counts as installed. */
async function installed(name: string, from: string): Promise<boolean> {
  try {
    const written = dirname(fileURLToPath(from));
    const real = await realpath(written);
    return (await walk(name, written)) || (real !== written && (await walk(name, real)));
  } catch {
    // Unsure where to look: treated as installed, so the original error is thrown.
    return true;
  }
}

// Only "absent" is kept, never an error: `importSession()` runs once per view (the TestApp constructor, through sessionAccess:
// actingAs(), withHeaders(), …) and the other loaders once per createTestApp, and the probe and the walk cost a few
// milliseconds for a package that is not there.
const absent = new Set<string>();

/**
 * Loads an optional peer: `undefined` only when the load fails with ERR_MODULE_NOT_FOUND and the package `name` is not installed.
 * Any other failure (a syntax error from version skew, a missing dependency of the package, a missing subpath file) is thrown, so
 * a broken install fails the test instead of running it without the package's fake.
 *
 * All three checks must agree, and each can only make "installed" more likely: `import.meta.resolve(name)` fails with
 * ERR_MODULE_NOT_FOUND (resolving loads nothing, so a package that a resolver hook supplies, or whose dependency is missing, is
 * found), a bare `import(name)` fails with it too (the resolver that failed may have been configured differently, by an alias or
 * `--preserve-symlinks`), and no `node_modules/<name>` is on disk (the runner reports a missing file of an installed package with
 * the package's name, and the wording of messages is not stable). Known misses: a package that only a Vite `resolve.alias` of
 * this load reaches, and that neither the resolve nor the bare import nor the disk shows, counts as absent; and a package
 * installed after an absent answer in the same process stays absent until the process (one test file, by default) ends.
 * `from`, `resolve` and `probe` exist for tests.
 *
 * @internal
 */
export async function importOptional<T>(
  name: string,
  load: () => Promise<T>,
  {
    from = import.meta.url,
    resolve = (specifier: string): unknown => import.meta.resolve(specifier),
    probe = (specifier: string): Promise<unknown> => import(specifier),
  }: { from?: string; resolve?: (specifier: string) => unknown; probe?: (specifier: string) => Promise<unknown> } = {},
): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    const { code } = (error ?? {}) as { code?: unknown };
    if (code !== 'ERR_MODULE_NOT_FOUND') throw error;
    const key = `${from}\0${name}`;
    if (absent.has(key)) return undefined;
    try {
      resolve(name);
      throw error; // Resolved: the package is there.
    } catch (resolveError) {
      if (resolveError === error || (resolveError as { code?: unknown } | null)?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
    try {
      await probe(name);
    } catch (probeError) {
      if ((probeError as { code?: unknown } | null)?.code === 'ERR_MODULE_NOT_FOUND' && !(await installed(name, from))) {
        absent.add(key);
        return undefined;
      }
    }
    throw error;
  }
}
