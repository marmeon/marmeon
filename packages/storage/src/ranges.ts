import type { ByteRange, OpenedFile } from './disk.ts';
import { StorageError } from './errors.ts';

type Resolved = { readonly start: number; readonly end: number };

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * The range as the caller asked for it, copied, or a `RangeError`: one of `{ start, end? }` and `{ last }`, whole numbers from
 * 0 up, `end` not before `start`. A copy, so what is checked is what the disk and {@link confirmedRange} see.
 */
export function checkRange(range: ByteRange): ByteRange {
  const value = range as unknown as Record<string, unknown> | null;
  if (typeof value !== 'object' || value === null) throw new RangeError('A range is { start, end? } or { last }.');
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'start' && key !== 'end' && key !== 'last') throw new RangeError(`A range is { start, end? } or { last }: it has no "${String(key)}".`);
  }
  const { start, end, last } = value;
  if (last !== undefined) {
    if (start !== undefined || end !== undefined) throw new RangeError('A range is { start, end? } or { last }, not both.');
    if (!isCount(last)) throw new RangeError(`A range's last must be a whole number from 0 up, not ${String(last)}.`);
    return Object.freeze({ last });
  }
  if (start === undefined) throw new RangeError('A range is { start, end? } or { last }: it has neither start nor last.');
  if (!isCount(start)) throw new RangeError(`A range's start must be a whole number from 0 up, not ${String(start)}.`);
  if (end === undefined) return Object.freeze({ start });
  if (!isCount(end)) throw new RangeError(`A range's end must be a whole number from 0 up, not ${String(end)}.`);
  if (end < start) throw new RangeError(`A range's end (${end}) lies before its start (${start}).`);
  return Object.freeze({ start, end });
}

/**
 * The bytes of a checked range in a file of `size` bytes: the first and last byte (inclusive, `end` cut to the file), or
 * `'unsatisfiable'` when it starts at or after the end or asks for the last 0 bytes. `undefined`: the file is empty and the range
 * is a suffix, which asks for "up to this many" bytes, so the whole (empty) file is the answer.
 */
export function resolveRange(range: ByteRange, size: number): Resolved | 'unsatisfiable' | undefined {
  if (range.last !== undefined) {
    if (range.last === 0) return 'unsatisfiable';
    if (size === 0) return undefined;
    return { start: Math.max(0, size - range.last), end: size - 1 };
  }
  if (range.start >= size) return 'unsatisfiable';
  return { start: range.start, end: Math.min(range.end ?? size - 1, size - 1) };
}

/** `body` of no bytes. */
const emptyBody = () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });

/**
 * The file as the app gets it when it asked for no range, or the driver did not opt in: one with a `range` or an `acceptsRanges` is
 * built from named fields, each read once, so neither a made-up `range` nor a claim of the driver passes. The body is taken as the whole file; `startServer()` holds it to `size`.
 */
export function withoutRange(file: OpenedFile, asked = false): OpenedFile {
  // A range was asked: always rebuilt, so a getter that answers later what it did not answer at first reaches nobody.
  if (!asked && file.range === undefined && file.acceptsRanges === undefined) return file;
  const { body, size, lastModified, contentType } = file;
  return { body, size, lastModified, contentType };
}

/** The whole file of a driver that opted in, when no range was asked: named fields read once, `acceptsRanges` the framework's, no `range`. */
export function wholeFile(file: OpenedFile): OpenedFile {
  const { body, size, lastModified, contentType } = file;
  return { body, size, lastModified, contentType, acceptsRanges: true };
}

/**
 * The file a driver opened for `requested` (checked), or a {@link StorageError} after the body is cancelled. A file with no
 * `range` is the whole file: the driver ignored the request. A `range` must be the one {@link resolveRange} gives for the
 * file's `size`; the result is built from what was read once, so a getter that changes later does not matter.
 */
export async function confirmedRange(requested: ByteRange, file: OpenedFile): Promise<OpenedFile> {
  const { body, size, lastModified, contentType } = file;
  const answer = (file as { range?: unknown }).range;
  const acceptsRanges = true;
  if (answer === undefined) return { body, size, lastModified, contentType, acceptsRanges };
  const expected = Number.isSafeInteger(size) && size >= 0 ? resolveRange(requested, size) : null;
  const same =
    expected === 'unsatisfiable'
      ? answer === 'unsatisfiable'
      : expected !== undefined && expected !== null && typeof answer === 'object' && answer !== null && (answer as Resolved).start === expected.start && (answer as Resolved).end === expected.end;
  if (!same || expected === undefined || expected === null) {
    await Promise.resolve(body?.cancel()).catch(() => {});
    throw new StorageError(`The disk's open() answered the range ${JSON.stringify(requested)} with ${JSON.stringify(answer)} for a file of ${String(size)} bytes — range must be the requested bytes of the file, or absent for the whole file.`);
  }
  if (expected === 'unsatisfiable') {
    await Promise.resolve(body?.cancel()).catch(() => {});
    return { body: emptyBody(), size, lastModified, contentType, acceptsRanges, range: expected };
  }
  return { body, size, lastModified, contentType, acceptsRanges, range: { start: expected.start, end: expected.end } };
}
