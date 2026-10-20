import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The lockfiles a package manager writes at the root of what it installs. */
export const LOCKFILES: readonly string[] = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'deno.lock'];

function realOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * Whether `dir` may be a root above the app: not writable by everyone (so not `/tmp`, where anyone can plant a lockfile and a
 * workspace declaration), and owned by the user of the process or by root. A directory a group may write counts as trusted: its
 * members work on the repository and could change the migrations anyway. Windows has no `getuid` and its `mode` says nothing about
 * who may write, so there the check passes.
 */
function trusted(dir: string): boolean {
  if (process.platform === 'win32') return true;
  try {
    const { mode, uid } = statSync(dir);
    if (mode & 0o002) return false;
    const me = process.getuid?.();
    return me === undefined || uid === me || uid === 0;
  } catch {
    return false;
  }
}

/**
 * The first directory at or above `root` (by its real path) with a lockfile, or `root` itself when none has one. The way up ends at
 * the first lockfile, so it never leaves the installation the app belongs to.
 */
export function installRoot(root: string): string {
  const start = realOr(root);
  for (let dir = start; ; dir = dirname(dir)) {
    // A directory above the app that others can write to, or that another user owns, ends the way up at the app: its lockfile is no one's to trust.
    if (LOCKFILES.some((lockfile) => existsSync(join(dir, lockfile)))) return dir === start || trusted(dir) ? dir : start;
    if (dirname(dir) === dir) return start;
  }
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
 * The real directory the source of an app may lie in: its install root when that declares a workspace, else the app root. Tools
 * whose workspace this does not read (Deno, Rush, Nx, Lerna) leave the app root, so the rule errs on the narrow side.
 */
export function workspaceRoot(root: string): string {
  const install = installRoot(root);
  const app = realOr(root);
  return install !== app && declaresWorkspace(install) ? install : app;
}
