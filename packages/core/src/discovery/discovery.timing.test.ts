import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { generateManifest, marmeonField } from './discover.ts';
import { runtimeConditions, type PackageInfo } from './resolve.ts';

// Wall-clock tests run alone and last (the `timing` project), so no other test competes for the CPU. `discovery.test.ts` proves
// what these inputs yield; here is only how long it takes.
describe('the time discovery needs for a hostile package.json', () => {
  it('reads a field of 200 000 keys, 5 000 levels and 100 000 entries in linear time', () => {
    // Walking each key against all the others would be 4·10¹⁰ steps, minutes against the bound of 2 s; the linear read takes
    // a few tens of milliseconds.
    const field = (marmeon: unknown): PackageInfo => ({ name: '@acme/marmeon-audit', dir: '/x', json: { name: '@acme/marmeon-audit', marmeon } as PackageInfo['json'] });
    const many = Object.fromEntries(Array.from({ length: 200_000 }, (_, index) => [`key${index}`, index]));
    let deep: unknown = 'leaf';
    for (let level = 0; level < 5_000; level++) deep = { next: deep };
    const started = performance.now();
    expect(() => marmeonField(field(many))).toThrow('unknown key "key0"');
    expect(() => marmeonField(field({ providers: ['A'], extra: deep }))).toThrow('unknown key "extra"');
    expect(() => marmeonField(field({ providers: deep }))).toThrow('"providers" is not a list');
    expect(() => marmeonField(field({ experimental: deep }))).toThrow('"experimental" is neither');
    expect(marmeonField(field({ providers: Array.from({ length: 100_000 }, () => 'A') }))?.providers).toHaveLength(100_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('ignores "dependencies" that is no object in well under a second, even as a 10 MB string', () => {
    // Reading a 10 MB string as a list of names would look up 10⁷ packages on disk: minutes against the bound of 1 s.
    for (const dependencies of ['x'.repeat(10_000_000), 42, true, ['a', 'b'], null]) {
      const root = tempDir('marmeon-hostile-');
      const app = join(root, 'app');
      mkdirSync(app, { recursive: true });
      writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', type: 'module', dependencies }));
      const started = performance.now();
      expect(generateManifest({ root: app, conditions: runtimeConditions([], '') }).summary.packages).toEqual([]);
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });
});
