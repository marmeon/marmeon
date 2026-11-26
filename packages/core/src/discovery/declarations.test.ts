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

describe('an imported class that an entry exports again', () => {
  const owner = (dir: string) => ({ name: 'p', dir });
  const mailer = 'export declare class Mailer {\n    constructor(x: Clock);\n}\nexport interface Clock {}\n';

  it('is found where it is declared, also when the import follows the export, under another name, or as the default', () => {
    const dir = tempDir('marmeon-declarations-');
    writeFileSync(join(dir, 'mailer.d.ts'), mailer);
    writeFileSync(join(dir, 'a.d.ts'), "import { Mailer } from './mailer.js';\nexport { Mailer };\n");
    writeFileSync(join(dir, 'b.d.ts'), "export { Mailer as Sender };\nimport { Mailer } from './mailer.js';\n");
    writeFileSync(join(dir, 'c.d.ts'), "import Mailer from './mailer.js';\nexport default Mailer;\n");
    writeFileSync(join(dir, 'mailer-default.d.ts'), 'export default class Mailer {\n    constructor(x: number);\n}\n');
    writeFileSync(join(dir, 'd.d.ts'), "import Mailer from './mailer-default.js';\nexport default Mailer;\nexport { Mailer };\n");
    const reader = new DeclarationReader();
    const at = (file: string, name: string) => reader.read(join(dir, file), owner(dir)).exports.get(name);
    expect(at('a.d.ts', 'Mailer')).toEqual({ file: join(dir, 'mailer.d.ts'), name: 'Mailer' });
    expect(at('b.d.ts', 'Sender')).toEqual({ file: join(dir, 'mailer.d.ts'), name: 'Mailer' });
    expect(at('d.d.ts', 'default')).toEqual({ file: join(dir, 'mailer-default.d.ts'), name: 'Mailer' });
    // mailer.d.ts has no default export: nothing is exported, and nothing points at a class of the entry.
    expect(at('c.d.ts', 'default')).toBeUndefined();
    expect(reader.read(join(dir, 'c.d.ts'), owner(dir)).names.has('default')).toBe(false);
  });

  it('locates a local declaration, and an import from another package is a name without a location', () => {
    const dir = tempDir('marmeon-declarations-');
    writeFileSync(join(dir, 'e.d.ts'), "import { Other } from 'other';\ndeclare class Local {}\nexport { Local, Other };\n");
    const file = new DeclarationReader().read(join(dir, 'e.d.ts'), owner(dir));
    expect(file.exports.get('Local')).toEqual({ file: join(dir, 'e.d.ts'), name: 'Local' });
    expect(file.exports.has('Other')).toBe(false);
    expect([...file.names].sort()).toEqual(['Local', 'Other']);
  });

  it('is no export when the import is type-only — there is nothing to import at runtime', () => {
    const dir = tempDir('marmeon-declarations-');
    writeFileSync(join(dir, 'mailer.d.ts'), mailer);
    writeFileSync(join(dir, 'f.d.ts'), "import type { Mailer } from './mailer.js';\nexport { Mailer };\n");
    writeFileSync(join(dir, 'g.d.ts'), "import { type Mailer } from './mailer.js';\nexport { Mailer };\nexport default Mailer;\n");
    const reader = new DeclarationReader();
    for (const file of ['f.d.ts', 'g.d.ts']) expect([...reader.read(join(dir, file), owner(dir)).exports.keys()], file).toEqual([]);
  });

  it('is not followed out of the package: the file outside is never read', () => {
    const dir = tempDir('marmeon-declarations-');
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'outside.d.ts'), 'export declare class Outside {}\n');
    writeFileSync(join(dir, 'pkg/index.d.ts'), "import { Outside } from '../outside.js';\nexport { Outside };\n");
    writeFileSync(join(dir, 'pkg/default.d.ts'), "import Outside from '../outside.js';\nexport default Outside;\n");
    reads.clear();
    for (const file of ['index.d.ts', 'default.d.ts']) {
      expect(() => new DeclarationReader().read(join(dir, 'pkg', file), owner(join(dir, 'pkg'))), file).toThrow(
        /^\[marmeon:K7\] p imports "\.\.\/outside\.js" in its types, which lies outside the package\.$/,
      );
    }
    expect([...reads.keys()].filter((file) => file.endsWith('/outside.d.ts'))).toEqual([]);
  });

  it('is a name without a location when the file it leads to re-exports it from another package', () => {
    const dir = tempDir('marmeon-declarations-');
    writeFileSync(join(dir, 'named.d.ts'), "export { Prov } from 'other';\n");
    writeFileSync(join(dir, 'star.d.ts'), "export * from 'other';\n");
    writeFileSync(join(dir, 'anonymous.d.ts'), 'export default class {\n    register(): void;\n}\n');
    for (const shim of ['named', 'star']) {
      writeFileSync(join(dir, `${shim}-entry.d.ts`), `import { Prov } from './${shim}.js';\nexport { Prov };\n`);
    }
    writeFileSync(join(dir, 'anonymous-entry.d.ts'), "import Prov from './anonymous.js';\nexport { Prov };\n");
    writeFileSync(join(dir, 'source-entry.d.ts'), "export { default as Prov } from './anonymous.js';\nexport { Gone } from './star.js';\n");
    const reader = new DeclarationReader();
    for (const file of ['named-entry.d.ts', 'star-entry.d.ts', 'anonymous-entry.d.ts', 'source-entry.d.ts']) {
      const entry = reader.read(join(dir, file), owner(dir));
      expect(entry.names.has('Prov'), file).toBe(true);
      expect(entry.exports.has('Prov'), file).toBe(false);
    }
    expect(reader.read(join(dir, 'source-entry.d.ts'), owner(dir)).names.has('Gone')).toBe(true);
    expect(reader.read(join(dir, 'star.d.ts'), owner(dir)).opaque).toBe(true);
    expect(reader.read(join(dir, 'named.d.ts'), owner(dir)).opaque).toBe(false);
  });

  it('is a name without a location for a namespace, not followed into the file it names', () => {
    const dir = tempDir('marmeon-declarations-');
    writeFileSync(join(dir, 'mailer.d.ts'), mailer);
    writeFileSync(join(dir, 'ns.d.ts'), "import * as ns from './mailer.js';\nexport { ns };\n");
    const ns = new DeclarationReader().read(join(dir, 'ns.d.ts'), owner(dir));
    expect([ns.names.has('ns'), ns.exports.has('ns')]).toEqual([true, false]);
    // A namespace is no class to follow: its path is not read either, so one leading out of the package refuses nothing.
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'pkg/index.d.ts'), "import * as ns from '../mailer.js';\nexport { ns };\n");
    expect(new DeclarationReader().read(join(dir, 'pkg/index.d.ts'), owner(join(dir, 'pkg'))).names.has('ns')).toBe(true);
  });

  it('follows the name a string-literal import names, not the default', () => {
    const dir = tempDir('marmeon-declarations-');
    writeFileSync(join(dir, 'm.d.ts'), 'export declare class Real {\n    constructor(x: number);\n}\nexport default class Other {}\n');
    writeFileSync(join(dir, 'e.d.ts'), "import { \"Real\" as Mailer } from './m.js';\nexport { Mailer };\n");
    expect(new DeclarationReader().read(join(dir, 'e.d.ts'), owner(dir)).imports.get('Mailer')?.imported).toBe('Real');
    expect(new DeclarationReader().read(join(dir, 'e.d.ts'), owner(dir)).exports.get('Mailer')).toEqual({ file: join(dir, 'm.d.ts'), name: 'Real' });
  });

  it('terminates when two files import and export one class of each other', () => {
    const dir = tempDir('marmeon-declarations-');
    writeFileSync(join(dir, 'a.d.ts'), "import { B } from './b.js';\nexport { B };\nexport declare class A {}\n");
    writeFileSync(join(dir, 'b.d.ts'), "import { A } from './a.js';\nexport { A };\nexport declare class B {}\n");
    const exports = new DeclarationReader().read(join(dir, 'a.d.ts'), owner(dir)).exports;
    expect(exports.get('A')).toEqual({ file: join(dir, 'a.d.ts'), name: 'A' });
    expect(exports.get('B')).toEqual({ file: join(dir, 'b.d.ts'), name: 'B' });
  });

  it('is shadowed by nothing but its own file: a local class stays when "export *" brings the same name, in either order', () => {
    const dir = tempDir('marmeon-declarations-');
    writeFileSync(join(dir, 'other.d.ts'), 'export declare class Mailer {}\nexport declare class Rest {}\n');
    writeFileSync(join(dir, 'before.d.ts'), "export declare class Mailer {\n    constructor(x: number);\n}\nexport * from './other.js';\n");
    writeFileSync(join(dir, 'after.d.ts'), "export * from './other.js';\nexport declare class Mailer {\n    constructor(x: number);\n}\n");
    for (const file of ['before.d.ts', 'after.d.ts']) {
      const reader = new DeclarationReader();
      const exports = reader.read(join(dir, file), owner(dir)).exports;
      expect(exports.get('Mailer'), file).toEqual({ file: join(dir, file), name: 'Mailer' });
      expect(exports.get('Rest'), file).toEqual({ file: join(dir, 'other.d.ts'), name: 'Rest' });
      expect(reader.read(join(dir, file), owner(dir)).classes.get('Mailer')?.length, file).toBe(1);
    }
  });

  it('keeps no stale location when a name that "export *" located is exported again without one, in either order', () => {
    const dir = tempDir('marmeon-declarations-');
    writeFileSync(join(dir, 'a.d.ts'), 'export declare class X {}\n');
    writeFileSync(join(dir, 'b.d.ts'), "export { X } from 'other';\n");
    writeFileSync(join(dir, 'before.d.ts'), "export * from './a.js';\nexport { X } from 'other';\n");
    writeFileSync(join(dir, 'after.d.ts'), "export { X } from 'other';\nexport * from './a.js';\n");
    writeFileSync(join(dir, 'two.d.ts'), "export * from './a.js';\nexport * from './b.js';\n");
    const reader = new DeclarationReader();
    for (const file of ['before.d.ts', 'after.d.ts', 'two.d.ts']) {
      const entry = reader.read(join(dir, file), owner(dir));
      expect(entry.exports.get('X'), file).toBeUndefined();
      expect(entry.names.has('X'), file).toBe(true);
    }
  });

  it('exports "export * as ns" as a name without a location, relative or from another package, and not the default of a file', () => {
    const dir = tempDir('marmeon-declarations-');
    writeFileSync(join(dir, 'x.d.ts'), 'export default class {}\nexport declare class Real {}\n');
    writeFileSync(join(dir, 'e.d.ts'), "export * as rel from './x.js';\nexport * as foreign from 'other';\nexport * from './x.js';\n");
    const entry = new DeclarationReader().read(join(dir, 'e.d.ts'), owner(dir));
    for (const name of ['rel', 'foreign']) expect([entry.names.has(name), entry.exports.has(name)], name).toEqual([true, false]);
    expect(entry.names.has('default')).toBe(false);
    expect(entry.exports.has('Real')).toBe(true);
    expect(entry.opaque).toBe(false);
  });

  it('is a name without a location when the file is not found, and "export *" of it may export any name', () => {
    const dir = tempDir('marmeon-declarations-');
    writeFileSync(join(dir, 'e.d.ts'), "import { P } from './p.js';\nexport { P };\nexport { Q } from './q.js';\nexport * from './r.js';\n");
    const entry = new DeclarationReader().read(join(dir, 'e.d.ts'), owner(dir));
    expect([...entry.names].sort()).toEqual(['P', 'Q']);
    expect(entry.exports.size).toBe(0);
    expect(entry.opaque).toBe(true);
  });
});
