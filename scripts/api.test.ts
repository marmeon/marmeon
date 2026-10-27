import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FOREIGN_TYPES, foreignPackage, internalProblems, memberProblems, memberStatus, memberUsage, nameProblems, runApi as runApiWithLists, runtimeItems, snapshotPackage, spanProblems, stabilityProblems, staleHiddenInApi } from './api.ts';
import { INTERNAL_EXCEPTIONS } from './api-internal.ts';
import { SAME_VALUE } from './api-names.ts';
import { SPAN_EXCEPTIONS } from './api-spans.ts';
import { compareSnapshots, parseSnapshot, type ApiItem } from './api-snapshot.ts';
import { INTERNAL } from './check-source.ts';
import { frameworkPackages } from './packages.ts';
import { tempDir } from './test/temp-dir.js';

const repository = fileURLToPath(new URL('..', import.meta.url));

/** The fixtures are no framework: the real exceptions would be stale in them. */
const NO_NAMES = { sameValue: {} };
/** The import specifier of the fixture's `./internal` entry, written so that check:source does not read it as an import of ours. */
const DEMO_INTERNAL = `@marmeon/demo${INTERNAL}`;
/** Another package takes `c` from `./internal`, the one name the fixtures export there. */
const CONSUMER = [{ path: 'packages/other/src/c.ts', text: `import { c } from '${DEMO_INTERNAL}';` }];
const NO_INTERNAL = { exceptions: {} };
const NO_SPANS = { exceptions: {} };
const NO_MEMBERS = { exceptions: {} };
const runApi = (root: string, options: NonNullable<Parameters<typeof runApiWithLists>[1]> = {}) => runApiWithLists(root, { names: NO_NAMES, spans: NO_SPANS, internal: NO_INTERNAL, members: NO_MEMBERS, files: CONSUMER, ...options });

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
  // Every entry point is built: a module of its own, empty unless the test gives it code.
  const built: Record<string, string> = Object.fromEntries(Object.values(exports).map((file) => [file.replace(/\.d\.ts$/, '.js'), '']));
  for (const [name, text] of Object.entries({ ...built, ...files })) {
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

  const locking = (name: string, variables: string, locks: string) =>
    `{ name: '${name}', env: { [Symbol.for('marmeon.env.fields')]: { ${variables} }, [Symbol.for('marmeon.env.renamed')]: { ${locks} } } }`;

  it('reports one retired name that two configs lock to different targets', async () => {
    const { items, problems } = await read(`${locking('first', 'A: optional', "OLD: 'A'")}, ${locking('second', 'B: optional', "OLD: 'B'")}`);
    expect(problems).toEqual(['@marmeon/demo: OLD is retired for A by one config and for B by the config second — one name cannot lead to two']);
    expect(items.filter((item) => item.name === 'OLD')).toHaveLength(1);
    expect((await read(`${locking('first', 'A: optional', "OLD: 'A'")}, ${locking('second', 'A: optional', "OLD: 'A'")}`)).problems).toEqual([]);
  });

  it('reports a retired name that another config reads as a variable', async () => {
    const { problems } = await read(`${locking('first', 'NEW: optional', "OLD: 'NEW'")}, ${locking('second', 'OLD: optional', '')}`);
    expect(problems).toEqual(['@marmeon/demo: OLD is retired for NEW, but a config reads OLD as a variable — a retired name is never given out again']);
  });

  it('marks a switch without a default, since its type shows nowhere else', async () => {
    const { items } = await read(
      "fields({ ON: { '~env': (raw) => ({ value: raw === 'true' ? true : raw === 'false' ? false : undefined, problem: raw === 'maybe' ? 'no' : undefined }) }, PLAIN: optional, MUST: { '~env': (raw) => ({ value: raw === 'true' ? true : raw === 'false' ? false : undefined, problem: raw === undefined || raw === 'maybe' ? 'no' : undefined }) } })",
    );
    expect(items.map((item) => item.text)).toEqual(['`ON` — optional (boolean)', '`PLAIN` — optional', '`MUST` — required (boolean)']);
  });

  it('reports a switch that is read as text', async () => {
    const asText = "{ '~env': (raw) => (raw === 'true' || raw === 'false' ? { value: raw } : raw === undefined ? { value: undefined } : { problem: 'no' }) }";
    const { problems } = await read(`fields({ FLAG: ${asText} })`);
    expect(problems).toEqual(['@marmeon/demo: FLAG (config demo) is a switch read as text — read it with env.boolean()']);
    expect((await read("fields({ FREE: { '~env': (raw) => ({ value: raw }) } })")).problems).toEqual([]);
  });

  it('reports an entry point of the package that is not built', async () => {
    const { dir, manifest } = demo({ 'index.d.ts': 'export declare const a: 1;\n', 'extra.d.ts': 'export declare const b: 1;\n' }, { '.': 'index.d.ts', './extra': 'extra.d.ts' });
    rmSync(join(dir, 'dist/extra.js'));
    const { problems } = await runtimeItems({ name: '@marmeon/demo', dir, manifest });
    expect(problems.join('\n')).toMatch(/cannot import \.\/dist\/extra\.js .* run pnpm build first/);
  });

  it('lists the configs a public entry point exports, apart from the listed providers', async () => {
    const { dir, manifest } = demo(
      {
        'index.d.ts': 'export declare const a: 1;\n',
        'index.js': "export class P { static config = []; }",
        'extra.d.ts': 'export declare const b: 1;\n',
        'extra.js': `
          const config = (name, variable) => ({ name, env: { [Symbol.for('marmeon.env.fields')]: { [variable]: { '~env': () => ({ value: 1 }) } } } });
          export const BareConfig = config('bare', 'BARE_ONE');
          export class OptInProvider { static config = [config('optin', 'OPTIN_ONE')]; }
          export const NotAConfig = { name: 'x', env: {} };
          export class Plain { static config = 5; }
        `,
        'internal.d.ts': 'export declare const c: 1;\n',
        'internal.js': "export const Hidden = { name: 'h', env: { [Symbol.for('marmeon.env.fields')]: { HIDDEN: { '~env': () => ({ value: 1 }) } } } };",
      },
      { '.': 'index.d.ts', './extra': 'extra.d.ts', './internal': 'internal.d.ts' },
      { marmeon: { providers: ['P'] } },
    );
    const { items, problems } = await runtimeItems({ name: '@marmeon/demo', dir, manifest });
    expect(problems).toEqual([]);
    expect(items.map((item) => item.name).sort()).toEqual(['BARE_ONE', 'OPTIN_ONE']);
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
    rmSync(join(dir, 'dist/index.js'));
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

  it('lists a hidden command apart from the API, except those in HIDDEN_COMMANDS_IN_API', async () => {
    const hidden = (name: string) => `class C${name.replace(/\W/g, '')} { static command = '${name}'; static hidden = true; static options = {}; }`;
    const { items } = await read('', `[${hidden('demo:build-step')}, ${hidden('serve')}, class Plain { static command = 'demo:plain'; static options = {}; }]`);
    expect(items.map((item) => `${item.section}:${item.name}`)).toEqual(['hidden:demo:build-step', 'commands:serve', 'commands:demo:plain']);
  });

  it('reports through runtimeItems a serve of the CLI that is not hidden', async () => {
    const { dir, manifest } = demo({ 'index.d.ts': 'export declare const a: 1;\n', 'built-in.js': "export const BUILT_IN = [class Serve { static command = 'serve'; static options = {}; }];" });
    const { problems } = await runtimeItems({ name: 'marmeon', dir, manifest });
    expect(problems.join('\n')).toContain('marmeon: HIDDEN_COMMANDS_IN_API lists serve, which is no hidden command');
  });

  it('reports a line of HIDDEN_COMMANDS_IN_API that names no hidden command', () => {
    expect(staleHiddenInApi([{ command: 'serve', hidden: true }])).toEqual([]);
    expect(staleHiddenInApi([{ command: 'serve' }])).toHaveLength(1);
    expect(staleHiddenInApi([])[0]).toContain('serve');
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

    it('accepts an empty list when nothing is experimental, and names a package that is experimental all the same', async () => {
      const none = '# Releases\n\n## What is public API\n\n### Experimental\n\nNothing in this release is experimental.\n\n## Next\n';
      const clean = setup(two, undefined);
      releases(clean, none);
      expect((await runApi(clean, { write: true })).code).toBe(0);
      expect((await runApi(clean)).code).toBe(0);
      const marked = setup(two, ['./b']);
      releases(marked, none);
      const run = await runApi(marked, { write: true });
      expect(run.code).toBe(1);
      expect(run.lines.join('\n')).toContain('does not name @marmeon/demo/b under "### Experimental"');
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

describe('one exported name, one declaration', () => {
  /** Packages `a`, `b`, … side by side, each with the text of its `dist/index.d.ts`. */
  const names = (packages: Record<string, string>, lists: Partial<Parameters<typeof nameProblems>[1]> = {}) => {
    const root = tempDir('marmeon-api-');
    for (const [directory, text] of Object.entries(packages)) {
      const dir = join(root, 'packages', directory);
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@x/${directory}`, version: '0.0.0', exports: { '.': { types: './dist/index.d.ts' } } }));
      writeFileSync(join(dir, 'dist/index.d.ts'), text);
    }
    return nameProblems(frameworkPackages(root), { ...NO_NAMES, ...lists });
  };

  it('names a type that two packages declare apart', () => {
    expect(names({ a: 'export interface Foo { a: 1 }\n', b: 'export interface Foo { b: 2 }\n' })).toEqual([
      '`Foo` is exported as two declarations: @x/a (src/index.ts) and @x/b (src/index.ts) — rename one (CONTRIBUTING › The API snapshot)',
    ]);
  });

  it('counts a re-export as the same declaration', () => {
    expect(names({ a: 'export interface Foo { a: 1 }\n', b: "export type { Foo } from '@x/a';\n" })).toEqual([]);
    expect(names({ a: 'export interface Foo { a: 1 }\n', b: "import type { Foo } from '@x/a';\nexport type { Foo };\n" })).toEqual([]);
  });

  it('counts a helper type with the same text as one declaration', () => {
    const simplify = 'export type Simplify<T> = { [K in keyof T]: T[K] } & {};\n';
    expect(names({ a: simplify, b: `// another file\n${simplify}` })).toEqual([]);
  });

  it('leaves out a declaration marked @internal', () => {
    expect(names({ a: 'export interface Foo { a: 1 }\n', b: '/** @internal */\nexport interface Foo { b: 2 }\n' })).toEqual([]);
  });

  it('lets a name of sameValue differ', () => {
    const packages = { a: 'export interface Foo { a: 1 }\n', b: 'export interface Foo { b: 2 }\n' };
    expect(names(packages, { sameValue: { Foo: 'the same value' } })).toEqual([]);
  });

  it('names a sameValue entry that no longer collides, and does not take a name off the prototype for one', () => {
    expect(names({ a: 'export interface Foo { a: 1 }\n' }, { sameValue: { Foo: 'the same value' } })).toEqual(['`Foo` is listed in SAME_VALUE but no longer collides — delete the line']);
    const packages = { a: 'export interface toString { a: 1 }\n', b: 'export interface toString { b: 2 }\n' };
    expect(names(packages)).toHaveLength(1);
  });

  it('refuses every collision that sameValue does not list', () => {
    const packages = {
      a: 'export interface Foo { a: 1 }\nexport interface Bar { a: 1 }\n',
      b: 'export interface Foo { b: 2 }\nexport interface Bar { b: 2 }\n',
    };
    expect(names(packages)).toHaveLength(2);
    expect(names(packages, { sameValue: { Foo: 'the same value' } })).toHaveLength(1);
  });

  it('keeps the list of the repository to the agreed exceptions', () => {
    expect(Object.keys(SAME_VALUE).sort()).toEqual(['CookieDefaults', 'RevalidateOnBack', 'Translator']);
  });
});

describe('spans of time', () => {
  const spans = (text: string, lists: Partial<Parameters<typeof spanProblems>[1]> = {}, extra: Record<string, unknown> = {}, files: Record<string, string> = {}) => {
    const { dir, manifest } = demo({ 'index.d.ts': text, ...files }, undefined, extra);
    return spanProblems([{ name: '@marmeon/demo', dir, manifest }], { ...NO_SPANS, ...lists });
  };
  const message = (where: string) => `@marmeon/demo ${where} is a span of time as a bare number — take a Duration, or name its unit (docs/time.md › Spans of time)`;

  it('names a bare number whose name ends in a span word', () => {
    expect(spans('export interface Options {\n    timeout: number;\n    readonly islandTimeout?: number;\n}\n')).toEqual([message('Options.islandTimeout'), message('Options.timeout')]);
  });

  it('lets a Duration, a name with its unit and other names be', () => {
    const text = "import type { Duration } from '@marmeon/core';\nexport interface Options {\n    ttl?: Duration;\n    delay?: number | Duration;\n    timeoutMs: number;\n    retryAfterSeconds: number;\n    before: number;\n    await: number;\n}\n";
    expect(spans(text)).toEqual([]);
  });

  it('names a method, a getter and a function that returns a bare number', () => {
    const text = 'export declare class Cache {\n    ttl(key: string): Promise<number>;\n    get lifetime(): number;\n    static readonly backoff: number[];\n}\nexport declare function sleep(): number;\n';
    expect(spans(text)).toEqual([message('Cache.backoff'), message('Cache.lifetime'), message('Cache.ttl'), message('sleep')]);
  });

  it('names a parameter, also in an options object', () => {
    const text = 'export declare function wait(timeout: number, options: { delay?: number }): void;\nexport declare class Q {\n    worker(stopTimeout: number): void;\n    run({ a }: { a: 1 }, wait?: number): void;\n}\n';
    expect(spans(text)).toEqual([message('Q.run(wait)'), message('Q.worker(stopTimeout)'), message('wait(options).delay'), message('wait(timeout)')]);
  });

  it('reads a function type by what it returns', () => {
    expect(spans('export interface Hooks {\n    delay: (attempt: number) => void;\n    sleep: (ms: Duration) => number;\n}\n')).toEqual([message('Hooks.sleep')]);
  });

  it('leaves out @internal and @experimental members and experimental entry points', () => {
    const text = 'export interface Options {\n    /** @internal */\n    timeout: number;\n    /** @experimental */\n    ttl: number;\n}\n';
    expect(spans(text)).toEqual([]);
    expect(spans('export interface Options {\n    timeout: number;\n}\n', {}, { marmeon: { experimental: true } })).toEqual([]);
  });

  it('leaves out ./internal and counts a declaration once', () => {
    const { dir, manifest } = demo(
      { 'index.d.ts': "export * from './a.ts';\n", 'a.d.ts': 'export interface Options {\n    timeout: number;\n}\n', 'internal.d.ts': 'export interface Hidden {\n    timeout: number;\n}\n', 'other.d.ts': "export * from './a.ts';\n" },
      { '.': 'index.d.ts', './other': 'other.d.ts', './internal': 'internal.d.ts' },
    );
    expect(spanProblems([{ name: '@marmeon/demo', dir, manifest }], NO_SPANS)).toEqual([message('Options.timeout')]);
  });

  it('reads a span inside a type argument, a call signature and a type parameter', () => {
    const text = "export interface Def<T> { value: T }\nexport interface Options extends Def<{ lifetime: number }> {\n    later: Promise<{ ttl: number }>;\n    (timeout: number): void;\n    g<T extends { delay: number }>(a: T): void;\n}\n";
    expect(spans(text)).toEqual([message('Options(timeout)'), message('Options.g.delay'), message('Options.later.ttl'), message('Options.lifetime')]);
  });

  it('reads a helper type that no entry exports but a signature names', () => {
    expect(spans('type Overlapping = { expiresAfter: number };\nexport declare function f(a: Overlapping): void;\n')).toEqual([message('Overlapping.expiresAfter')]);
  });

  it('lets an exception stand', () => {
    const text = 'export interface Options {\n    timeout: number;\n}\n';
    expect(spans(text, { exceptions: { '@marmeon/demo Options.timeout': 'milliseconds' } })).toEqual([]);
  });

  it('names an exception that follows the rule', () => {
    const text = 'export interface Options {\n    timeoutMs: number;\n}\n';
    expect(spans(text, { exceptions: { '@marmeon/demo Options.timeout': 'milliseconds' } })).toEqual([
      '@marmeon/demo Options.timeout is listed in SPAN_EXCEPTIONS but is no bare number span any more — delete the line',
    ]);
  });

  describe('a span in the position of a parameter', () => {
    const positional = (where: string) => `@marmeon/demo ${where} is a span of time as a positional number — move it into an options object, or take a Duration (docs/time.md › Spans of time)`;

    it('names a positional number whose name, without its unit, is a span name', () => {
      const text = 'export declare class Locks {\n    prune(graceSeconds: number): void;\n    run(lifetimeMinutes?: number): void;\n    poll(everyDays: number | undefined, intervalMs: number): void;\n}\nexport declare function wait(delayMilliseconds: number, ttlHours: number): void;\n';
      expect(spans(text)).toEqual([
        positional('Locks.poll(intervalMs)'),
        positional('Locks.prune(graceSeconds)'),
        positional('Locks.run(lifetimeMinutes)'),
        positional('wait(delayMilliseconds)'),
        positional('wait(ttlHours)'),
      ]);
    });

    it('names a parameter that is only a unit (`seconds?: number`)', () => {
      const text = 'export declare class Auth {\n    passwordRecentlyConfirmed(seconds?: number): boolean;\n    later(minutes: number | undefined, ms: number): void;\n}\nexport declare function pause(hours: number, days: number): void;\n';
      expect(spans(text)).toEqual([
        positional('Auth.later(minutes)'),
        positional('Auth.later(ms)'),
        positional('Auth.passwordRecentlyConfirmed(seconds)'),
        positional('pause(days)'),
        positional('pause(hours)'),
      ]);
    });

    it('lets a Duration, an options object, a callback and a name that is no span be', () => {
      const text = "import type { Duration } from '@marmeon/core';\nexport declare function a(grace: Duration, options: { graceSeconds?: number }): void;\nexport declare function b(retryDelayMs: (attempt: number) => number, countDays: number, seconds: Duration): void;\n";
      expect(spans(text)).toEqual([]);
    });

    it('lets an exception stand and names one that follows the rule', () => {
      const text = 'export declare function prune(graceSeconds: number): void;\n';
      expect(spans(text, { exceptions: { '@marmeon/demo prune(graceSeconds)': 'a store contract' } })).toEqual([]);
      expect(spans('export declare function prune(options: { graceSeconds?: number }): void;\n', { exceptions: { '@marmeon/demo prune(graceSeconds)': 'a store contract' } })).toEqual([
        '@marmeon/demo prune(graceSeconds) is listed in SPAN_EXCEPTIONS but is no bare number span any more — delete the line',
      ]);
    });
  });

  it('fails pnpm api:check for a bare number span', async () => {
    const { root } = demo({ 'index.d.ts': 'export interface Options {\n    timeout: number;\n}\n' });
    const run = await runApi(root);
    expect(run.code).toBe(1);
    expect(run.lines).toContain('spans of time:');
  });

  it('gives every exception of the repository a reason', () => {
    expect(Object.keys(SPAN_EXCEPTIONS).every((key) => SPAN_EXCEPTIONS[key]!.length > 0)).toBe(true);
  });
});

describe('./internal entries and leaked classes', () => {
  const ENTRIES = { '.': 'index.d.ts', './internal': 'internal.d.ts' };
  const internal = (
    files: Record<string, string>,
    sources: Record<string, string> = {},
    lists: Partial<Parameters<typeof internalProblems>[3]> = {},
    exports: Record<string, string> = ENTRIES,
  ) => {
    const { root, dir, manifest } = demo(files, exports);
    const sourceFiles = Object.entries(sources).map(([path, text]) => ({ path, text }));
    return internalProblems([{ name: '@marmeon/demo', dir, manifest }], root, () => sourceFiles, { ...NO_INTERNAL, ...lists });
  };
  const unused = (name: string) => `@marmeon/demo/internal ${name} is exported from an ./internal entry but no file outside its package imports it — stop exporting it, or use it from the package that needs it`;
  const leaked = (name: string) => `@marmeon/demo ${name} is a class a public signature names, but no entry exports it — mark the member that names it @internal, or export the class`;
  const text = { 'index.d.ts': '', 'internal.d.ts': 'export declare const used: 1;\nexport declare const ownOnly: 1;\nexport declare const testOnly: 1;\n' };

  it('names an internal export that only its own package imports', () => {
    const sources = {
      'packages/demo/src/a.ts': `import { ownOnly, used } from '${DEMO_INTERNAL}';`,
      'packages/other/src/a.ts': `import { used, type Missing } from '${DEMO_INTERNAL}';`,
      'packages/other/src/a.test.ts': `import { testOnly } from '${DEMO_INTERNAL}';`,
    };
    expect(internal(text, sources)).toEqual([unused('ownOnly')]);
  });

  it('counts a multi-line import and a re-export of another package', () => {
    const sources = {
      'packages/other/src/a.ts': `import {\n  ownOnly,\n} from '${DEMO_INTERNAL}';`,
      'packages/another/src/a.ts': `export { used, testOnly } from '${DEMO_INTERNAL}';`,
    };
    expect(internal(text, sources)).toEqual([]);
  });

  it('counts a name in a whole import only as a member or a destructured key, not in a comment or a string', () => {
    const entry = `const mod = await import('${DEMO_INTERNAL}');\n`;
    const code = `${entry}// ownOnly testOnly\nconst text = 'mod.ownOnly { testOnly }';\nmod.used;`;
    expect(internal(text, { 'packages/other/src/a.ts': code })).toEqual([unused('ownOnly'), unused('testOnly')]);
    expect(internal(text, { 'packages/other/src/a.ts': `${entry}const { ownOnly } = mod;\nmod?.testOnly;\nmod.used;` })).toEqual([]);
  });

  it('reads a namespace by its members and an import of the entry as a whole by the names the file spells', () => {
    expect(internal(text, { 'packages/other/src/a.ts': `import * as inner from '${DEMO_INTERNAL}';\ninner.used; inner.ownOnly;` })).toEqual([unused('testOnly')]);
    expect(internal(text, { 'packages/other/src/a.ts': `const mod = await import('${DEMO_INTERNAL}');\nmod.used; mod.ownOnly; mod.testOnly;` })).toEqual([]);
    expect(internal(text, { 'packages/other/src/a.ts': `const mod = await import('${DEMO_INTERNAL}');\nmod.used;` })).toEqual([unused('ownOnly'), unused('testOnly')]);
  });

  it('leaves out build output, dependencies and files that are no code', () => {
    const sources = { 'packages/other/dist/a.js': `import { used } from '${DEMO_INTERNAL}';`, 'docs/x.md': `import { ownOnly } from '${DEMO_INTERNAL}';` };
    expect(internal(text, sources)).toEqual([unused('ownOnly'), unused('testOnly'), unused('used')]);
  });

  it('reads an internal entry of a subpath too', () => {
    const files = { 'index.d.ts': '', 'tools/internal.d.ts': 'export declare const used: 1;\n' };
    expect(internal(files, {}, {}, { '.': 'index.d.ts', './tools/internal': 'tools/internal.d.ts' })).toEqual(['@marmeon/demo/tools/internal used is exported from an ./internal entry but no file outside its package imports it — stop exporting it, or use it from the package that needs it']);
  });

  it('names a class a public signature names but no entry exports', () => {
    const files = { 'index.d.ts': 'declare class Secret {}\nexport declare class Public {\n    secret(): Secret;\n}\n', 'internal.d.ts': '' };
    expect(internal(files)).toEqual([leaked('Secret')]);
  });

  it('follows a helper type to the class it names', () => {
    const files = { 'index.d.ts': 'declare class Deep {}\ntype Helper = { deep: Deep };\nexport declare function f(): Helper;\n', 'internal.d.ts': '' };
    expect(internal(files)).toEqual([leaked('Deep')]);
  });

  it('names a class that is @internal itself when a public signature names it', () => {
    const files = { 'index.d.ts': '/** @internal */\ndeclare class Secret {}\nexport declare class Public {\n    secret(): Secret;\n}\n', 'internal.d.ts': '' };
    expect(internal(files)).toEqual([leaked('Secret')]);
  });

  it('lets a class that an entry exports, an interface, an @internal member and ./internal stand', () => {
    const files = {
      'index.d.ts': "import { Exported } from './exported.ts';\ndeclare class Hidden {}\ninterface Shape {}\nexport declare class Public {\n    a(): Exported;\n    b(): Shape;\n    /** @internal */\n    c(): Hidden;\n}\n",
      'exported.d.ts': 'export declare class Exported {}\n',
      'other.d.ts': "export { Exported } from './exported.ts';\n",
      'internal.d.ts': 'declare class Inner {}\nexport declare function g(): Inner;\n',
    };
    expect(internal(files, { 'packages/other/src/a.ts': `import { g } from '${DEMO_INTERNAL}';` }, {}, { ...ENTRIES, './other': 'other.d.ts' })).toEqual([]);
  });

  it('matches a class by its declaration, not its name', () => {
    const files = {
      'index.d.ts': "import { Thing } from './a.ts';\nexport declare function f(): Thing;\n",
      'a.d.ts': 'export declare class Thing {}\n',
      'other.d.ts': 'export declare class Thing {}\n',
    };
    expect(internal({ ...files, 'internal.d.ts': '' }, {}, {}, { ...ENTRIES, './other': 'other.d.ts' })).toEqual([leaked('Thing')]);
  });

  it('lets an exception stand', () => {
    const lists = { exceptions: { '@marmeon/demo/internal ownOnly': 'the launcher resolves it by path', '@marmeon/demo/internal testOnly': 'a test reads it', '@marmeon/demo/internal used': 'a test reads it' } };
    expect(internal(text, {}, lists)).toEqual([]);
  });

  it('names an exception that follows the rule', () => {
    const files = { 'index.d.ts': '', 'internal.d.ts': 'export declare const used: 1;\n' };
    const lists = { exceptions: { '@marmeon/demo Gone': 'was leaked', '@marmeon/demo/internal used': 'a test reads it' } };
    expect(internal(files, { 'packages/other/src/a.ts': `import { used } from '${DEMO_INTERNAL}';` }, lists)).toEqual([
      '@marmeon/demo Gone is listed in INTERNAL_EXCEPTIONS but follows the rule — delete the line',
      '@marmeon/demo/internal used is listed in INTERNAL_EXCEPTIONS but follows the rule — delete the line',
    ]);
  });

  it('reads no source files for a package without ./internal', () => {
    const { root, dir, manifest } = demo({ 'index.d.ts': '' });
    let read = false;
    expect(internalProblems([{ name: '@marmeon/demo', dir, manifest }], root, () => ((read = true), []), NO_INTERNAL)).toEqual([]);
    expect(read).toBe(false);
  });

  it('fails pnpm api:check for an internal name nobody imports', async () => {
    const { root } = demo({ 'index.d.ts': '', 'internal.d.ts': 'export declare const used: 1;\n' }, ENTRIES);
    const run = await runApi(root, { files: [] });
    expect(run.code).toBe(1);
    expect(run.lines).toContain('internal:');
  });

  it('gives every exception of the repository a reason', () => {
    expect(Object.keys(INTERNAL_EXCEPTIONS).every((key) => INTERNAL_EXCEPTIONS[key]!.length > 0)).toBe(true);
  });
});

describe('the repository', () => {
  const built = frameworkPackages(repository).every((pkg) => {
    const exports = (pkg.manifest.exports ?? {}) as Record<string, { types?: string }>;
    return Object.values(exports).every((conditions) => conditions.types === undefined || existsSync(join(pkg.dir, conditions.types)));
  });

  // Reads the declarations of all packages and imports their built code: 2.3 s alone, 4.1 s with six runs side by side — too close to the default 5 s for a slow runner.
  it.skipIf(!built)('has an api.md for every package that matches the built declarations', async () => {
    expect((await runApiWithLists(repository)).lines).toEqual(['api: every api.md matches the built declarations, environment variables and commands']);
  }, 30_000);
});

describe('constructors and members that only their own package uses', () => {
  const CLASSES = [
    'export declare class Box {',
    '    constructor();',
    '    open(): void;',
    '    close(): void;',
    '    get size(): number;',
    '    static make(): Box;',
    '}',
    '',
  ].join('\n');
  const members = (declaration: string, sources: Record<string, string> = {}, lists: Partial<Parameters<typeof memberProblems>[3]> = {}) => {
    const { root, dir, manifest } = demo({ 'index.d.ts': declaration });
    const sourceFiles = Object.entries(sources).map(([path, text]) => ({ path, text }));
    return memberProblems([{ name: '@marmeon/demo', dir, manifest }], root, () => sourceFiles, { ...NO_MEMBERS, ...lists });
  };
  const nowhere = (key: string) => `@marmeon/demo ${key} is used nowhere outside @marmeon/demo (docs, apps, the kit) — mark it @internal, or list it in MEMBER_EXCEPTIONS with the reason an app needs it; see \`pnpm api:usage @marmeon/demo --members --files\``;
  const siblingsOnly = (key: string) => `@marmeon/demo ${key} is used only by other framework packages — mark it @internal (they may still call it); see \`pnpm api:usage @marmeon/demo --members --files\``;
  const own = { 'packages/demo/src/a.ts': 'new Box(); box.open(); box.close(); box.size; Box.make();' };
  const ALL = ['Box.close', 'Box.constructor', 'Box.make', 'Box.open', 'Box.size'];

  it('reports a constructor and members that only their own package uses', () => {
    expect(members(CLASSES, own)).toEqual(ALL.map(nowhere));
  });

  it('counts a use in the docs, even in prose, and `new` in a code block', () => {
    const sources = { 'docs/box.md': 'Call `box.open()` and `box.close()`; read `box.size`.\n\n```ts\nconst box = new Box();\nBox.make();\n```\n' };
    expect(members(CLASSES, { ...own, ...sources })).toEqual([]);
  });

  it('counts the apps with their tests and the kit, not the tests of a framework package', () => {
    const sources = {
      'apps/shop/modules/a.test.ts': 'box.open(); new Box();',
      'packages/demo/stubs/a.ts': 'box.close();',
      'packages/other/src/a.test.ts': 'box.size; Box.make();',
      'packages/other/src/__fixtures__/a.ts': 'box.size; Box.make();',
    };
    expect(members(CLASSES, sources)).toEqual([nowhere('Box.make'), nowhere('Box.size')]);
  });

  it('names a member that only the code of another framework package uses', () => {
    const sources = { 'packages/other/src/a.ts': 'box.open(); new Box();', 'packages/other/src/a.test.ts': 'box.close();' };
    expect(members(CLASSES, sources)).toEqual([nowhere('Box.close'), siblingsOnly('Box.constructor'), nowhere('Box.make'), siblingsOnly('Box.open'), nowhere('Box.size')]);
  });

  it('does not read a name in a comment or a string as a use', () => {
    const sources = { 'apps/shop/a.ts': "// box.open()\nconst text = 'box.close() new Box()';" };
    expect(members(CLASSES, sources)).toEqual(ALL.map(nowhere));
  });

  it('keeps every member of a class that an app, the docs or the kit extends', () => {
    expect(members(CLASSES, { 'apps/shop/a.ts': 'class Mine extends Box {}' })).toEqual([]);
    expect(members(CLASSES, { 'docs/a.md': '```ts\nclass Mine extends Box {}\n```' })).toEqual([]);
    expect(members(CLASSES, { 'packages/other/src/a.ts': 'class Mine extends Box {}' })).toHaveLength(5);
  });

  it('never checks error classes, abstract classes, hidden members and implicit names', () => {
    const declaration = [
      'export declare class FooError extends Error {',
      '    constructor(message: string);',
      '    detail(): void;',
      '}',
      'export declare class Failure extends FooError {',
      '    reason(): void;',
      '}',
      'export declare abstract class Base {',
      '    run(): void;',
      '}',
      'export declare class Box {',
      '    #private;',
      '    private hidden;',
      '    protected guarded(): void;',
      '    /** @internal */',
      '    plumbing(): void;',
      '    /** @experimental */',
      '    trial(): void;',
      '    [Symbol.iterator](): Iterator<number>;',
      '    toString(): string;',
      '    toJSON(): unknown;',
      '    valueOf(): number;',
      '    then(): void;',
      '}',
      '',
    ].join('\n');
    expect(members(declaration)).toEqual([]);
  });

  it('checks a class once, under the first entry that exports it', () => {
    const { root, dir, manifest } = demo({ 'index.d.ts': "export * from './box.js';\n", 'box.d.ts': CLASSES, 'other.d.ts': "export { Box as Crate } from './box.js';\n" }, { '.': 'index.d.ts', './other': 'other.d.ts' });
    const problems = memberProblems([{ name: '@marmeon/demo', dir, manifest }], root, () => [], NO_MEMBERS);
    expect(problems).toHaveLength(5);
    expect(problems.every((problem) => problem.startsWith('@marmeon/demo Box.'))).toBe(true);
  });

  it('suppresses a member, a class or an entry that stands in a list', () => {
    expect(members(CLASSES, own, { exceptions: { '@marmeon/demo Box.open': 'x', '@marmeon/demo Box.close': 'y' } })).toEqual(['Box.constructor', 'Box.make', 'Box.size'].map(nowhere));
    expect(members(CLASSES, own, { exceptions: { '@marmeon/demo Box.*': 'a base class' } })).toEqual([]);
    expect(members(CLASSES, own, { exceptions: { '@marmeon/demo *': 'the contract of an adapter' } })).toEqual([]);
  });

  it('names a listed line that matches nothing any more', () => {
    const sources = { 'docs/box.md': '`box.open()` `box.close()` `box.size` `Box.make()` `new Box()`' };
    expect(members(CLASSES, sources, { exceptions: { '@marmeon/demo Gone.*': 'y', '@marmeon/demo Box.open': 'x' } })).toEqual([
      '@marmeon/demo Gone.* is listed in MEMBER_EXCEPTIONS but follows the rule — delete the line',
      '@marmeon/demo Box.open is listed in MEMBER_EXCEPTIONS but follows the rule — delete the line',
    ]);
  });

  it('counts a bare code span or a table cell in the docs as a use', () => {
    const sources = { 'docs/box.md': '| Method | |\n| `open(key)` | opens |\n\nUse `close(...keys)` or `size`.\n\n`make<T>()` and `new Box<T>()`\n' };
    expect(members(CLASSES, sources)).toEqual([]);
  });

  it('counts a call inside the `${…}` of a template literal', () => {
    const sources = { 'apps/shop/a.ts': 'const text = `${box.open()} and ${`${box.close()}`}`;\nbox.size; Box.make(); new Box();' };
    expect(members(CLASSES, sources)).toEqual([]);
  });

  it('skips a member that a base class or an interface declares', () => {
    const declaration = [
      'export interface Provider {',
      '    boot(): void;',
      '}',
      'export declare class Base implements Provider {',
      '    boot(): void;',
      '    shared(): void;',
      '}',
      'export declare class Box extends Base {',
      '    boot(): void;',
      '    shared(): void;',
      '    own(): void;',
      '}',
      'export declare class Plugin implements Provider {',
      '    boot(): void;',
      '}',
      '',
    ].join('\n');
    expect(members(declaration)).toEqual([nowhere('Base.shared'), nowhere('Box.own')]);
    // A base that no entry exports is no contract an app can see.
    expect(members(declaration.replace('export declare class Base', 'declare class Base'))).toEqual([nowhere('Box.boot'), nowhere('Box.own'), nowhere('Box.shared')]);
  });

  it('does not look for a key that is no identifier', () => {
    const declaration = "export declare class Box {\n    readonly '~standard': number;\n    open(): void;\n}\n";
    expect(members(declaration, { 'apps/shop/a.ts': 'box["~standard"];' })).toEqual([nowhere('Box.open')]);
  });

  it('counts the launchers of a package, not its test helpers', () => {
    expect(members(CLASSES, { 'packages/other/bin/run.ts': 'box.open();' })).toContain(siblingsOnly('Box.open'));
    expect(members(CLASSES, { 'packages/other/src/test-helpers/a.ts': 'box.open();' })).toContain(nowhere('Box.open'));
  });

  it('gives usage per file group and a status', () => {
    const { root, dir, manifest } = demo({ 'index.d.ts': CLASSES });
    const files = [
      { path: 'docs/a.md', text: '`box.open()`' },
      { path: 'apps/shop/a.ts', text: 'box.close();' },
      { path: 'packages/other/src/a.ts', text: 'box.size;' },
    ];
    const usage = memberUsage([{ name: '@marmeon/demo', dir, manifest }], root, files);
    const by = Object.fromEntries(usage.map((item) => [item.member, item]));
    expect(by.open!.docs).toEqual(['docs/a.md']);
    expect(by.close!.apps).toEqual(['apps/shop/a.ts']);
    expect(by.size!.siblings).toEqual(['packages/other/src/a.ts']);
    expect(usage.map((item) => [item.member, memberStatus(item)])).toEqual([
      ['close', 'used'],
      ['constructor', 'unused'],
      ['make', 'unused'],
      ['open', 'used'],
      ['size', 'framework only'],
    ]);
  });

  it('reports the problems through api:check with a line of their own', async () => {
    const { root } = demo({ 'index.d.ts': CLASSES });
    const run = await runApi(root, { allowed: {}, files: [] });
    expect(run.lines).toContain('members:');
  });
});
