import { findLockfile } from '@marmeon/core/internal';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

// More than core's discovery reads: Bun's binary lockfile and Deno's.
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'deno.lock'] as const;

function realOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * The directory of the nearest lockfile at or above `root` (by its real path), or `root` itself when none lies on the way. The way
 * up ends below the first folder that others can write to or that a user other than this user, root or the owner of the app owns:
 * a lockfile above it is no one's to trust, and a planted one in such a folder cannot move the root either.
 */
export function installRoot(root: string): string {
  const start = realOr(root);
  const lockfile = findLockfile(start, LOCKFILES);
  return lockfile === undefined ? start : dirname(lockfile);
}

/** Whether `dir` declares a workspace: a `pnpm-workspace.yaml`, or `workspaces` in its `package.json` (a list, or an object with `packages`). */
function declaresWorkspace(dir: string): boolean {
  if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return true;
  try {
    const { workspaces } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { workspaces?: unknown };
    if (Array.isArray(workspaces)) return true;
    return typeof workspaces === 'object' && workspaces !== null && Array.isArray((workspaces as { packages?: unknown }).packages);
  } catch {
    return false;
  }
}

/**
 * The real directory the source of an app may lie in: its install root when that declares a workspace, else the app root. The
 * install root lies no further up than the last trusted folder (see `installRoot`). Tools whose workspace this does not read (Deno,
 * Rush, Nx, Lerna) leave the app root, so the rule errs on the narrow side.
 */
export function workspaceRoot(root: string): string {
  const install = installRoot(root);
  const app = realOr(root);
  return install !== app && declaresWorkspace(install) ? install : app;
}
