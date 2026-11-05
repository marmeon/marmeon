import { describe, expect, it } from 'vitest';
import { matchParams } from './pattern.ts';

// Wall-clock tests run alone and last (the `timing` project). A path is request text: a run of slashes that does not end the path
// must not cost a scan of the rest of the run from each of its slashes.
const time = (run: () => unknown): number => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe('the time of matching a path against a pattern', () => {
  it('takes linear time for a long run of slashes inside the path', () => {
    const path = `/teams/7${'/'.repeat(100_000)}x`;
    let found: unknown = 0;
    expect(time(() => (found = matchParams('/teams/:team', path)))).toBeLessThan(1000);
    expect(found).toBeUndefined();
  });

  it('takes linear time for a long run of slashes a constraint accepts', () => {
    const path = `/files/a${'/'.repeat(100_000)}x`;
    let found: unknown;
    expect(time(() => (found = matchParams('/files/:path{.+}', path)))).toBeLessThan(1000);
    expect(found).toEqual({ path: `a${'/'.repeat(100_000)}x` });
  });

  it('takes linear time for a long run of slashes at the end', () => {
    expect(time(() => matchParams('/teams/:team', `/teams/7${'/'.repeat(100_000)}`))).toBeLessThan(1000);
  });
});
