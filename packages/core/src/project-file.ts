import { closeSync, constants, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { ConfigError } from './environment.ts';
import { escapesRoot } from './paths.ts';

/**
 * Writes a generated file, creating its folders. A file that is not there yet is created with `wx` (`O_CREAT|O_EXCL`), which
 * fails with `EEXIST` at any link on its name — also one that appeared after the path was checked. An existing file is
 * opened with `O_NOFOLLOW`, so a link at its name is refused, and one with other hard links is refused: a link there has no
 * path to check. A link in a folder on the way is {@link escapesRoot}'s to find, before the write. Throws instead of writing
 * through anything it refuses.
 */
export function writeProjectFile(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) {
    writeFileSync(file, contents, { flag: 'wx' });
    return;
  }
  // O_TRUNC only after the checks: a hard link to a file elsewhere would lose its content before we looked.
  let fd: number;
  try {
    fd = openSync(file, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('A link at the name of the file, and the command would write through it.', { cause: error });
    }
    throw error;
  }
  try {
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.nlink > 1) throw new Error('A hard link or no regular file at the name of the file, and the command would write through it.');
    ftruncateSync(fd);
    writeFileSync(fd, contents); // writes to the end on the checked descriptor, also after a short write
  } finally {
    closeSync(fd);
  }
}

/**
 * Throws a `ConfigError` when `file` leads out of the project through a link: such a file is neither written nor read (it could be
 * a device or a FIFO). `action` is `'written'` or `'read'`, for the message.
 */
export function refuseLeavingProject(root: string, file: string, action: 'written' | 'read'): void {
  const link = escapesRoot(root, file);
  if (link === undefined) return;
  const name = relative(root, file).split(/[\\/]/).join('/');
  throw new ConfigError(`${link.split(/[\\/]/).join('/')} leads out of the project, and ${name} would be ${action} through it. Replace the link with a real file or directory.${action === 'written' ? ' Nothing was written.' : ''}`);
}

/**
 * Writes a committed generated file (`bootstrap/routes.ts`, `bootstrap/database.d.ts`) under `root` the way the `make:*` generators
 * write theirs: a path that leads out of the project through a link is refused before anything is written, and
 * {@link writeProjectFile} refuses a link or hard link at the name. Throws a `ConfigError` naming the file relative to the project.
 */
export function writeGeneratedFile(root: string, file: string, contents: string): void {
  const name = relative(root, file).split(/[\\/]/).join('/');
  refuseLeavingProject(root, file, 'written');
  try {
    writeProjectFile(file, contents);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new ConfigError(`${name} is a link to nothing, and writing it would create what it points at. Remove the link. Nothing was written.`, { cause: error });
    if (code === undefined) throw new ConfigError(`${name}: ${(error as Error).message} Remove it, then run the command again. Nothing was written.`, { cause: error });
    throw error;
  }
}
