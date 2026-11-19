/**
 * `source` made to fit `max` UTF-16 units after `escape`: escaped whole when it fits, otherwise the longest prefix whose escaped
 * form plus `…` fits. The prefix is escaped on its own, so a cut never lands inside an escape (`&amp;`, `\*`); a surrogate pair is
 * never split. Providers count characters in units, UTF-16 being the stricter reading. `''` when `max` is below 1.
 * @internal
 */
export function fitEscaped(source: string, escape: (text: string) => string, max: number): string {
  if (max < 1) return '';
  const whole = escape(source);
  if (whole.length <= max) return whole;
  const points = Array.from(source);
  const attempt = (count: number): string => `${escape(points.slice(0, count).join('').trimEnd())}…`;
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (attempt(middle).length <= max) low = middle;
    else high = middle - 1;
  }
  return attempt(low);
}

/** The text itself, for fields the provider shows as written. @internal */
export function plain(text: string): string {
  return text;
}

/** The largest `count` from `low` to `high` for which `fits` holds, `fits` getting stricter as `count` grows; `undefined` when not even `low` fits. @internal */
export function largest(low: number, high: number, fits: (count: number) => boolean): number | undefined {
  if (!fits(low)) return undefined;
  let best = low;
  let top = high;
  while (best < top) {
    const middle = Math.ceil((best + top) / 2);
    if (fits(middle)) best = middle;
    else top = middle - 1;
  }
  return best;
}
