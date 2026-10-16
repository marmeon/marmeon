import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FOREIGN_TYPES, foreignPackage, runApi, snapshotPackage } from './api.ts';
import { compareSnapshots, parseSnapshot, type ApiItem } from './api-snapshot.ts';
import { INTERNAL } from './check-source.ts';
import { frameworkPackages } from './packages.ts';
import { tempDir } from './test/temp-dir.js';

const repository = fileURLToPath(new URL('..', import.meta.url));

/** Writes `dist/<name>` files into a fresh package; `exports` maps subpaths to their `.d.ts` under `dist/`. */
function demo(files: Record<string, string>, exports: Record<string, string> = { '.': 'index.d.ts' }) {
  const root = tempDir('marmeon-api-');
  const dir = join(root, 'packages/demo');
  const manifest = {
    name: '@marmeon/demo',
    version: '0.0.0',
    exports: Object.fromEntries(Object.entries(exports).map(([subpath, file]) => [subpath, { types: `./dist/${file}`, default: `./dist/${file.replace(/\.d\.ts$/, '.js')}` }])),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, 'dist', name)), { recursive: true });
    writeFileSync(join(dir, 'dist', name), text);
  }
  return { root, dir, manifest };
}

function snapshot(files: Record<string, string>, exports?: Record<string, string>, allowed: readonly string[] = []) {
  const { dir, manifest } = demo(files, exports);
  const result = snapshotPackage({ name: '@marmeon/demo', dir, manifest }, allowed);
  return { ...result, items: result.markdown ? parseSnapshot(result.markdown) : [] };
}
const find = (items: readonly ApiItem[], section: ApiItem['section'], name: string) => items.find((entry) => entry.section === section && entry.name === name);
const diff = (before: string, after: string) => {
  const was = snapshot({ 'index.d.ts': before });
  const is = snapshot({ 'index.d.ts': after });
  return compareSnapshots(was.items, is.items);
};

describe('the exports of an entry point', () => {
  it('follows a chain of `export *` and reads each declaration once', () => {
    const { items, problems } = snapshot({
      'index.d.ts': "export * from './a.ts';\nexport declare const own: 1;\n",
      'a.d.ts': "export * from './b.ts';\nexport declare function fromA(): void;\n",
      'b.d.ts': 'export declare const fromB: 1;\nexport interface Shape {\n    x: string;\n}\n',
    });
    expect(problems).toEqual([]);
    expect(items.filter((entry) => entry.section === 'stable').map((entry) => entry.name)).toEqual(['fromA', 'fromB', 'own', 'Shape'].sort());
    expect(find(items, 'stable', 'Shape')?.text).toBe('export interface Shape {\n    x: string;\n}');
  });

  it('lists a renamed export under its new name', () => {
    const { items } = snapshot({ 'index.d.ts': 'declare function a(): void;\nexport { a as b };\n' });
    expect(find(items, 'stable', 'b')?.text).toBe('declare function a(): void;');
    expect(find(items, 'stable', 'a')).toBeUndefined();
  });

  it('follows a named re-export and an import that is exported again', () => {
    const { items } = snapshot({
      'index.d.ts': "export { thing as other } from './a.ts';\nimport { type Shape } from './a.ts';\nexport type { Shape };\n",
      'a.d.ts': 'export declare const thing: 1;\nexport interface Shape {}\n',
    });
    expect(find(items, 'stable', 'other')?.text).toBe('export declare const thing: 1;');
    expect(find(items, 'stable', 'Shape')?.text).toBe('export interface Shape {}');
  });

  it('writes a re-export from another package as the export statement', () => {
    const { items } = snapshot({ 'index.d.ts': "export { x as y } from '@marmeon/router';\nexport type { Z } from '@marmeon/router';\nexport * from '@marmeon/core';\n" });
    expect(find(items, 'stable', 'y')?.text).toBe("export { x as y } from '@marmeon/router';");
    expect(find(items, 'stable', 'Z')?.text).toBe("export type { Z } from '@marmeon/router';");
    expect(find(items, 'stable', '* from @marmeon/core')?.text).toBe("export * from '@marmeon/core';");
  });

  it('keeps the overloads of a function together', () => {
    const { items } = snapshot({ 'index.d.ts': 'export declare function f(a: string): string;\nexport declare function f(a: number): number;\n' });
    expect(find(items, 'stable', 'f')?.text).toBe('export declare function f(a: string): string;\nexport declare function f(a: number): number;');
  });

  it('drops comments and blank lines but nothing else', () => {
    const { items } = snapshot({
      'index.d.ts': '/** Docs. */\nexport interface A {\n    /** The id. */\n    id: string;\n\n    // a note\n    name: string; /* inline */\n}\n',
    });
    expect(find(items, 'stable', 'A')?.text).toBe('export interface A {\n    id: string;\n    name: string;\n}');
  });

  it('writes one section per subpath and never reads `./internal`', () => {
    const { items, markdown } = snapshot(
      {
        'index.d.ts': 'export declare const main: 1;\n',
        'page.d.ts': 'export declare const page: 1;\n',
        'internal.d.ts': "export declare const secret: 1;\nimport 'does-not-exist';\n",
      },
      { '.': 'index.d.ts', './page': 'page.d.ts', './internal': 'internal.d.ts' },
    );
    expect(items.map((entry) => `${entry.entry}:${entry.name}`).sort()).toEqual(['@marmeon/demo/page:page', '@marmeon/demo:main']);
    expect(markdown).not.toContain('secret');
  });

  it('skips an entry without types', () => {
    const { dir, manifest } = demo({ 'index.d.ts': 'export declare const a: 1;\n' });
    const result = snapshotPackage({ name: '@marmeon/demo', dir, manifest: { exports: { ...manifest.exports, './styles.css': './dist/styles.css' } } }, []);
    expect(result.problems).toEqual([]);
    expect(result.markdown).not.toContain('styles');
  });
});

describe('what a change shows', () => {
  it('shows a changed parameter', () => {
    const changes = diff('export declare function f(a: number): void;\n', 'export declare function f(a: string): void;\n');
    expect(changes.changed.map(({ after }) => after.name)).toEqual(['f']);
  });

  it('shows a changed helper type that a public function names, as referenced', () => {
    const was = 'interface Options {\n    a: number;\n}\nexport declare function f(options: Options): void;\n';
    const is = 'interface Options {\n    a: string;\n}\nexport declare function f(options: Options): void;\n';
    const changes = diff(was, is);
    expect(changes.changed.map(({ after }) => [after.section, after.name])).toEqual([['referenced', 'Options']]);
    expect(find(snapshot({ 'index.d.ts': was }).items, 'referenced', 'Options')).toBeDefined();
  });

  it('follows helper types through other helper types and other files', () => {
    const { items } = snapshot({
      'index.d.ts': "import type { Inner } from './inner.ts';\ninterface Outer {\n    inner: Inner;\n}\nexport declare function f(): Outer;\n",
      'inner.d.ts': 'export interface Inner {\n    deep: Deeper;\n}\ninterface Deeper {\n    x: 1;\n}\n',
    });
    expect(items.filter((entry) => entry.section === 'referenced').map((entry) => entry.name)).toEqual(['Deeper', 'Inner', 'Outer']);
  });

  it('does not list the type parameters of a declaration as referenced', () => {
    const { items } = snapshot({ 'index.d.ts': 'interface T {}\nexport declare function f<T>(a: T): { [K in keyof T]: T[K] };\n' });
    expect(items.filter((entry) => entry.section === 'referenced')).toEqual([]);
  });

  it('names a second declaration of the same name from another file with a suffix', () => {
    const { items } = snapshot({
      'index.d.ts': "import type { Same as First } from './a.ts';\nimport type { Same } from './b.ts';\nexport declare function f(a: First, b: Same): void;\n",
      'a.d.ts': 'export interface Same {\n    a: 1;\n}\n',
      'b.d.ts': 'export interface Same {\n    b: 1;\n}\n',
    });
    expect(items.filter((entry) => entry.section === 'referenced').map((entry) => entry.name)).toEqual(['Same', 'Same (2)']);
  });

  it('ignores a changed member that is marked @internal', () => {
    const member = (type: string) => `export declare class Box {\n    /** @internal */\n    probe: ${type};\n    value: string;\n}\n`;
    expect(diff(member('number'), member('string'))).toEqual({ removed: [], changed: [], added: [] });
    expect(find(snapshot({ 'index.d.ts': member('number') }).items, 'stable', 'Box')?.text).not.toContain('probe');
  });

  it('ignores what only an @internal member names', () => {
    const { items } = snapshot({
      'index.d.ts': 'interface Hidden {}\nexport interface A {\n    /** @internal */\n    h: Hidden;\n}\n',
    });
    expect(items.filter((entry) => entry.section === 'referenced')).toEqual([]);
  });

  it('leaves an @internal export out, unless a public declaration names it', () => {
    const { items } = snapshot({
      'index.d.ts':
        '/** @internal */\nexport interface Secret {\n    a: 1;\n}\n/** @internal */\nexport declare const hidden: 1;\nexport declare function f(a: Secret): void;\n',
    });
    expect(find(items, 'stable', 'Secret')).toBeUndefined();
    expect(find(items, 'stable', 'hidden')).toBeUndefined();
    expect(find(items, 'referenced', 'Secret')?.text).toContain('interface Secret');
    expect(find(items, 'referenced', 'hidden')).toBeUndefined();
  });

  it('lists @experimental apart and marks @deprecated in the text', () => {
    const { items } = snapshot({
      'index.d.ts': '/** @experimental */\nexport declare class Probe {}\n/** @deprecated Use g. */\nexport declare function f(): void;\n',
    });
    expect(find(items, 'experimental', 'Probe')).toBeDefined();
    expect(find(items, 'stable', 'Probe')).toBeUndefined();
    expect(find(items, 'stable', 'f')?.text).toBe('// @deprecated\nexport declare function f(): void;');
    const changes = diff('export declare function f(): void;\n', '/** @deprecated Use g. */\nexport declare function f(): void;\n');
    expect(changes.changed).toHaveLength(1);
  });

  it('lists module augmentations, named after the module and the interface', () => {
    const { items } = snapshot({
      'index.d.ts': "import './augment.ts';\nexport declare const a: 1;\n",
      'augment.d.ts':
        "import type { Middleware } from '@marmeon/router';\ndeclare module '@marmeon/core' {\n    interface ApplicationOptions {\n        middleware?: readonly Middleware[];\n    }\n}\nexport {};\n",
    });
    expect(find(items, 'augments', '@marmeon/core.ApplicationOptions')?.text).toBe('interface ApplicationOptions {\n    middleware?: readonly Middleware[];\n}');
  });

  it('lists an augmentation under the first entry that reaches its file', () => {
    const { items } = snapshot(
      {
        'index.d.ts': "import './augment.ts';\nexport declare const a: 1;\n",
        'page.d.ts': "import './augment.ts';\nexport declare const b: 1;\n",
        'augment.d.ts': "declare module '@marmeon/core' {\n    interface X {\n        a: 1;\n    }\n}\n",
      },
      { '.': 'index.d.ts', './page': 'page.d.ts' },
    );
    expect(items.filter((entry) => entry.section === 'augments').map((entry) => entry.entry)).toEqual(['@marmeon/demo']);
  });
});

describe('exports that are only types', () => {
  const files = (statement: string) => ({ 'index.d.ts': `${statement}\n`, 'foo.d.ts': 'export declare class Foo {}\nexport interface Shape {}\n' });

  it('marks a class that is exported only as a type, so the switch shows', () => {
    const value = snapshot(files("export { Foo } from './foo.ts';"));
    const typeOnly = snapshot(files("export type { Foo } from './foo.ts';"));
    expect(find(value.items, 'stable', 'Foo')?.text).toBe('export declare class Foo {}');
    expect(find(typeOnly.items, 'stable', 'Foo')?.text).toBe('// type-only\nexport declare class Foo {}');
    expect(compareSnapshots(value.items, typeOnly.items).changed.map(({ after }) => after.name)).toEqual(['Foo']);
  });

  it('marks it through a local `export type`, a type-only import and `export type *`', () => {
    expect(find(snapshot({ 'index.d.ts': 'declare class Foo {}\nexport type { Foo };\n' }).items, 'stable', 'Foo')?.text).toBe('// type-only\ndeclare class Foo {}');
    expect(find(snapshot(files("import { type Foo } from './foo.ts';\nexport { Foo };")).items, 'stable', 'Foo')?.text).toContain('// type-only');
    expect(find(snapshot(files("export type * from './foo.ts';")).items, 'stable', 'Foo')?.text).toContain('// type-only');
  });

  it('does not mark an interface or an alias, which are types anyway', () => {
    const { items } = snapshot(files("export type { Shape } from './foo.ts';"));
    expect(find(items, 'stable', 'Shape')?.text).toBe('export interface Shape {}');
  });

  it('reads the marker line back as part of the text', () => {
    const { markdown } = snapshot(files("export type { Foo } from './foo.ts';"));
    expect(parseSnapshot(markdown!).map((entry) => entry.name)).toEqual(['Foo']);
  });
});

describe('names through a module namespace', () => {
  it('follows `ns.T` of a namespace import of a module of the package', () => {
    const { items, problems } = snapshot({
      'index.d.ts': "import * as engine from './engine.ts';\nexport declare function f(gate: engine.SizeGate): void;\n",
      'engine.d.ts': 'export interface SizeGate {\n    max: number;\n}\n',
    });
    expect(problems).toEqual([]);
    expect(find(items, 'referenced', 'SizeGate')?.text).toBe('export interface SizeGate {\n    max: number;\n}');
  });

  it('follows `import("./x").A.B` and `typeof ns.value`', () => {
    const { items } = snapshot({
      'index.d.ts': "import * as engine from './engine.ts';\nexport declare function f(a: import('./engine.ts').Gate, b: typeof engine.limit): void;\n",
      'engine.d.ts': 'export interface Gate {}\nexport declare const limit: number;\n',
    });
    expect(items.filter((entry) => entry.section === 'referenced').map((entry) => entry.name)).toEqual(['Gate', 'limit']);
  });

  it('follows a nested `export * as` namespace to the name inside it', () => {
    const { items } = snapshot({
      'index.d.ts': "import * as outer from './outer.ts';\nexport declare function f(a: outer.inner.Deep): void;\n",
      'outer.d.ts': "export * as inner from './inner.ts';\n",
      'inner.d.ts': 'export interface Deep {\n    d: 1;\n}\n',
    });
    expect(find(items, 'referenced', 'Deep')?.text).toBe('export interface Deep {\n    d: 1;\n}');
  });

  it('reports a type that means a whole module: `typeof ns` and `typeof import()`', () => {
    const engine = 'export declare const limit: number;\n';
    const viaImport = snapshot({ 'index.d.ts': "import * as engine from './engine.ts';\nexport declare const e: typeof engine;\n", 'engine.d.ts': engine });
    expect(viaImport.problems).toEqual([expect.stringContaining('@marmeon/demo names a whole module of the package (./engine.ts)')]);
    const viaType = snapshot({ 'index.d.ts': "export declare const e: typeof import('./engine.ts');\n", 'engine.d.ts': engine });
    expect(viaType.problems).toEqual([expect.stringContaining('names a whole module of the package (./engine.ts)')]);
  });

  it('does not report a whole module that only an @internal member names', () => {
    const { problems } = snapshot({
      'index.d.ts': "export declare function f(): void;\nexport declare class A {\n    /** @internal */\n    m: typeof import('./engine.ts');\n}\n",
      'engine.d.ts': 'export declare const limit: number;\n',
    });
    expect(problems).toEqual([]);
  });

  it('reports a module of the package that an entry exports as a namespace', () => {
    const { problems } = snapshot({ 'index.d.ts': "export * as engine from './engine.ts';\n", 'engine.d.ts': 'export interface Gate {}\n' });
    expect(problems).toEqual([expect.stringContaining('@marmeon/demo exports engine, a module of the package')]);
  });
});

describe('names from an internal subpath', () => {
  const core = `@marmeon/core${INTERNAL}`;
  it('reports a type a public declaration names from another package\'s ./internal', () => {
    const { problems } = snapshot({ 'index.d.ts': `import type { Hidden } from '${core}';\nexport declare function f(a: Hidden): void;\n` });
    expect(problems).toEqual([`@marmeon/demo names Hidden from ${core}, whose shape no snapshot holds: keep Hidden public, or stop naming it`]);
  });

  it('reports it through a namespace import and a re-export too', () => {
    const named = snapshot({ 'index.d.ts': `import * as core from '${core}';\nexport declare function f(a: core.Hidden): void;\n` });
    expect(named.problems).toHaveLength(1);
    const reexport = snapshot({ 'index.d.ts': `export type { Hidden } from '@marmeon/http${INTERNAL}';\n` });
    expect(reexport.problems).toEqual([expect.stringContaining('names Hidden from @marmeon/http' + INTERNAL)]);
  });

  it('lets an unused import and the public entry of another package pass', () => {
    const { problems } = snapshot({
      'index.d.ts': `import type { Hidden } from '${core}';\nimport type { Result } from '@marmeon/core';\nexport declare function f(): Result<1, 2>;\n`,
    });
    expect(problems).toEqual([]);
  });
});

describe('same names from different files', () => {
  it('numbers them by path, whatever order the references come in', () => {
    const shared = { 'a.d.ts': 'export interface Same {\n    a: 1;\n}\n', 'b.d.ts': 'export interface Same {\n    b: 1;\n}\n' };
    const first = snapshot({
      ...shared,
      'index.d.ts': "import type { Same as A } from './a.ts';\nimport type { Same as B } from './b.ts';\nexport declare function f(a: A, b: B): void;\n",
    });
    const second = snapshot({
      ...shared,
      'index.d.ts': "import type { Same as A } from './a.ts';\nimport type { Same as B } from './b.ts';\nexport declare function f(b: B): void;\nexport declare function g(a: A): void;\n",
    });
    for (const { items } of [first, second]) {
      expect(find(items, 'referenced', 'Same')?.text).toContain('a: 1');
      expect(find(items, 'referenced', 'Same (2)')?.text).toContain('b: 1');
    }
  });
});

describe('types of other packages', () => {
  it('refuses an allowlist entry that no entry point uses any more', () => {
    const { problems } = snapshot({ 'index.d.ts': 'export declare const a: 1;\n' }, undefined, ['hono']);
    expect(problems).toEqual(['FOREIGN_TYPES lists hono for @marmeon/demo, but no entry point names its types any more: delete the entry']);
  });

  it('refuses a package outside the allowlist, naming the entry and the package', () => {
    const { problems } = snapshot({ 'index.d.ts': "export declare function f(app: import('hono').Hono): void;\n" });
    expect(problems).toEqual(['@marmeon/demo exposes types of hono: add own types, or list it with a reason in FOREIGN_TYPES']);
  });

  it('refuses an imported type that a public declaration names', () => {
    const { problems } = snapshot({ 'index.d.ts': "import type { Logger } from 'pino';\nexport declare function f(logger: Logger): void;\n" });
    expect(problems).toEqual([expect.stringContaining('exposes types of pino')]);
  });

  it('refuses a namespace import and a re-export, scoped packages by their name', () => {
    const { problems } = snapshot({
      'index.d.ts': "import * as z from 'zod';\nexport declare const schema: z.ZodObject<any>;\nexport type { X } from '@scope/lib/deep';\n",
    });
    expect(problems.sort()).toEqual([
      '@marmeon/demo exposes types of @scope/lib: add own types, or list it with a reason in FOREIGN_TYPES',
      '@marmeon/demo exposes types of zod: add own types, or list it with a reason in FOREIGN_TYPES',
    ]);
  });

  it('accepts an allowed package and lists it under "Types from other packages"', () => {
    const { problems, markdown } = snapshot({ 'index.d.ts': "export declare function f(app: import('hono').Hono): void;\n" }, undefined, ['hono']);
    expect(problems).toEqual([]);
    expect(markdown).toContain('Types from other packages: `hono`');
  });

  it('lets Node, Marmeon and an unused import pass', () => {
    const { problems } = snapshot({
      'index.d.ts': "import type { Readable } from 'node:stream';\nimport type { Result } from '@marmeon/core';\nimport type { Unused } from 'hono';\nexport declare function f(a: Readable): Result<1, 2>;\n",
    });
    expect(problems).toEqual([]);
  });

  it('reads the package a specifier names', () => {
    expect(foreignPackage('hono/utils/x')).toBe('hono');
    expect(foreignPackage('@aws-sdk/client-s3/commands')).toBe('@aws-sdk/client-s3');
    expect(foreignPackage('node:fs')).toBeUndefined();
    expect(foreignPackage('@marmeon/core/testing')).toBeUndefined();
    expect(foreignPackage('marmeon')).toBeUndefined();
    expect(foreignPackage('./x.ts')).toBeUndefined();
  });

  it('allows foreign types only for packages that exist', () => {
    const live = new Set(frameworkPackages(repository).map((pkg) => pkg.short));
    expect(Object.keys(FOREIGN_TYPES).filter((name) => !live.has(name))).toEqual([]);
  });
});

describe('pnpm api:check', () => {
  const run = (files: Record<string, string>, options: Parameters<typeof runApi>[1] = {}) => {
    const { root } = demo(files);
    return { root, run: (more = options) => runApi(root, more) };
  };

  it('writes api.md with --write and then finds nothing to say', () => {
    const { root, run: runIn } = run({ 'index.d.ts': 'export declare const a: 1;\n' });
    expect(runIn({ write: true })).toEqual({ code: 0, lines: ['wrote packages/demo/api.md'] });
    expect(readFileSync(join(root, 'packages/demo/api.md'), 'utf8')).toContain('// a');
    expect(runIn({}).code).toBe(0);
  });

  it('fails on an api.md that is missing, and says how to make it', () => {
    const result = run({ 'index.d.ts': 'export declare const a: 1;\n' }).run();
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('packages/demo/api.md is missing');
    expect(result.lines.join('\n')).toContain('run pnpm api:update and commit packages/demo/api.md');
  });

  it('fails on a stale api.md, naming what was removed, changed and added', () => {
    const { root, run: runIn } = run({ 'index.d.ts': 'export declare const a: 1;\nexport declare const b: 1;\nexport declare function f(x: number): void;\n' });
    runIn({ write: true });
    const file = join(root, 'packages/demo/dist/index.d.ts');
    writeFileSync(file, 'export declare const a: 1;\nexport declare const c: 1;\nexport declare function f(x: string): void;\n');
    const result = runIn({});
    expect(result.code).toBe(1);
    const text = result.lines.join('\n');
    expect(text).toContain('removed: b');
    expect(text).toContain('changed: f');
    expect(text).toContain('added: c');
    expect(text).toContain('run pnpm api:update and commit packages/demo/api.md');
  });

  it('names at most ten names per kind', () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => `export declare const n${String(index).padStart(2, '0')}: 1;`).join('\n');
    const { root, run: runIn } = run({ 'index.d.ts': 'export declare const keep: 1;\n' });
    runIn({ write: true });
    writeFileSync(join(root, 'packages/demo/dist/index.d.ts'), `export declare const keep: 1;\n${many(13)}\n`);
    const text = runIn({}).lines.join('\n');
    expect(text).toContain('n09');
    expect(text).not.toContain('n10');
    expect(text).toContain('3 more');
  });

  it('fails on the api.md of a package that has no entry point with types any more, and --write removes it', () => {
    const { root, run: runIn } = run({ 'index.d.ts': 'export declare const a: 1;\n' });
    runIn({ write: true });
    writeFileSync(join(root, 'packages/demo/package.json'), JSON.stringify({ name: '@marmeon/demo', version: '0.0.0', exports: {} }));
    const stale = runIn({});
    expect(stale.code).toBe(1);
    expect(stale.lines.join('\n')).toContain('packages/demo/api.md is out of date — the package has no entry point with types any more');
    expect(runIn({ write: true })).toEqual({ code: 0, lines: ['removed packages/demo/api.md'] });
    expect(existsSync(join(root, 'packages/demo/api.md'))).toBe(false);
    expect(runIn({}).code).toBe(0);
  });

  it('builds clean before api:update rewrites the files', () => {
    const scripts = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts['api:update']).toContain('package:build packages/* --clean');
    expect(scripts['api:update']).toContain('scripts/api.ts --write');
  });

  it('fails with "run pnpm build first" when there is no dist/', () => {
    const { root } = demo({});
    const result = runApi(root);
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('run pnpm build first');
  });

  it('fails on a package outside the allowlist, and passes once it is listed', () => {
    const { root } = demo({ 'index.d.ts': "export declare function f(app: import('hono').Hono): void;\n" });
    expect(runApi(root).code).toBe(1);
    expect(runApi(root, { write: true, allowed: { demo: ['hono'] } }).code).toBe(0);
    expect(runApi(root, { allowed: { demo: ['hono'] } }).code).toBe(0);
  });
});

describe('the repository', () => {
  const built = frameworkPackages(repository).every((pkg) => {
    const exports = (pkg.manifest.exports ?? {}) as Record<string, { types?: string }>;
    return Object.values(exports).every((conditions) => conditions.types === undefined || existsSync(join(pkg.dir, conditions.types)));
  });

  it.skipIf(!built)('has an api.md for every package that matches the built declarations', () => {
    expect(runApi(repository).lines).toEqual(['api: every api.md matches the built declarations']);
  });
});
