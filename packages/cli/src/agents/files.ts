import { accessSync, closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

export function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Why `file` may not be read or written: a link that leads nowhere or out of the app, or something that is no file (a directory, a pipe), or that cannot be read. A file that is not there is fine. */
export function unsafe(root: string, file: string): string | undefined {
  if (!exists(file)) return undefined;
  const name = file.slice(root.length + 1);
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return `${name} is a link that leads nowhere. Remove it or fix it, then run marmeon agents:sync again. Nothing was written.`;
  }
  const inside = realpathSync(root);
  if (real !== inside && !real.startsWith(inside + sep)) return `${name} is a link to ${real}, outside the app. Nothing was written.`;
  if (!statSync(real).isFile()) return `${name} is not a file. Nothing was written.`;
  try {
    accessSync(real, constants.R_OK);
  } catch {
    return `${name} cannot be read. Nothing was written.`;
  }
  return undefined;
}

/**
 * Why the installer may not write `file` (or, with `'directory'`, make it). Every part of the path below `root` that exists is
 * followed to where it really lies, and that must be inside the app and, but for the file itself, a directory; a link that stays in
 * the app is fine, one that leads nowhere or out of it is not. The file itself must be a regular, readable file. A part that is not
 * there yet is fine. Judged before anything is written.
 */
export function unsafePath(root: string, file: string, kind: 'file' | 'directory' = 'file'): string | undefined {
  const parts = relative(root, file).split(sep);
  if (parts[0] === '..' || parts[0] === '') return `${file} is outside the app. Nothing was written.`;
  const inside = realpathSync(root);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const name = parts.slice(0, index + 1).join('/');
    try {
      lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return `${name} cannot be inspected. Nothing was written.`;
    }
    let real: string;
    try {
      real = realpathSync(current);
    } catch {
      return `${name} is a link that leads nowhere. Remove it or fix it. Nothing was written.`;
    }
    if (real !== inside && !real.startsWith(inside + sep)) return `${name} is a link to ${real}, outside the app. Nothing was written.`;
    const wantsFile = index === parts.length - 1 && kind === 'file';
    if (wantsFile ? !statSync(real).isFile() : !statSync(real).isDirectory()) return `${name} is not a ${wantsFile ? 'file' : 'directory'}. Nothing was written.`;
    if (wantsFile) {
      try {
        accessSync(real, constants.R_OK);
      } catch {
        return `${name} cannot be read. Nothing was written.`;
      }
    }
  }
  return undefined;
}

/** Why a file at `file` could not be made or replaced for want of permission: the deepest directory of its path that exists must be writable. */
export function unwritablePath(root: string, file: string): string | undefined {
  let directory = dirname(file);
  while (!exists(directory) && directory !== root && directory !== dirname(directory)) directory = dirname(directory);
  try {
    accessSync(directory, constants.W_OK | constants.X_OK);
  } catch {
    return `${relative(root, directory) || '.'} is not writable. Nothing was written.`;
  }
  return undefined;
}

/**
 * Writes `text` to a new file beside `file` and renames it over, so a reader never sees half a file and a crash leaves the old
 * one. A link at `file` is followed first: the rename replaces the file the link leads to and never the link. An existing file
 * keeps its permissions.
 */
export function writeAtomic(file: string, text: string): void {
  let target = file;
  let mode = 0o666;
  try {
    target = realpathSync(file);
    mode = statSync(target).mode & 0o777;
  } catch {
    // A new file takes the default permissions.
  }
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const descriptor = openSync(temporary, 'wx', mode);
  try {
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
    closeSync(descriptor);
    renameSync(temporary, target);
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // Already closed.
    }
    rmSync(temporary, { force: true });
    throw error;
  }
}
