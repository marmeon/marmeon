import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { marmeon } from './__fixtures__/cli.js';
import { tempDir } from '../../../scripts/test/temp-dir.js';

describe('a .marmeon that links out of the app', { timeout: 60_000 }, () => {
  it('stops marmeon discover with the message alone, no stack frame, and writes nothing there', () => {
    const root = tempDir('marmeon-link-');
    const outside = tempDir('marmeon-link-outside-');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }));
    mkdirSync(join(root, 'bootstrap'));
    symlinkSync(outside, join(root, '.marmeon'), 'dir');
    const result = marmeon(root, ['discover']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/\.marmeon leads out of the app.*Nothing was written\./);
    expect(result.stderr).not.toMatch(/^\s+at /m);
    expect(result.stderr).not.toContain(root);
    expect(readdirSync(outside)).toEqual([]);
  });
});
