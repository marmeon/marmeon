import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { DeclarationReader } from './declarations.ts';

const reads = vi.hoisted(() => new Map<string, number>());
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      reads.set(String(path), (reads.get(String(path)) ?? 0) + 1);
      return (fs.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readFileSync,
  };
});

describe('the exports of a declaration file', () => {
  it('leave out what is exported as a type only — a class so has no value to inject', () => {
    const dir = tempDir('marmeon-declarations-');
    writeFileSync(join(dir, 'a.d.ts'), 'export declare class Real {\n    constructor(x: Other);\n}\nexport declare class Hidden {\n    constructor(x: Other);\n}\nexport declare class Mixed {}\nexport interface Other {}\n');
    writeFileSync(join(dir, 'entry.d.ts'), "export { Real } from './a.js';\nexport type { Hidden } from './a.js';\nexport { type Mixed } from './a.js';\n");
    const exports = new DeclarationReader().read(join(dir, 'entry.d.ts'), { name: 'p', dir }).exports;
    expect([...exports.keys()].sort()).toEqual(['Real']);
  });

  it('leave out the local forms of a type-only export too', () => {
    const dir = tempDir('marmeon-declarations-');
    writeFileSync(join(dir, 'local.d.ts'), 'declare class Real {\n    constructor(x: Real);\n}\ndeclare class Hidden {}\ndeclare class Mixed {}\nexport { Real };\nexport type { Hidden };\nexport { type Mixed };\n');
    const exports = new DeclarationReader().read(join(dir, 'local.d.ts'), { name: 'p', dir }).exports;
    expect([...exports.keys()].sort()).toEqual(['Real']);
  });
});

describe('relative imports of a declaration file', () => {
  it('reach the index of the package through ".." and "./", though the candidate above the package lies outside', () => {
    const dir = tempDir('marmeon-declarations-');
    mkdirSync(join(dir, 'pkg/sub'), { recursive: true });
    writeFileSync(join(dir, 'pkg.d.ts'), 'export declare class Outside {}\n');
    writeFileSync(join(dir, 'pkg/index.d.ts'), 'export declare class Inside {}\n');
    writeFileSync(join(dir, 'pkg/sub/x.d.ts'), "export * from '..';\n");
    writeFileSync(join(dir, 'pkg/y.d.ts'), "export * from './';\n");
    const owner = { name: 'p', dir: join(dir, 'pkg') };
    for (const file of ['sub/x.d.ts', 'y.d.ts']) {
      expect([...new DeclarationReader().read(join(dir, 'pkg', file), owner).exports.keys()], file).toEqual(['Inside']);
    }
  });

  it('are read once each when a chain that is too deep fails again and again', () => {
    const dir = tempDir('marmeon-declarations-');
    for (let index = 0; index < 100; index++) writeFileSync(join(dir, `f${index}.d.ts`), `export * from './f${index + 1}.js';\n`);
    const reader = new DeclarationReader();
    reads.clear();
    for (let attempt = 0; attempt < 50; attempt++) expect(() => reader.read(join(dir, 'f0.d.ts'), { name: 'p', dir })).toThrow(/nested deeper than 64/);
    for (const [file, count] of reads) expect(count, file).toBeLessThanOrEqual(1);
  });

  it('are not followed out of the package: the file outside is never read', () => {
    const dir = tempDir('marmeon-declarations-');
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'outside.d.ts'), 'export declare class Outside {}\n');
    writeFileSync(join(dir, 'pkg/index.d.ts'), "export * from '../outside.js';\n");
    const owner = { name: 'p', dir: join(dir, 'pkg') };
    const outside = /^\[marmeon:K7\] p imports "\.\.\/outside\.js" in its types, which lies outside the package\.$/;
    reads.clear();
    const reader = new DeclarationReader();
    expect(() => reader.relativeTarget(join(dir, 'pkg/index.d.ts'), '../outside.js', owner)).toThrow(outside);
    expect(() => reader.read(join(dir, 'pkg/index.d.ts'), owner)).toThrow(outside);
    expect([...reads.keys()].filter((file) => file.endsWith('outside.d.ts'))).toEqual([]);
  });
});
