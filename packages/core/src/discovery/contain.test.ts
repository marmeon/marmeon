import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { entryInside } from './contain.ts';

describe('entryInside', () => {
  it('follows a link the way the system does: `d/../x` is taken from where `d` leads', () => {
    const base = realpathSync(tempDir('marmeon-contain-'));
    const dir = join(base, 'pkg');
    mkdirSync(dir);
    mkdirSync(join(base, 'outside', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'x'), 'inside');
    writeFileSync(join(base, 'outside', 'x'), 'outside');
    symlinkSync(join('..', 'outside', 'sub'), join(dir, 'd'));
    symlinkSync('d/../x', join(dir, 'evil'));
    expect(entryInside(dir, join(dir, 'evil'))).toBe(false);
    expect(entryInside(dir, join(dir, 'x'))).toBe(true);
  });
});
