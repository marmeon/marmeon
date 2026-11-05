import { describe, expect, it } from 'vitest';
import { jsRealpathHits } from './check-source.ts';

/** A file in a pull request can be anything: no rule may take time that grows faster than the file. */
describe('check:source — the real-path rule reads a hostile file in linear time', () => {
  it.each([
    ['unclosed braces that name realpath', '{ realpath '.repeat(20_000)],
    ['imports that never close', 'import { realpath '.repeat(20_000)],
    ['plain imports that never close', 'import { a '.repeat(20_000)],
    ['braces only', '{'.repeat(50_000)],
    ['requires', 'const { realpath '.repeat(10_000) + "require('fs')"],
    ['many closed imports, each on its own line', "import { a } from 'x';\n".repeat(20_000)],
    ['many realpath imports, each on its own line', "import { realpath } from 'fs';\n".repeat(20_000)],
  ])('%s', (_name, text) => {
    const start = performance.now();
    jsRealpathHits([{ path: 'packages/x/src/a.ts', text }]);
    expect(performance.now() - start).toBeLessThan(200);
  });
});
