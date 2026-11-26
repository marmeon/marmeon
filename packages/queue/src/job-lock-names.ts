/**
 * @internal Every pair `[short, long]` of names where `long` is `short` followed by `:` and more. A unique or
 * `withoutOverlapping()` lock is named by the job's name and its key, so `short` with the key `b:c` and `long` with the key `c`
 * (when `long` is `short:b`) name one lock. Deduplicated, sorted by `short`, then `long`.
 */
export function lockNamePairs(names: readonly string[]): [string, string][] {
  const unique = [...new Set(names)].sort();
  const pairs: [string, string][] = [];
  for (const short of unique) {
    for (const long of unique) {
      if (long.startsWith(`${short}:`)) pairs.push([short, long]);
    }
  }
  return pairs;
}
