/**
 * The name of a release line as the URL writes it: `0.<minor>.x` before 1.0, `<major>.x` from 1.0. Unanchored, for a route
 * constraint — a single group, because the router anchors a constraint by putting `^` and `$` around it, which would bind to the
 * first and last alternative only. {@link isLine} anchors it. `scripts/website-lines.ts` imports these rules; this file imports nothing, so the script adds nothing to the app.
 */
export const LINE_PATTERN = '(?:0\\.(?:0|[1-9]\\d*)|[1-9]\\d*)\\.x';

const LINE = new RegExp(`^${LINE_PATTERN}$`);

export const isLine = (name: string): boolean => LINE.test(name);

/** The line a version belongs to: `0.3.0` → `0.3.x`, `1.4.2` → `1.x`; none for anything else (a pre-release too). */
export function lineOf(version: string): string | undefined {
  const zero = /^0\.(0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.exec(version);
  if (zero) return `0.${zero[1]}.x`;
  const major = /^([1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.exec(version);
  return major ? `${major[1]}.x` : undefined;
}

/** Orders `<major>.<minor>.<patch>` numerically (negative when `a` is older). */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split('.').map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index++) {
    const difference = (x?.[index] ?? 0) - (y?.[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
