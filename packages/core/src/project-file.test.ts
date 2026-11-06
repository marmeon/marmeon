import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from './environment.ts';
import { writeGeneratedFile } from './project-file.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

function project(): { root: string; outside: string } {
  const outside = realpathSync(tempDir('marmeon-project-file-outside-'));
  writeFileSync(join(outside, 'kept.txt'), 'untouched');
  const root = realpathSync(tempDir('marmeon-project-file-'));
  mkdirSync(join(root, 'bootstrap'));
  return { root, outside };
}

describe('writeGeneratedFile', () => {
  it('creates and rewrites a regular file', () => {
    const { root } = project();
    const file = join(root, 'bootstrap/routes.ts');
    writeGeneratedFile(root, file, 'one');
    writeGeneratedFile(root, file, 'two');
    expect(readFileSync(file, 'utf8')).toBe('two');
  });

  it('refuses a link at the name that stays inside the project, and leaves its target', () => {
    const { root } = project();
    writeFileSync(join(root, 'real.ts'), 'untouched');
    symlinkSync(join(root, 'real.ts'), join(root, 'bootstrap/routes.ts'));
    expect(() => writeGeneratedFile(root, join(root, 'bootstrap/routes.ts'), 'x')).toThrow(expect.objectContaining({ name: 'ConfigError', message: expect.stringMatching(/Nothing was written/) }));
    expect(readFileSync(join(root, 'real.ts'), 'utf8')).toBe('untouched');
  });

  it('refuses a link to nothing that points inside the project, and creates nothing behind it', () => {
    const { root } = project();
    symlinkSync(join(root, 'later.ts'), join(root, 'bootstrap/routes.ts'));
    expect(() => writeGeneratedFile(root, join(root, 'bootstrap/routes.ts'), 'x')).toThrow(ConfigError);
    expect(() => writeGeneratedFile(root, join(root, 'bootstrap/routes.ts'), 'x')).toThrow(/link to nothing.*Nothing was written/);
    expect(existsSync(join(root, 'later.ts'))).toBe(false);
  });

  it('refuses a hard link to a file outside the project, and leaves the file', () => {
    const { root, outside } = project();
    linkSync(join(outside, 'kept.txt'), join(root, 'bootstrap/routes.ts'));
    expect(() => writeGeneratedFile(root, join(root, 'bootstrap/routes.ts'), 'x')).toThrow(/hard link.*Nothing was written/);
    expect(readFileSync(join(outside, 'kept.txt'), 'utf8')).toBe('untouched');
  });
});
