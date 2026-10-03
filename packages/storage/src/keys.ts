import { InvalidKeyError } from './errors.ts';

/** Longest key a disk takes (S3's limit, in UTF-8 bytes). */
export const MAX_KEY_BYTES = 1024;

/**
 * Checks a storage key and returns it unchanged — or throws {@link InvalidKeyError}. Every disk runs every key through it
 * (also the memory disk of tests), so a key means the same file everywhere:
 *
 * - relative, `/`-separated segments: `avatars/7.webp` — no leading `/`, no drive letter (`C:`), no empty segment (`a//b`);
 * - no `.` or `..` segment — a key never leaves its directory, there is nothing to resolve;
 * - no backslash (a separator on Windows, and in some proxies), no NUL byte and no other control character.
 *
 * Nothing is "cleaned up": a key that needs it is refused, so two spellings never name one file. The local driver
 * additionally keeps every path inside its root by `realpath` (symlinks out of the root are refused) — a second,
 * independent measure.
 */
export function normalizeKey(key: string): string {
  if (typeof key !== 'string' || key === '') throw new InvalidKeyError(String(key), 'a key is a non-empty string');
  if (Buffer.byteLength(key) > MAX_KEY_BYTES) throw new InvalidKeyError(key, `longer than ${MAX_KEY_BYTES} bytes`);
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new InvalidKeyError(key, 'it contains a NUL byte or another control character');
  if (key.includes('\\')) throw new InvalidKeyError(key, 'it contains a backslash — keys use "/"');
  if (key.startsWith('/')) throw new InvalidKeyError(key, 'it is absolute — keys are relative to the disk');
  if (/^[A-Za-z]:/.test(key)) throw new InvalidKeyError(key, 'it starts with a drive letter');
  for (const segment of key.split('/')) {
    if (segment === '') throw new InvalidKeyError(key, 'it has an empty segment (a trailing or double "/")');
    if (segment === '.' || segment === '..') throw new InvalidKeyError(key, `it has a "${segment}" segment`);
  }
  return key;
}

/** A directory for `list()`: `''` (the disk's root) or a key; a trailing `/` is allowed. */
export function normalizeDirectory(directory: string): string {
  if (directory === '' || directory === '/') return '';
  return normalizeKey(directory.endsWith('/') ? directory.slice(0, -1) : directory);
}

/** The key's last segment: `exports/7.csv` → `7.csv`. */
export function basename(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

/** The key as a URL path: every segment percent-encoded, `/` kept. */
export function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

/**
 * The key from a URL path below a prefix (`/storage/avatars/7.webp` → `avatars/7.webp`): each segment percent-decoded, then
 * checked by {@link normalizeKey}. An encoded `/` (`..%2f`) becomes a separator *before* the check — so it is checked too.
 * `undefined` for anything that is not a valid key (malformed escapes included).
 */
export function keyFromPath(pathname: string, prefix: string): string | undefined {
  const base = prefix.endsWith('/') ? prefix : `${prefix}/`;
  if (!pathname.startsWith(base)) return undefined;
  try {
    return normalizeKey(
      pathname
        .slice(base.length)
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/'),
    );
  } catch {
    return undefined;
  }
}
