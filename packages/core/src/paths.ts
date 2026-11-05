import { lstatSync, type Stats, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isInside } from './discovery/contain.ts';

/**
 * Where a write to `target` would leave `root`: the project-relative path of the link (or of `target` itself, when it lies
 * outside by its path) — `undefined` when the real location of its deepest existing ancestor is `root` or below it. A link
 * that stays inside the project is fine, also one to nothing yet (the write creates what it points at), as long as that lies inside too.
 * Both sides are resolved with the system's `realpath`, so a root reached over a link (a temp directory on macOS) works.
 */
export function escapesRoot(root: string, target: string): string | undefined {
  return escapes(realpathSync.native(root), root, target, 0);
}

function escapes(realRoot: string, root: string, target: string, depth: number): string | undefined {
  const path = resolve(root, target);
  let ancestor = path;
  for (;;) {
    const entry = statOf(ancestor);
    if (entry !== undefined) {
      let real: string;
      try {
        // `.native` asks the kernel: the JS implementation resolves a link target textually (`d/../x` folds before `d` is followed).
        real = realpathSync.native(ancestor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !entry.isSymbolicLink()) return relative(root, ancestor);
        // A dangling link: the write would create what it points at, which must lie inside as well.
        if (depth > 8) return relative(root, ancestor);
        let aim: string;
        try {
          aim = resolveLinkTarget(dirname(ancestor), readlinkSync(ancestor));
        } catch {
          return relative(root, ancestor);
        }
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

/**
 * Where the kernel would put a link's `target` (read against `parent`) once the parts that do not exist yet are created. The target
 * is not normalised first: `d/../x` leaves the directory `d` points at, which a textual `..` would not. Throws when that cannot be told
 * (a dangling link or an unreadable directory on the way): the caller refuses then.
 */
function resolveLinkTarget(parent: string, target: string): string {
  let existing = isAbsolute(target) ? target : `${realpathSync.native(parent)}${sep}${target}`;
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(existing), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const name = basename(existing);
    if (name === '..' || name === '.' || name === '' || dirname(existing) === existing) throw new Error('A link target that cannot be resolved.');
    missing.unshift(name);
    existing = dirname(existing);
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

/**
 * Why a generated file (`.marmeon/schema.json`, …) may not be written to `file` under `root`: a directory on the way is a link
 * that leads out of the app, and the temporary file and the rename would land there. `undefined` when the writer may go on. The
 * file itself is not looked at: a rename replaces a link there. A link that stays inside the app is allowed. Names the path
 * relative to the app, never an absolute one. Check before `mkdir` and before the write.
 */
export function unsafeGeneratedPath(root: string, file: string): string | undefined {
  const link = escapesRoot(root, dirname(file));
  if (link === undefined) return undefined;
  return `${link} leads out of the app, and ${relative(root, file)} would be written through it. Replace the link with a real directory (or a link that stays inside the app). Nothing was written.`;
}

/**
 * The reading side of {@link unsafeGeneratedPath}: why a generated file may not be read from `file` under `root` — a directory on
 * the way or the file itself leads out of the app (also a dangling link that points out), and what lies there (a manifest, a projection) is not the app's to trust. `undefined` when the file
 * may be read. Check before every read of a file under `.marmeon/`, also the one a writer makes to see whether it changed.
 */
export function unreadableGeneratedPath(root: string, file: string): string | undefined {
  let link: string | undefined;
  try {
    link = escapesRoot(root, file);
  } catch (error) {
    if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    // The file cannot be looked at because its directory cannot be searched. The directory still tells: one that leads out of the app
    // is refused (its owner could open it before the read); inside the app, the read that follows fails and reads nothing.
    try {
      link = escapesRoot(root, dirname(file));
    } catch {
      // Not even the directory can be judged: refuse rather than read on a guess.
      link = relative(root, dirname(file));
    }
  }
  if (link === undefined) return undefined;
  return `${link} leads out of the app, so ${relative(root, file)} was not read. Replace the link with a real directory or file (or a link that stays inside the app).`;
}
