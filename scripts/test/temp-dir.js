// A plain JavaScript module with its declaration beside it (temp-dir.d.ts): every package's tests import it by a relative path, and a
// TypeScript source outside a package's `rootDir` would break its composite build (`tsc -b`) — a declaration file does not.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, onTestFinished } from 'vitest';

/** Directories made outside a test (at a file's top, in a `describe` or a `beforeAll`): removed when the file is done. */
const pending = new Set();

// Registered while the test file is collected (the module is imported statically): the file's last `afterAll` — Vitest runs after-hooks
// in reverse order, so the file's own hooks (closing a server that uses the directory) run first.
afterAll(() => {
  for (const dir of pending) remove(dir);
});

function remove(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  pending.delete(dir);
}

/**
 * A fresh temporary directory (`<os.tmpdir()>/<prefix>XXXXXX`) that removes itself: made inside a test, when the test ends; made
 * anywhere else in a test file, when the file's tests are done. The prefix starts with `marmeon-`, so the run's hygiene check
 * (`scripts/test/temp-hygiene.ts`) names whatever is left behind.
 *
 * @param {string} prefix e.g. `marmeon-env-`
 * @returns {string} the directory's path (not resolved: wrap it in `realpathSync` where symlinks matter, e.g. macOS `/var`)
 */
export function tempDir(prefix) {
  if (!prefix.startsWith('marmeon-')) throw new Error(`tempDir("${prefix}"): the prefix starts with "marmeon-", so the hygiene check sees what is left.`);
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    onTestFinished(() => remove(dir));
  } catch {
    // Not inside a test: with the file.
    pending.add(dir);
  }
  return dir;
}
