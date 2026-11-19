/** An exact version as a registry serves it: `1.0.0`, `1.0.0-rc.1`, `1.0.0+build`. */
export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
  readonly text: string;
}

const PARTS = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** The version `text` names, or `undefined` for anything but an exact `x.y.z[-pre][+build]` (a range, a tag, a spec with a protocol or extra words). */
export function parseVersion(text: string): Version | undefined {
  const parts = PARTS.exec(text);
  if (!parts) return undefined;
  const [major, minor, patch] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  const identifiers = parts[4] === undefined ? [] : parts[4].split('.');
  // A numeric identifier is a number only when it is exact as one, or the comparison would round.
  if (identifiers.some((id) => id === '' || (/^\d+$/.test(id) && ((id.length > 1 && id.startsWith('0')) || !Number.isSafeInteger(Number(id)))))) return undefined;
  const prerelease = identifiers.map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  return { major, minor, patch, prerelease, text };
}

/** Semver precedence of `a` against `b`; build metadata does not count. */
export function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  // A version without a prerelease is above the same version with one.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const [left, right] = [a.prerelease[index], b.prerelease[index]];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1;
    // Numbers sort below words.
    if (typeof left === 'number') return -1;
    if (typeof right === 'number') return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/** Whether going from `from` to `to` may break an app: another major, or while the major is 0 another minor. */
export function breaksBetween(from: Version, to: Version): boolean {
  return from.major !== to.major || (from.major === 0 && from.minor !== to.minor);
}

/** The release a version belongs to: `1.2.0-rc.1` and `1.2.0+build` are both of `1.2.0`. */
export function releaseOf(version: Version): Version {
  return { major: version.major, minor: version.minor, patch: version.patch, prerelease: [], text: `${version.major}.${version.minor}.${version.patch}` };
}
