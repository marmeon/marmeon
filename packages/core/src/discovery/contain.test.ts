import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { entryInside } from './contain.ts';

/** Paths whose `lstat` fails with EACCES: the link check meets an error that is neither ENOENT nor ENOTDIR. */
const unreadable = vi.hoisted(() => new Set<string>());
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    lstatSync: ((path: unknown, ...rest: unknown[]) => {
      if (unreadable.has(String(path))) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return (fs.lstatSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.lstatSync,
  };
});

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

  it.skipIf(process.getuid?.() === 0)('refuses on an error other than a missing path: an entry below a directory the process cannot enter', () => {
    const dir = realpathSync(tempDir('marmeon-contain-'));
    mkdirSync(join(dir, 'locked'));
    writeFileSync(join(dir, 'locked', 'index.d.ts'), 'export {};\n');
    chmodSync(join(dir, 'locked'), 0o000);
    onTestFinished(() => chmodSync(join(dir, 'locked'), 0o755));
    expect(entryInside(dir, join(dir, 'locked', 'index.d.ts'))).toBe(false);
  });

  it('reads a path below a file as absent, and judges the file: a JSON file in the package is inside, a link out of it is not', () => {
    const base = realpathSync(tempDir('marmeon-contain-'));
    const dir = join(base, 'pkg');
    mkdirSync(dir);
    writeFileSync(join(dir, 'data.json'), '{}');
    writeFileSync(join(base, 'outside.json'), '{}');
    symlinkSync(join('..', 'outside.json'), join(dir, 'link.json'));
    expect(entryInside(dir, join(dir, 'data.json', 'index.d.ts'))).toBe(true);
    expect(entryInside(dir, join(dir, 'link.json', 'index.d.ts'))).toBe(false);
  });

  it('does not take a failing link check for "no link": the error surfaces', () => {
    const dir = realpathSync(tempDir('marmeon-contain-'));
    const entry = join(dir, 'missing.d.ts');
    unreadable.add(entry);
    onTestFinished(() => void unreadable.delete(entry));
    expect(() => entryInside(dir, entry)).toThrow(/EACCES/);
  });
});
