import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** Whether `real` lies inside `root` (both real paths) and is not `root` itself. */
export function isInside(root: string, real: string): boolean {
  const inside = relative(root, real);
  return !(inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside));
}

/** Whether `path` lies in `root` or is `root`, without a `node_modules` below `root`: a package nested there is another package. */
export function belongsTo(root: string, path: string): boolean {
  const inside = relative(root, path);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return false;
  return !inside.split(sep).some((segment) => segment.toLowerCase() === 'node_modules');
}

/** ENOENT, or ENOTDIR: a path below a file (`data.json/index.d.ts`) is absent, and the file above it is what is judged. */
function absent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if (absent(error)) return false;
    throw error;
  }
}

/**
 * Whether the file `entry` belongs to the package in `dir`: it lies in it by its path (no `..` or `node_modules` segment) and by its
 * real path, so a symlink cannot lead out. A file that does not exist yet (an unbuilt subpath) is tolerated, unless it is a dangling
 * link, or a directory above it is one that leads out: the target could appear before the entry is imported.
 */
export function entryInside(dir: string, entry: string): boolean {
  if (!belongsTo(resolve(dir), resolve(entry))) return false;
  const root = realpathSync.native(dir);
  try {
    return isInside(root, realpathSync.native(entry));
  } catch (error) {
    if (!absent(error)) return false;
  }
  if (isLink(entry)) return false;
  let ancestor = dirname(resolve(entry));
  for (;;) {
    try {
      const real = realpathSync.native(ancestor);
      return real === root || isInside(root, real);
    } catch (error) {
      if (!absent(error)) return false;
    }
    if (isLink(ancestor)) return false;
    const parent = dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
}
