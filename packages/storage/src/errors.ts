/** A mistake in the storage configuration — at startup, or when a disk is first used. */
export class StorageSetupError extends Error {
  override name = 'StorageSetupError';
}

/** A key a disk refuses: `..`, an absolute path, a backslash, a NUL byte, a symlink out of the disk's root. */
export class InvalidKeyError extends Error {
  override name = 'InvalidKeyError';
  readonly key: string;

  constructor(key: string, reason: string) {
    super(`Invalid storage key ${JSON.stringify(key.length > 200 ? `${key.slice(0, 200)}…` : key)}: ${reason}.`);
    this.key = key;
  }
}

/** Reading a file that is not there. */
export class FileNotFoundError extends Error {
  override name = 'FileNotFoundError';
  readonly disk: string;
  readonly key: string;

  constructor(disk: string, key: string) {
    super(`The disk "${disk}" has no file "${key}".`);
    this.disk = disk;
    this.key = key;
  }
}

/** Any other refusal of a disk (`url()` on a private disk, …). */
export class StorageError extends Error {
  override name = 'StorageError';
}

/** "Did you mean …?" — the closest of `known`, if close enough. */
export function didYouMean(name: string, known: readonly string[]): string {
  const distance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const current = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = current;
      }
    }
    return row[b.length]!;
  };
  const best = known.map((candidate) => ({ candidate, d: distance(name, candidate) })).sort((a, b) => a.d - b.d)[0];
  return best && best.d <= Math.max(2, Math.floor(name.length / 3)) ? ` Did you mean "${best.candidate}"?` : '';
}
