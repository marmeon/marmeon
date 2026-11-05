import { type Stats, closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { escapesRoot } from '@marmeon/core/internal';
import type { CommandInput } from './command.ts';

/**
 * Says so and returns `true` when writing any of `files` would go through a link out of the project (a cloned repository can
 * carry one) or one of the files is a link to nothing: the caller writes nothing then. Checked for all files before the first write.
 */
export function leavesProject(input: Pick<CommandInput, 'root' | 'output'>, files: readonly string[]): boolean {
  for (const file of files) {
    const link = escapesRoot(input.root, file);
    const name = link === undefined ? relative(input.root, file) : link;
    const message = link !== undefined
      ? `${name.split(/[\\/]/).join('/')} leads out of the project, and the command would write through it. Replace the link with a real file or directory. Nothing was written.`
      : isLinkToNothing(file)
        ? `${name.split(/[\\/]/).join('/')} is a link to nothing, and the command would create what it points at. Remove the link. Nothing was written.`
        : undefined;
    if (message === undefined) continue;
    input.output.error(message);
    return true;
  }
  return false;
}

/**
 * Says so and returns `true` when one of `files` exists and is a link, has other hard links or is no regular file, and `--force`
 * would overwrite it: a link at the name is not followed, and a hard link has no path to check. Call it with `--force` only, for
 * the files the command overwrites, before the first write.
 */
export function refusesOverwrite(input: Pick<CommandInput, 'root' | 'output'>, files: readonly string[]): boolean {
  for (const file of files) {
    let entry: Stats | undefined;
    try {
      entry = lstatSync(file, { throwIfNoEntry: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
      throw error;
    }
    if (entry === undefined || (entry.isFile() && entry.nlink <= 1)) continue;
    input.output.error(`${relative(input.root, file).split(/[\\/]/).join('/')} is a link, a hard link or no regular file, and --force would write through it. Remove it, then run the command again. Nothing was written.`);
    return true;
  }
  return false;
}

function isLinkToNothing(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink() && !existsSync(file);
  } catch (error) {
    // Nothing there, or a file where a directory should be: no link.
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

/**
 * Writes a generated file, creating its folders. A file that is not there yet is created with `wx` (`O_CREAT|O_EXCL`), which
 * fails with `EEXIST` at any link on its name — also one that appeared after {@link leavesProject} looked. An existing file is
 * opened with `O_NOFOLLOW`, so a link at its name is refused, and one with other hard links is refused: the caller has
 * checked `--force`, and a link there has no path to check. A link in a folder on the way is {@link leavesProject}'s to find,
 * before the write. Throws instead of writing through anything it refuses.
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
