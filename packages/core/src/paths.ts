import { lstatSync, type Stats, readlinkSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { isInside } from './discovery/contain.ts';

/**
 * Where a write to `target` would leave `root`: the project-relative path of the link (or of `target` itself, when it lies
 * outside by its path) — `undefined` when the real location of its deepest existing ancestor is `root` or below it. A link
 * that stays inside the project is fine, also one to nothing yet (the write creates what it points at), as long as that lies inside too.
 * Both sides are resolved with `realpath`, so a root reached over a link (a temp directory on macOS) works.
 */
export function escapesRoot(root: string, target: string): string | undefined {
  return escapes(realpathSync(root), root, target, 0);
}

function escapes(realRoot: string, root: string, target: string, depth: number): string | undefined {
  const path = resolve(root, target);
  let ancestor = path;
  for (;;) {
    const entry = statOf(ancestor);
    if (entry !== undefined) {
      let real: string;
      try {
        real = realpathSync(ancestor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !entry.isSymbolicLink()) return relative(root, ancestor);
        // A dangling link: the write would create what it points at, which must lie inside as well.
        if (depth > 8) return relative(root, ancestor);
        const aim = resolve(dirname(ancestor), readlinkSync(ancestor));
        return escapes(realRoot, root, aim, depth + 1) === undefined ? undefined : relative(root, ancestor);
      }
      if (real === realRoot || isInside(realRoot, real)) return undefined;
      return relative(root, linkOf(ancestor, root) ?? path);
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return relative(root, path);
    ancestor = parent;
  }
}

/** `lstat`, with `undefined` for what is not there — also below a file (`ENOTDIR`). */
function statOf(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

/** The link on the way from `from` up to `root` that leads out, if the path has one. */
function linkOf(from: string, root: string): string | undefined {
  let current = from;
  for (;;) {
    if (statOf(current)?.isSymbolicLink()) return current;
    const parent = dirname(current);
    if (parent === current || relative(root, parent).startsWith('..')) return undefined;
    current = parent;
  }
}
