import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/** A regular file as it was read: its text (cut at `maxBytes`), its size and when it was changed. */
export interface RegularFile {
  readonly text: string;
  readonly size: number;
  readonly modifiedAt: Date;
  readonly truncated: boolean;
}

/** The most a read returns when the caller names no bound. */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The regular file at `path` — at most `maxBytes` of it, cut at a character boundary — or undefined. The file is opened without
 * following a symlink (ELOOP) and judged by the descriptor it opened, so nothing can be swapped in between the check and the
 * read; with `identity`, also only when that descriptor is the file the caller resolved. A file that grows while it is read is cut at `maxBytes`.
 */
export function readRegularFile(path: string, maxBytes = DEFAULT_MAX_BYTES, identity?: { readonly dev: number | bigint; readonly ino: number | bigint }): RegularFile | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return undefined;
    if (identity && (stat.dev !== identity.dev || stat.ino !== identity.ino)) return undefined;
    // Never more than the file had when it was looked at: one byte more than that tells a file that grew from one that did not.
    // Unzeroed, because only the bytes read are ever shown, and a zeroed 16 MiB per read would cost more than the read.
    const cap = Math.min(maxBytes, stat.size);
    const buffer = Buffer.allocUnsafe(cap + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    const truncated = length > cap;
    let end = Math.min(length, cap);
    // Do not end inside a multi-byte character: back up to the byte that starts it.
    if (truncated) while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
    return { text: buffer.subarray(0, end).toString('utf8'), size: Math.max(stat.size, length), modifiedAt: stat.mtime, truncated };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** The text of a regular file, or undefined (see {@link readRegularFile}). */
export function readRegular(path: string): string | undefined {
  return readRegularFile(path)?.text;
}

/**
 * The regular file `relative` below `root`, or undefined — also when a directory on the way is a link that leads out of `root`.
 * The file that was resolved is the one that is read (device and inode), so a swap after the check is refused.
 */
export function readRegularIn(root: string, relative: string, maxBytes?: number): RegularFile | undefined {
  let identity: { dev: number; ino: number };
  try {
    const real = realpathSync(join(root, relative));
    const base = realpathSync(root);
    if (!real.startsWith(base.endsWith(sep) ? base : base + sep)) return undefined;
    const { dev, ino } = statSync(real);
    identity = { dev, ino };
  } catch {
    return undefined;
  }
  return readRegularFile(join(root, relative), maxBytes, identity);
}
