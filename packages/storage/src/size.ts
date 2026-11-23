import type { OpenedFile } from './disk.ts';

/** On the body of a file whose `size` only stands in as 0, because the store named no length. */
const UNKNOWN_SIZE = Symbol.for('marmeon.storage.unknown-size');

/** `body`, saying that the size of the file it came with is none. It stays on the body, whoever rebuilds the file around it. */
export function unknownSize<S extends ReadableStream>(body: S): S {
  return Object.assign(body, { [UNKNOWN_SIZE]: true });
}

/**
 * The length a file can be announced with: its size, also as digits in a string or as a bigint, as a header takes it. Without
 * one the body is sent to its end, without `Content-Length`.
 */
export function lengthOf(file: OpenedFile): number | undefined {
  const text = String(file.size).trim();
  if (!/^\d+$/.test(text)) return undefined;
  const length = Number(text);
  if (!Number.isSafeInteger(length)) return undefined;
  return length === 0 && typeof file.body === 'object' && file.body !== null && UNKNOWN_SIZE in file.body ? undefined : length;
}
