import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FOREIGN_TYPES, foreignPackage, runApi, runtimeItems, snapshotPackage, stabilityProblems } from './api.ts';
import { compareSnapshots, parseSnapshot, type ApiItem } from './api-snapshot.ts';
import { INTERNAL } from './check-source.ts';
import { frameworkPackages } from './packages.ts';
import { tempDir } from './test/temp-dir.js';

const repository = fileURLToPath(new URL('..', import.meta.url));

/** Writes `dist/<name>` files into a fresh package; `exports` maps subpaths to their `.d.ts` under `dist/`. */
function demo(files: Record<string, string>, exports: Record<string, string> = { '.': 'index.d.ts' }, extra: Record<string, unknown> = {}) {
  const root = tempDir('marmeon-api-');
  const dir = join(root, 'packages/demo');
  const manifest = {
    name: '@marmeon/demo',
    version: '0.0.0',
    ...extra,
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
        "import type { Middleware } from '@marmeon/router';\ndeclare module '@marmeon/core' {\n    interface ApplicationDefinition {\n        middleware?: readonly Middleware[];\n    }\n}\nexport {};\n",
    });
    expect(find(items, 'augments', '@marmeon/core.ApplicationDefinition')?.text).toBe('interface ApplicationDefinition {\n    middleware?: readonly Middleware[];\n}');
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

  it('writes api.md with --write and then finds nothing to say', async () => {
    const { root, run: runIn } = run({ 'index.d.ts': 'export declare const a: 1;\n' });
    expect(await runIn({ write: true })).toEqual({ code: 0, lines: ['wrote packages/demo/api.md'] });
    expect(readFileSync(join(root, 'packages/demo/api.md'), 'utf8')).toContain('// a');
    expect((await runIn({})).code).toBe(0);
  });

  it('fails on an api.md that is missing, and says how to make it', async () => {
    const result = await run({ 'index.d.ts': 'export declare const a: 1;\n' }).run();
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('packages/demo/api.md is missing');
    expect(result.lines.join('\n')).toContain('run pnpm api:update and commit packages/demo/api.md');
  });

  it('fails on a stale api.md, naming what was removed, changed and added', async () => {
    const { root, run: runIn } = run({ 'index.d.ts': 'export declare const a: 1;\nexport declare const b: 1;\nexport declare function f(x: number): void;\n' });
    await runIn({ write: true });
    const file = join(root, 'packages/demo/dist/index.d.ts');
    writeFileSync(file, 'export declare const a: 1;\nexport declare const c: 1;\nexport declare function f(x: string): void;\n');
    const result = await runIn({});
    expect(result.code).toBe(1);
    const text = result.lines.join('\n');
    expect(text).toContain('removed: b');
    expect(text).toContain('changed: f');
    expect(text).toContain('added: c');
    expect(text).toContain('run pnpm api:update and commit packages/demo/api.md');
  });

  it('names at most ten names per kind', async () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => `export declare const n${String(index).padStart(2, '0')}: 1;`).join('\n');
    const { root, run: runIn } = run({ 'index.d.ts': 'export declare const keep: 1;\n' });
    await runIn({ write: true });
    writeFileSync(join(root, 'packages/demo/dist/index.d.ts'), `export declare const keep: 1;\n${many(13)}\n`);
    const text = (await runIn({})).lines.join('\n');
    expect(text).toContain('n09');
    expect(text).not.toContain('n10');
    expect(text).toContain('3 more');
  });

  it('fails on the api.md of a package that has no entry point with types any more, and --write removes it', async () => {
    const { root, run: runIn } = run({ 'index.d.ts': 'export declare const a: 1;\n' });
    await runIn({ write: true });
    writeFileSync(join(root, 'packages/demo/package.json'), JSON.stringify({ name: '@marmeon/demo', version: '0.0.0', exports: {} }));
    const stale = await runIn({});
    expect(stale.code).toBe(1);
    expect(stale.lines.join('\n')).toContain('packages/demo/api.md is out of date — the package has no entry point with types any more');
    expect(await runIn({ write: true })).toEqual({ code: 0, lines: ['removed packages/demo/api.md'] });
    expect(existsSync(join(root, 'packages/demo/api.md'))).toBe(false);
    expect((await runIn({})).code).toBe(0);
  });

  it('builds clean before api:update rewrites the files', async () => {
    const scripts = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).scripts as Record<string, string>;
    expect(scripts['api:update']).toContain('package:build packages/* --clean');
    expect(scripts['api:update']).toContain('scripts/api.ts --write');
  });

  it('fails with "run pnpm build first" when there is no dist/', async () => {
    const { root } = demo({});
    const result = await runApi(root);
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('run pnpm build first');
  });

  it('fails on a package outside the allowlist, and passes once it is listed', async () => {
    const { root } = demo({ 'index.d.ts': "export declare function f(app: import('hono').Hono): void;\n" });
    expect((await runApi(root)).code).toBe(1);
    expect((await runApi(root, { write: true, allowed: { demo: ['hono'] } })).code).toBe(0);
    expect((await runApi(root, { allowed: { demo: ['hono'] } })).code).toBe(0);
  });
});

describe('environment variables and commands', () => {
  /** A package with one provider: `config` lists its config definitions, `commands` its command classes (JavaScript source). */
  async function read(config: string, commands = '[]') {
    const { dir, manifest } = demo(
      {
        'index.d.ts': 'export declare const a: 1;\n',
        'index.js': `
          const fields = (variables) => ({ name: 'demo', env: { [Symbol.for('marmeon.env.fields')]: variables } });
          const required = { '~env': (_, name) => ({ problem: name + ' is required.' }) };
          const optional = { '~env': () => ({ value: undefined }) };
          const given = (value) => ({ '~env': () => ({ value }) });
          export class DemoServiceProvider {
            static config = [${config}];
            static commands = ${commands};
          }
        `,
      },
      { '.': 'index.d.ts' },
      { marmeon: { providers: ['DemoServiceProvider'] } },
    );
    return runtimeItems({ name: '@marmeon/demo', dir, manifest });
  }
  const pair = (before: string, after: string, commands: readonly [string, string] = ['[]', '[]']) => Promise.all([read(before, commands[0]), read(after, commands[1])]);

  it('lists a default as JSON, a required variable and an optional one', async () => {
    const { items, problems } = await read("fields({ PORT: given(3000), HOSTS: given(['a', 'b']), SECRET: required, MAYBE: optional })");
    expect(problems).toEqual([]);
    expect(items.map((item) => [item.section, item.name, item.text])).toEqual([
      ['environment', 'PORT', '`PORT` = `3000`'],
      ['environment', 'HOSTS', '`HOSTS` = `["a","b"]`'],
      ['environment', 'SECRET', '`SECRET` — required'],
      ['environment', 'MAYBE', '`MAYBE` — optional'],
    ]);
  });

  it('lists a retired name as a lock, once, and shows a removed lock as removed', async () => {
    const lock = "{ name: 'demo', env: { [Symbol.for('marmeon.env.fields')]: { NEW: optional }, [Symbol.for('marmeon.env.renamed')]: { OLD: 'NEW' } } }";
    const { items, problems } = await read(`${lock}, ${lock}`);
    expect(problems).toEqual([]);
    expect(items.map((item) => [item.section, item.name, item.text])).toEqual([
      ['environment', 'NEW', '`NEW` — optional'],
      ['environment', 'OLD', '`OLD` → `NEW` (renamed)'],
    ]);
    const [before, after] = await pair(lock, 'fields({ NEW: optional })');
    expect(compareSnapshots(before.items, after.items).removed.map((item) => item.name)).toEqual(['OLD']);
  });

  it('shows a changed default as changed and a removed variable as removed', async () => {
    const [before, after] = await pair('fields({ PORT: given(3000), GONE: given(1) })', 'fields({ PORT: given(3001) })');
    const changes = compareSnapshots(before.items, after.items);
    expect(changes.changed.map(({ after: item }) => item.name)).toEqual(['PORT']);
    expect(changes.removed.map((item) => item.name)).toEqual(['GONE']);
    expect(changes.added).toEqual([]);
  });

  it('keeps one item for a variable that a second definition reads the same way', async () => {
    const [one, two] = await pair('fields({ APP_URL: optional })', "fields({ APP_URL: optional }), { ...fields({ APP_URL: optional }), name: 'second' }");
    expect(two.items).toEqual(one.items);
    expect(compareSnapshots(one.items, two.items)).toEqual({ removed: [], changed: [], added: [] });
  });

  it('names the definitions when two read a variable differently', async () => {
    const { items } = await read("fields({ APP_URL: optional }), { ...fields({ APP_URL: given('x') }), name: 'second' }");
    expect(items.map((item) => item.text)).toEqual(['`APP_URL` — optional (demo); = `"x"` (second)']);
  });

  it('names the config or the provider when reading fails', async () => {
    const throwing = "{ name: 'bad', env: { [Symbol.for('marmeon.env.fields')]: { X: { '~env': () => { throw new Error('boom'); } } } } }";
    expect((await read(throwing)).problems.join('\n')).toContain('reading the variables of the config bad (provider DemoServiceProvider) failed: boom');
    expect((await read("{ name: 'odd', env: 5 }")).problems.join('\n')).toContain('the env of the config odd is not made by env({ … })');
  });

  it('reports a provider the manifest lists but the entry point does not export', async () => {
    const { dir, manifest } = demo({ 'index.d.ts': 'export declare const a: 1;\n', 'index.js': 'export class Other {}\n' }, { '.': 'index.d.ts' }, { marmeon: { providers: ['Missing'] } });
    const { problems } = await runtimeItems({ name: '@marmeon/demo', dir, manifest });
    expect(problems).toEqual(['@marmeon/demo lists the provider Missing, but its entry point does not export it']);
  });

  it('asks for a build only when the entry point cannot be imported', async () => {
    const { dir, manifest } = demo({ 'index.d.ts': 'export declare const a: 1;\n' }, { '.': 'index.d.ts' }, { marmeon: { providers: ['P'] } });
    expect((await runtimeItems({ name: '@marmeon/demo', dir, manifest })).problems.join('\n')).toContain('run pnpm build first');
  });

  it('reports a config whose env is not made by env({ … })', async () => {
    const { problems } = await read("{ name: 'plain', env: {} }");
    expect(problems.join('\n')).toContain('the env of the config plain is not made by env({ … })');
  });

  const command = (options: string, description = 'Does a thing.') =>
    `[class DemoCommand { static command = 'demo:run'; static description = '${description}'; static usage = '<Name>'; static options = ${options}; }]`;

  it('lists a command with its usage and its sorted options, without the description', async () => {
    const { items } = await read('', command("{ zeta: { type: 'string', short: 'z' }, alpha: { type: 'boolean' }, many: { type: 'string', multiple: true } }"));
    expect(items).toEqual([
      { entry: '', section: 'commands', name: 'demo:run', text: 'marmeon demo:run <Name>\n--alpha (boolean)\n--many (string, multiple)\n--zeta (string, short z)' },
    ]);
  });

  it('shows a removed option as changed, and a new description as no change', async () => {
    const [before, after] = await pair('', '', [command("{ a: { type: 'boolean' }, b: { type: 'boolean' } }"), command("{ a: { type: 'boolean' } }")]);
    expect(compareSnapshots(before.items, after.items).changed.map(({ after: item }) => item.name)).toEqual(['demo:run']);
    const [same, reworded] = await pair('', '', [command("{ a: { type: 'boolean' } }"), command("{ a: { type: 'boolean' } }", 'Now words differ.')]);
    expect(compareSnapshots(same.items, reworded.items)).toEqual({ removed: [], changed: [], added: [] });
  });

  it('writes both sections after the entry points, and reads them back', async () => {
    const { dir, manifest } = demo(
      {
        'index.d.ts': 'export declare const a: 1;\n',
        'index.js': `export class P { static config = [{ name: 'x', env: { [Symbol.for('marmeon.env.fields')]: { X: { '~env': () => ({ value: 1 }) } } } }]; static commands = [class C { static command = 'x:run'; static options = {}; }]; }`,
      },
      { '.': 'index.d.ts' },
      { marmeon: { providers: ['P'] } },
    );
    const { items } = await runtimeItems({ name: '@marmeon/demo', dir, manifest });
    const { markdown } = snapshotPackage({ name: '@marmeon/demo', dir, manifest }, [], items);
    expect(markdown).toMatch(/## Environment\n\n```ts\n\/\/ X\n`X` = `1`\n```\n\n## Commands\n\n```ts\n\/\/ x:run\nmarmeon x:run\n```\n$/);
    expect(parseSnapshot(markdown!).filter((item) => item.entry === '')).toEqual(items);
  });

  it('leaves a package without providers alone', async () => {
    const { dir, manifest } = demo({ 'index.d.ts': 'export declare const a: 1;\n' });
    expect(await runtimeItems({ name: '@marmeon/demo', dir, manifest })).toEqual({ items: [], problems: [] });
  });
});

describe('what is experimental', () => {
  const OPTIONS = 'export interface Options {\n    /** Where. */\n    path: string;\n    /** Wider pages.\n     * @experimental */\n    pages?: boolean;\n}\n';
  const two = {
    'index.d.ts':
      "interface Helper {\n    x: 1;\n}\nexport declare function a(h: Helper): void;\ndeclare module '@marmeon/core' {\n    interface ApplicationDefinition {\n        /** @experimental */\n        extra?: 1;\n    }\n}\n", 'b.d.ts': 'export declare const b: 1;\n', 'c.d.ts': 'export declare const c: 1;\n' };
  const entries = { '.': 'index.d.ts', './b': 'b.d.ts', './internal': 'c.d.ts' };
  const withManifest = (files: Record<string, string>, experimental: unknown, runtime: readonly ApiItem[] = []) => {
    const { dir, manifest } = demo(files, entries, { marmeon: { experimental } });
    const result = snapshotPackage({ name: '@marmeon/demo', dir, manifest }, [], runtime);
    return { ...result, items: result.markdown ? parseSnapshot(result.markdown) : [] };
  };

  it('marks every entry, variable and command of a package listed as `true`', () => {
    const env: ApiItem = { entry: '', section: 'environment', name: 'DEMO', text: '`DEMO` — optional' };
    const command: ApiItem = { entry: '', section: 'commands', name: 'demo:run', text: 'marmeon demo:run' };
    const { items, problems, experimental } = withManifest(two, true, [env, command]);
    expect(problems).toEqual([]);
    expect(items.map((item) => `${item.section}:${item.entry}:${item.name}`).sort()).toEqual([
      'augments:@marmeon/demo:@marmeon/core.ApplicationDefinition',
      'experimental::DEMO',
      'experimental::demo:run',
      'experimental:@marmeon/demo/b:b',
      'experimental:@marmeon/demo:a',
      'experimentalReferenced:@marmeon/demo:Helper',
    ]);
    expect(find(items, 'augments', '@marmeon/core.ApplicationDefinition')?.text).toContain('extra?: 1;');
    expect(experimental).toEqual(['@marmeon/demo']);
  });

  it('marks only the listed subpaths', () => {
    const { items, problems, experimental } = withManifest(two, ['./b']);
    expect(problems).toEqual([]);
    expect(items.filter((item) => ['stable', 'experimental'].includes(item.section)).map((item) => `${item.section}:${item.name}`).sort()).toEqual([
      'experimental:b',
      'stable:a',
    ]);
    expect(experimental).toEqual(['@marmeon/demo/b']);
  });

  it('lists the helper types an experimental entry names under a heading of their own', () => {
    const files = { ...two, 'b.d.ts': 'interface Shape {\n    x: 1;\n}\nexport declare const b: (s: Shape) => void;\n' };
    const { items } = withManifest(files, ['./b']);
    expect(items.filter((item) => item.entry === '@marmeon/demo/b').map((item) => `${item.section}:${item.name}`).sort()).toEqual(['experimental:b', 'experimentalReferenced:Shape']);
    expect(items.filter((item) => item.entry === '@marmeon/demo').map((item) => `${item.section}:${item.name}`)).toContain('referenced:Helper');
  });

  it('refuses a subpath that is no entry or is ./internal', () => {
    expect(withManifest(two, ['./internal']).problems).toEqual(['@marmeon/demo: marmeon.experimental lists ./internal, which no snapshot holds']);
    expect(withManifest(two, ['./nope']).problems).toEqual(['@marmeon/demo: marmeon.experimental lists ./nope, which is no subpath of exports']);
    expect(withManifest(two, 'yes').problems).toHaveLength(1);
  });

  it('moves an @experimental member out of its declaration into an item of its own', () => {
    const { items } = snapshot({ 'index.d.ts': OPTIONS });
    expect(find(items, 'stable', 'Options')?.text).toBe('export interface Options {\n    path: string;\n}');
    expect(find(items, 'experimental', 'Options.pages')?.text).toBe('pages?: boolean;');
  });

  it('names a member inside an object type by its path', () => {
    const { items } = snapshot({
      'index.d.ts': 'export interface Options {\n    server: {\n        port: number;\n        /** @experimental */\n        tls?: boolean;\n    };\n}\n',
    });
    expect(find(items, 'experimental', 'Options.server.tls')?.text).toBe('tls?: boolean;');
    expect(find(items, 'stable', 'Options')?.text).not.toContain('tls');
  });

  it('cuts a member whose own members carry comments without eating what follows', () => {
    const { items } = snapshot({
      'index.d.ts': 'export interface Options {\n    path: string;\n    /** @experimental */\n    server?: {\n        /** The port. */\n        port: number;\n    };\n    after: string;\n}\n',
    });
    expect(find(items, 'stable', 'Options')?.text).toBe('export interface Options {\n    path: string;\n    after: string;\n}');
    expect(find(items, 'experimental', 'Options.server')?.text).toBe('server?: {\n    port: number;\n};');
  });

  it('skips an @internal member and what is inside it', () => {
    const { items } = snapshot({
      'index.d.ts':
        'export interface Options {\n    path: string;\n    /** @internal */\n    hidden: {\n        /** @experimental */\n        secret: 1;\n    };\n    /** @internal @experimental */\n    both: 1;\n}\n',
    });
    expect(items.filter((item) => item.section === 'experimental')).toEqual([]);
    expect(find(items, 'stable', 'Options')?.text).toBe('export interface Options {\n    path: string;\n}');
  });

  it('names a symbol key by its source and numbers equal names', () => {
    const { items } = snapshot({
      'index.d.ts':
        'export interface Iter {\n    /** @experimental */\n    [Symbol.iterator](): void;\n    /** @experimental */\n    (a: string): void;\n    /** @experimental */\n    (a: number): void;\n}\n',
    });
    expect(items.filter((item) => item.section === 'experimental').map((item) => item.name).sort()).toEqual(['Iter.()', 'Iter.() (2)', 'Iter.[Symbol.iterator]']);
  });

  it('leaves the declaration unchanged when only the member changes', () => {
    const changes = diff(OPTIONS, OPTIONS.replace('pages?: boolean', 'pages?: number'));
    expect(changes.changed.map(({ after }) => after.name)).toEqual(['Options.pages']);
    expect(changes.changed[0]!.after.section).toBe('experimental');
  });

  it('keeps the member in a type that is only referenced', () => {
    const { items } = snapshot({ 'index.d.ts': `${OPTIONS.replace('export interface', 'interface')}export declare function f(options: Options): void;\n` });
    expect(find(items, 'referenced', 'Options')?.text).toContain('pages?: boolean;');
    expect(items.some((item) => item.name === 'Options.pages')).toBe(false);
  });

  describe('docs/releases.md', () => {
    const releases = (root: string, text: string) => {
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'docs/releases.md'), text);
    };
    const page = (list: string) => `# Releases\n\n## What is public API\n\n### Experimental\n\nCan break in any minor.\n\n${list}\n\n## Next\n\n\`@marmeon/other\`\n`;
    const setup = (files: Record<string, string>, experimental: unknown) => demo(files, entries, { marmeon: { experimental } }).root;

    it('passes when every experimental entry is named and nothing else', async () => {
      const root = setup(two, ['./b']);
      releases(root, page('- `@marmeon/demo/b`'));
      expect((await runApi(root, { write: true })).code).toBe(0);
      expect((await runApi(root)).code).toBe(0);
    });

    it('names an experimental entry that the page misses', async () => {
      const root = setup(two, ['./b']);
      releases(root, page('- nothing yet'));
      const run = await runApi(root, { write: true });
      expect(run.code).toBe(1);
      expect(run.lines.join('\n')).toContain('does not name @marmeon/demo/b under "### Experimental"');
    });

    it('names an entry of the page that nothing marks', async () => {
      const root = setup(two, undefined);
      releases(root, page('- `@marmeon/demo/b`'));
      const run = await runApi(root, { write: true });
      expect(run.code).toBe(1);
      expect(run.lines.join('\n')).toContain('names @marmeon/demo/b under "### Experimental", but nothing marks it experimental');
    });

    it('needs the page when something is experimental, and no page otherwise', async () => {
      expect((await runApi(setup(two, true), { write: true })).code).toBe(1);
      expect((await runApi(setup(two, undefined), { write: true })).code).toBe(0);
    });
  });

  it('lists an experimental command in the package-wide section, and reads it back', async () => {
    const { dir, manifest } = demo(
      {
        'index.d.ts': 'export declare const a: 1;\n',
        'index.js': `export class P { static commands = [class C { static command = 'x:run'; static experimental = true; static options = {}; }, class D { static command = 'x:stay'; static options = {}; }]; }`,
      },
      { '.': 'index.d.ts' },
      { marmeon: { providers: ['P'] } },
    );
    const { items } = await runtimeItems({ name: '@marmeon/demo', dir, manifest });
    const { markdown, experimental } = snapshotPackage({ name: '@marmeon/demo', dir, manifest }, [], items);
    expect(markdown).toMatch(/## Commands\n\n```ts\n\/\/ x:stay\nmarmeon x:stay\n```\n\n## Experimental\n\n```ts\n\/\/ x:run\nmarmeon x:run\n```\n$/);
    expect(experimental).toEqual(['marmeon x:run']);
    expect(parseSnapshot(markdown!).filter((item) => item.entry === '')).toHaveLength(2);
  });
});

describe('stable items that name experimental types', () => {
  interface Fixture {
    readonly exports: Record<string, string>;
    readonly experimental?: unknown;
    readonly files: Record<string, string>;
  }
  /** Packages side by side under one root, each `packages/<directory>` with its `dist/` files, named `@marmeon/<directory>`. */
  const monorepo = (packages: Record<string, Fixture>) => {
    const root = tempDir('marmeon-api-');
    for (const [directory, { exports, experimental, files }] of Object.entries(packages)) {
      const dir = join(root, 'packages', directory);
      const manifest = {
        name: `@marmeon/${directory}`,
        version: '0.0.0',
        ...(experimental === undefined ? {} : { marmeon: { experimental } }),
        exports: Object.fromEntries(Object.entries(exports).map(([subpath, file]) => [subpath, { types: `./dist/${file}` }])),
      };
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, 'dist', name)), { recursive: true });
        writeFileSync(join(dir, 'dist', name), text);
      }
    }
    return root;
  };
  const problemsOf = (packages: Record<string, Fixture>) => {
    const root = monorepo(packages);
    return Object.fromEntries(stabilityProblems(frameworkPackages(root), root));
  };
  /** `@marmeon/demo`: a stable entry `.` and an experimental `./adapter` that exports `Feature`. */
  const demoWith = (index: string, more: Partial<Fixture> = {}) =>
    problemsOf({
      demo: {
        exports: { '.': 'index.d.ts', './adapter': 'adapter.d.ts' },
        experimental: ['./adapter'],
        ...more,
        files: { 'adapter.d.ts': 'export interface Feature {\n    on(): void;\n}\n', ...more.files, 'index.d.ts': `import type { Feature } from './adapter.ts';\n${index}` },
      },
    });
  const advice = 'mark it @experimental, or name a stable type';
  const again = 're-export it from an experimental entry point, or stop re-exporting it';

  it('reports a stable declaration that names a type only an experimental entry exports', () => {
    expect(demoWith('export declare function use(feature: Feature): void;\n')).toEqual({
      '@marmeon/demo': [`@marmeon/demo › use names Feature, which is experimental (exported by @marmeon/demo/adapter; declared in packages/demo/dist/adapter.d.ts): ${advice}`],
    });
  });

  it('names the member, and the helper type the name stands in', () => {
    const problems = demoWith('interface Helper {\n    feature: Feature;\n}\nexport declare class App {\n    constructor(helper: Helper);\n}\n');
    expect(problems['@marmeon/demo']).toEqual([
      `@marmeon/demo › App.constructor names Feature (through Helper), which is experimental (exported by @marmeon/demo/adapter; declared in packages/demo/dist/adapter.d.ts): ${advice}`,
    ]);
  });

  it('reports every member that names it, also through the same helper type', () => {
    const problems = demoWith('interface Helper {\n    feature: Feature;\n}\nexport interface Options {\n    a: Feature;\n    b: Feature;\n    c: Helper;\n    d: Helper;\n}\n');
    expect(problems['@marmeon/demo']!.map((problem) => problem.split(' names ')[0])).toEqual(['a', 'b', 'c', 'd'].map((member) => `@marmeon/demo › Options.${member}`));
  });

  it('walks a helper type that names itself once', () => {
    const problems = demoWith('interface Tree {\n    children: Tree[];\n    feature: Feature;\n}\nexport declare function use(tree: Tree): void;\n');
    expect(problems['@marmeon/demo']).toEqual([expect.stringMatching(/^@marmeon\/demo › use names Feature \(through Tree\), /)]);
  });

  it('lets an @experimental member name it, and the experimental entry itself', () => {
    const files = { 'adapter.d.ts': 'export interface Feature {\n    on(): void;\n}\nexport declare function attach(feature: Feature): void;\n' };
    expect(demoWith('export interface Options {\n    path: string;\n    /** @experimental */\n    features?: Feature[];\n}\n', { files })).toEqual({});
  });

  it('lets it pass once a stable entry exports it too', () => {
    expect(demoWith("export declare function use(feature: Feature): void;\nexport type { Feature } from './adapter.ts';\n")).toEqual({});
  });

  it('reports a declaration marked @experimental that a stable one names', () => {
    const problems = problemsOf({ demo: { exports: { '.': 'index.d.ts' }, files: { 'index.d.ts': '/** @experimental */\nexport interface Beta {\n    a: 1;\n}\nexport type Names = keyof Beta;\n' } } });
    expect(problems['@marmeon/demo']).toEqual([`@marmeon/demo › Names names Beta, which is experimental (exported by @marmeon/demo (@experimental); declared in packages/demo/dist/index.d.ts): ${advice}`]);
  });

  it('reports an augmentation a stable entry reaches', () => {
    const problems = demoWith("declare module '@marmeon/core' {\n    interface ApplicationDefinition {\n        feature?: Feature;\n    }\n}\nexport declare const a: 1;\n");
    expect(problems['@marmeon/demo']).toEqual([
      `@marmeon/demo › @marmeon/core.ApplicationDefinition.feature names Feature, which is experimental (exported by @marmeon/demo/adapter; declared in packages/demo/dist/adapter.d.ts): ${advice}`,
    ]);
  });

  describe('across packages', () => {
    const live: Fixture = { exports: { './testing': 'testing.d.ts' }, experimental: true, files: { 'testing.d.ts': "export interface Recorder {\n    calls: number;\n}\nexport * from './more.ts';\n", 'more.d.ts': 'export declare const more: 1;\n' } };

    it('follows a name of another package to its declaration', () => {
      const problems = problemsOf({ live, testing: { exports: { '.': 'index.d.ts' }, files: { 'index.d.ts': "import type { Recorder } from '@marmeon/live/testing';\nexport declare class TestApp {\n    constructor(recorder: Recorder);\n}\n" } } });
      expect(problems).toEqual({
        '@marmeon/testing': [`@marmeon/testing › TestApp.constructor names Recorder, which is experimental (exported by @marmeon/live/testing; declared in packages/live/dist/testing.d.ts): ${advice}`],
      });
    });

    it('follows `import()` types and namespace imports', () => {
      const index = "import * as live from '@marmeon/live/testing';\nexport declare function a(r: live.Recorder): void;\nexport declare function b(r: import('@marmeon/live/testing').Recorder): void;\n";
      expect(problemsOf({ live, testing: { exports: { '.': 'index.d.ts' }, files: { 'index.d.ts': index } } })['@marmeon/testing']).toHaveLength(2);
    });

    it('reports a re-export of an experimental type or entry from a stable entry', () => {
      const index = "export type { Recorder } from '@marmeon/live/testing';\nexport * from '@marmeon/live/testing';\n";
      expect(problemsOf({ live, testing: { exports: { '.': 'index.d.ts' }, files: { 'index.d.ts': index } } })['@marmeon/testing']).toEqual([
        `@marmeon/testing › * from @marmeon/live/testing re-exports @marmeon/live/testing, which is experimental: ${again}`,
        `@marmeon/testing › Recorder re-exports Recorder, which is experimental (exported by @marmeon/live/testing; declared in packages/live/dist/testing.d.ts): ${again}`,
      ]);
    });

    it('follows `export *` and `export * as` between packages', () => {
      const bridge: Fixture = { exports: { '.': 'index.d.ts' }, experimental: true, files: { 'index.d.ts': "export * from '@marmeon/live/testing';\nexport * as recording from '@marmeon/live/testing';\n" } };
      const index = "import type { Recorder, recording } from '@marmeon/bridge';\nexport declare function a(r: Recorder): void;\nexport declare function b(r: recording.Recorder): void;\n";
      const problems = problemsOf({ live, bridge, testing: { exports: { '.': 'index.d.ts' }, files: { 'index.d.ts': index } } })['@marmeon/testing'];
      expect(problems!.map((problem) => problem.split(',')[0])).toEqual(['@marmeon/testing › a names Recorder', '@marmeon/testing › b names Recorder']);
    });

    it('follows them through a file of the package', () => {
      const files = {
        'bridge.d.ts': "export * from '@marmeon/live/testing';\nexport * as rec from '@marmeon/live/testing';\n",
        'index.d.ts': "import type { Recorder, rec } from './bridge.ts';\nexport declare function a(r: Recorder): void;\nexport declare function b(r: rec.Recorder): void;\n",
      };
      const problems = problemsOf({ live, testing: { exports: { '.': 'index.d.ts' }, files } })['@marmeon/testing'];
      expect(problems!.map((problem) => problem.split(',')[0])).toEqual(['@marmeon/testing › a names Recorder', '@marmeon/testing › b names Recorder']);
    });

    it('reports a whole experimental entry point that a stable item names or re-exports through a namespace', () => {
      const bridge: Fixture = { exports: { '.': 'index.d.ts' }, files: { 'index.d.ts': "export * as recording from '@marmeon/live/testing';\n" } };
      const index = "import type { recording } from '@marmeon/bridge';\nexport declare const a: typeof recording;\nexport { recording } from '@marmeon/bridge';\n";
      expect(problemsOf({ live, bridge, testing: { exports: { '.': 'index.d.ts' }, files: { 'index.d.ts': index } } })['@marmeon/testing']).toEqual([
        '@marmeon/testing › a names the whole of @marmeon/live/testing, which is experimental: name a stable type',
        `@marmeon/testing › recording re-exports @marmeon/live/testing, which is experimental: ${again}`,
      ]);
    });

    it('ends on packages whose stars export each other', () => {
      const star = (others: string[]): Fixture => ({ exports: { '.': 'index.d.ts' }, files: { 'index.d.ts': others.map((other) => `export * from '@marmeon/${other}';\n`).join('') } });
      const fillers = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`filler${index}`, { exports: { '.': 'index.d.ts' }, files: { 'index.d.ts': 'export declare const x: 1;\n' } }]));
      const user: Fixture = { exports: { '.': 'index.d.ts' }, files: { 'index.d.ts': "import type { Missing } from '@marmeon/a';\nexport declare function f(m: Missing): void;\n" } };
      expect(problemsOf({ ...fillers, a: star(['b', 'c']), b: star(['a', 'c']), c: star(['a', 'b']), user })).toEqual({});
    });

    it('lets an experimental package name it, and a library pass', () => {
      const devtools: Fixture = { exports: { '.': 'index.d.ts' }, experimental: true, files: { 'index.d.ts': "import type { Recorder } from '@marmeon/live/testing';\nexport declare function show(r: Recorder): void;\n" } };
      const stable: Fixture = { exports: { '.': 'index.d.ts' }, files: { 'index.d.ts': "import type { Hono } from 'hono';\nexport declare function f(app: Hono): void;\n" } };
      expect(problemsOf({ live, devtools, stable })).toEqual({});
    });
  });

  it('fails pnpm api:check, under the package that names the type', async () => {
    const { root } = demo({ 'index.d.ts': "import type { Feature } from './adapter.ts';\nexport declare function use(feature: Feature): void;\n", 'adapter.d.ts': 'export interface Feature {}\n' }, { '.': 'index.d.ts', './adapter': 'adapter.d.ts' }, { marmeon: { experimental: ['./adapter'] } });
    const run = await runApi(root, { write: true });
    expect(run.code).toBe(1);
    expect(run.lines.slice(0, 2)).toEqual(['@marmeon/demo:', `  @marmeon/demo › use names Feature, which is experimental (exported by @marmeon/demo/adapter; declared in packages/demo/dist/adapter.d.ts): ${advice}`]);
  });
});

describe('the repository', () => {
  const built = frameworkPackages(repository).every((pkg) => {
    const exports = (pkg.manifest.exports ?? {}) as Record<string, { types?: string }>;
    return Object.values(exports).every((conditions) => conditions.types === undefined || existsSync(join(pkg.dir, conditions.types)));
  });

  // Reads the declarations of all packages and imports their built code: 2.3 s alone, 4.1 s with six runs side by side — too close to the default 5 s for a slow runner.
  it.skipIf(!built)('has an api.md for every package that matches the built declarations', async () => {
    expect((await runApi(repository)).lines).toEqual(['api: every api.md matches the built declarations, environment variables and commands']);
  }, 30_000);
});
