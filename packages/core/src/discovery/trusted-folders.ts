import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Whether `dir` may be a root above the app: not writable by everyone (so not `/tmp`, where anyone can plant a marker), and owned by the
 * user of the process, by root or by `owner` (the owner of the app: a deploy user owns the code, another user runs the service). A
 * directory a group may write counts as trusted: its members work on the repository and could change it anyway. Windows has no
 * `getuid`, and its `mode` says nothing about who may write, so there the check passes.
 */
export function trusted(dir: string, owner?: number): boolean {
  if (process.platform === 'win32') return true;
  try {
    const { mode, uid } = statSync(dir);
    if (mode & 0o002) return false;
    const me = process.getuid?.();
    return me === undefined || uid === me || uid === 0 || uid === owner;
  } catch {
    return false;
  }
}

/** The user that owns the app folder: a folder of that user is as trusted as one of the process's user. */
export function appOwner(app: string): number | undefined {
  try {
    return statSync(app).uid;
  } catch {
    return undefined;
  }
}

/**
 * The last folder of the way up from the app that can be trusted: the way ends below the first folder above the app that `trusted`
 * refuses, so markers and lockfiles are looked for only up to here. The app folder itself is always accepted.
 */
export function trustedTop(app: string): string {
  const owner = appOwner(app);
  let top = app;
  for (let dir = dirname(app); dir !== top && trusted(dir, owner); dir = dirname(dir)) top = dir;
  return top;
}

/**
 * The nearest of the lockfiles `names`, from `root` (a real path) up to the last trusted folder ({@link trustedTop}), the folder at the
 * bound included; `undefined` when none lies within the bound.
 */
export function findLockfile(root: string, names: readonly [string, ...string[]]): string | undefined {
  const top = trustedTop(root);
  for (let dir = root; ; dir = dirname(dir)) {
    for (const name of names) {
      if (existsSync(join(dir, name))) return join(dir, name);
    }
    if (dir === top || dirname(dir) === dir) return undefined;
  }
}
