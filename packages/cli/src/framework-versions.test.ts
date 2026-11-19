import { describe, expect, it } from 'vitest';
import { breaksBetween, compareVersions, parseVersion, type Version } from './framework/versions.ts';

const v = (text: string): Version => {
  const version = parseVersion(text);
  if (!version) throw new Error(`not a version: ${text}`);
  return version;
};

describe('parseVersion', () => {
  it('reads an exact version with prerelease and build', () => {
    expect(parseVersion('1.2.3-rc.1+build.5')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['rc', 1], text: '1.2.3-rc.1+build.5' });
  });

  it.each(['^1.0.0', '1.0', 'latest', 'file:x', '1.0.0 --x', '', 'v1.0.0', '01.0.0', '1.0.0-', '1.0.0-01', 'npm:evil@1.0.0', '1.0.0\n', '1.0.0-9007199254740993', '9007199254740993.0.0', '1.0.0+.', '1.0.0+a..b', '1.0.0+', '1.0.0+a.', '1.0.0+.a'])('refuses %j', (text) => {
    expect(parseVersion(text)).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('orders by semver precedence and ignores build metadata', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-rc.1', '1.0.0-rc.10', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
    for (let low = 0; low < ordered.length; low++) {
      for (let high = 0; high < ordered.length; high++) {
        expect(compareVersions(v(ordered[low]!), v(ordered[high]!))).toBe(low === high ? 0 : low < high ? -1 : 1);
      }
    }
    expect(compareVersions(v('1.0.0+a'), v('1.0.0+b'))).toBe(0);
  });
});

describe('breaksBetween', () => {
  it.each([
    ['0.3.0', '0.4.0', true],
    ['0.3.0', '0.3.9', false],
    ['1.1.0', '1.9.0', false],
    ['1.9.0', '2.0.0', true],
    ['2.0.0', '1.9.0', true],
    ['1.2.0-rc.1', '1.2.0', false],
    ['0.4.0-rc.1', '0.4.0', false],
  ])('%s to %s is %s', (from, to, breaks) => {
    expect(breaksBetween(v(from), v(to))).toBe(breaks);
  });
});
