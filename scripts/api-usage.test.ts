import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importsOf, knownEntries, mentionsOf, main, renderUsage, usageOf } from './api-usage.ts';
import { renderSnapshot, type ApiItem } from './api-snapshot.ts';
import type { SourceFile } from './source-files.ts';
import { tempDir } from './test/temp-dir.js';

const item = (entry: string, name: string, text = `export declare const ${name}: 1;`): ApiItem => ({ entry, section: 'stable', name, text });

/** A repository with `@marmeon/demo` (names `used`, `docs`, `neighbour`, `MailFake`, `unused`) and `@marmeon/other`, which re-exports `shared`. */
function repository() {
  const root = tempDir('marmeon-api-usage-');
  const write = (directory: string, items: ApiItem[]) => {
    mkdirSync(join(root, 'packages', directory), { recursive: true });
    writeFileSync(join(root, 'packages', directory, 'package.json'), JSON.stringify({ name: `@marmeon/${directory}` }));
    writeFileSync(join(root, 'packages', directory, 'api.md'), renderSnapshot(`@marmeon/${directory}`, items, new Map()));
  };
  write('demo', ['used', 'docs', 'neighbour', 'MailFake', 'unused', 'shared', 'twoFactorCode', 'createApplication', 'useBlocker', 'Key'].map((name) => item('@marmeon/demo', name)));
  write('other', [item('@marmeon/other', 'shared', "export { shared as shared } from '@marmeon/demo';"), item('@marmeon/other', 'shared2', "export { shared } from '@marmeon/demo';")]);
  return root;
}
const file = (path: string, text: string): SourceFile => ({ path, text });

describe('the imports of a file', () => {
  it('reads named, renamed, type and multi-line imports, and re-exports', () => {
    const text = [
      "import { a, type B, c as d } from '@marmeon/demo';",
      'import {',
      '  e,',
      '  f as g,',
      "} from '@marmeon/demo';",
      "import type { H } from '@marmeon/demo/page';",
      "export { i } from '@marmeon/demo';",
    ].join('\n');
    expect(importsOf(text)).toEqual([
      { specifier: '@marmeon/demo', names: ['a', 'B', 'c'] },
      { specifier: '@marmeon/demo', names: ['e', 'f'] },
      { specifier: '@marmeon/demo/page', names: ['H'] },
      { specifier: '@marmeon/demo', names: ['i'] },
    ]);
  });

  it('knows a default import, a namespace import and a dynamic import', () => {
    expect(importsOf("import x, { y } from 'm';")).toEqual([{ specifier: 'm', names: ['y', 'default'] }]);
    expect(importsOf("import * as ns from 'm'; export * from 'n'; await import('o');")).toEqual([
      { specifier: 'm', names: undefined, namespace: 'ns' },
      { specifier: 'n', names: undefined },
      { specifier: 'o', names: undefined },
    ]);
    expect(importsOf("const x = (await import('m')).y; type T = import('m').Foo;")).toContainEqual({ specifier: 'm', names: ['Foo'] });
  });

  it('reads a destructured dynamic import and require as named imports', () => {
    const text = [
      "const { a, b: renamed, c = 1 } = await import('m');",
      "const { d } = require('m');",
      "let { ...all } = await import('m');",
      "const { a, ...others } = require('m');",
      "const { ['b']: x } = await import('m');",
      "const lib = require('n'); const e = require('o').Foo;",
    ].join('\n');
    expect(importsOf(text)).toEqual([
      { specifier: 'm', names: ['a', 'b', 'c'] },
      { specifier: 'm', names: ['d'] },
      { specifier: 'm', names: undefined },
      { specifier: 'm', names: undefined },
      { specifier: 'm', names: undefined },
      { specifier: 'n', names: undefined, namespace: 'lib' },
      { specifier: 'o', names: ['Foo'] },
    ]);
  });

  it('does not take prose or other code for an import', () => {
    expect(importsOf('We import data from the server; export const x = 1;\nreturn value from y;')).toEqual([]);
  });
});

describe('who imports an export', () => {
  const files = [
    file('docs/demo.md', "```ts\nimport { docs } from '@marmeon/demo';\n```"),
    file('packages/other/src/index.ts', "import { neighbour, shared } from '@marmeon/demo';"),
    file('apps/web-app/modules/a/a.test.ts', "import { MailFake, twoFactorCode } from '@marmeon/demo';"),
    file('apps/web-app/modules/a/a.ts', "import {\n  used as renamed,\n} from '@marmeon/demo';"),
    // The package's own code and tests do not count.
    file('packages/demo/src/index.ts', "import { unused } from '@marmeon/demo';"),
    file('packages/demo/src/index.test.ts', "import { unused } from '@marmeon/demo';"),
    // Another entry of the package is another specifier.
    file('apps/web-app/b.ts', "import { unused } from '@marmeon/demo/page';"),
  ];

  it('suggests keep for docs and apps, testing for a fake, internal for a neighbour and drop for nobody', () => {
    const usage = usageOf('@marmeon/demo', repository(), files)!;
    const by = (name: string) => usage.names.find((entry) => entry.name === name)!;
    expect(by('docs')).toMatchObject({ suggestion: 'keep', docs: ['docs/demo.md'] });
    expect(by('used')).toMatchObject({ suggestion: 'keep', apps: ['apps/web-app/modules/a/a.ts'] });
    expect(by('MailFake')).toMatchObject({ suggestion: 'testing', tests: ['apps/web-app/modules/a/a.test.ts'] });
    expect(by('neighbour')).toMatchObject({ suggestion: 'internal', siblings: { other: ['packages/other/src/index.ts'] } });
    expect(by('unused')).toMatchObject({ suggestion: 'drop', docs: [], apps: [], tests: [] });
  });

  it('sends a double that only @marmeon/testing uses to testing, but not one another package uses', () => {
    const only = usageOf('@marmeon/demo', repository(), [file('packages/testing/src/app.ts', "import { MailFake } from '@marmeon/demo';")])!;
    expect(only.names.find((entry) => entry.name === 'MailFake')).toMatchObject({ suggestion: 'testing' });
    const shared = usageOf('@marmeon/demo', repository(), [
      file('packages/testing/src/app.ts', "import { MailFake } from '@marmeon/demo';"),
      file('packages/other/src/a.ts', "import { MailFake } from '@marmeon/demo';"),
    ])!;
    expect(shared.names.find((entry) => entry.name === 'MailFake')).toMatchObject({ suggestion: 'internal' });
  });

  it('does not count an import in the package itself', () => {
    const usage = usageOf('@marmeon/demo', repository(), files)!;
    expect(usage.names.find((entry) => entry.name === 'unused')).toMatchObject({ suggestion: 'drop', siblings: {}, tests: [] });
  });

  it('keeps a name another public entry re-exports, and leaves a test helper with a plain name to the reader', () => {
    const usage = usageOf('@marmeon/demo', repository(), files)!;
    expect(usage.names.find((entry) => entry.name === 'shared')).toMatchObject({ suggestion: 'keep', reexportedBy: ['@marmeon/other'] });
    const alone = usageOf('@marmeon/demo', repository(), [files[2]!])!;
    expect(alone.names.find((entry) => entry.name === 'shared')).toMatchObject({ suggestion: 'keep', reexportedBy: ['@marmeon/other'] });
    expect(alone.names.find((entry) => entry.name === 'twoFactorCode')).toMatchObject({ suggestion: 'keep' });
  });

  it('counts the package\'s stubs and README, which an app copies and reads', () => {
    const usage = usageOf('@marmeon/demo', repository(), [
      file('packages/demo/stubs/layout.tsx', "import { used } from '@marmeon/demo';"),
      file('packages/demo/README.md', "```ts\nimport { docs } from '@marmeon/demo';\n```"),
    ])!;
    expect(usage.names.find((entry) => entry.name === 'used')).toMatchObject({ suggestion: 'keep', kit: ['packages/demo/stubs/layout.tsx'] });
    expect(usage.names.find((entry) => entry.name === 'docs')).toMatchObject({ suggestion: 'keep', docs: ['packages/demo/README.md'] });
  });

  it('lists the files that import the entry as a whole', () => {
    const usage = usageOf('@marmeon/demo', repository(), [file('apps/web-app/c.ts', "import * as demo from '@marmeon/demo';")])!;
    expect(usage.wholeImports).toEqual(['apps/web-app/c.ts']);
  });

  it('lists an experimental export, but not an experimental member of a declaration', () => {
    const root = repository();
    const experimental = (name: string): ApiItem => ({ entry: '@marmeon/demo', section: 'experimental', name, text: 'x' });
    mkdirSync(join(root, 'packages/solo'), { recursive: true });
    writeFileSync(join(root, 'packages/solo/api.md'), renderSnapshot('@marmeon/solo', [experimental('Probe'), experimental('Options.pages')].map((entry) => ({ ...entry, entry: '@marmeon/solo' })), new Map()));
    expect(usageOf('@marmeon/solo', root, [])!.names.map((entry) => entry.name)).toEqual(['Probe']);
  });

  it('does not count a package-wide experimental item as an export', () => {
    const root = repository();
    const wide: ApiItem = { entry: '', section: 'experimental', name: 'used', text: "export { used } from '@marmeon/demo';" };
    mkdirSync(join(root, 'packages/wide'), { recursive: true });
    writeFileSync(join(root, 'packages/wide/api.md'), renderSnapshot('@marmeon/wide', [item('@marmeon/wide', 'Own'), wide], new Map()));
    expect(usageOf('@marmeon/demo', root, files)!.names.find((entry) => entry.name === 'used')).toMatchObject({ reexportedBy: [] });
    expect(usageOf('@marmeon/wide', root, [])!.names.map((entry) => entry.name)).toEqual(['Own']);
  });

  it('answers undefined for an entry no api.md lists, and lists the ones that exist', () => {
    const root = repository();
    expect(usageOf('@marmeon/nope', root, [])).toBeUndefined();
    expect(knownEntries(root)).toEqual(['@marmeon/demo', '@marmeon/other']);
  });

  it('renders a section per suggestion with the counts', () => {
    const text = renderUsage(usageOf('@marmeon/demo', repository(), files)!);
    expect(text).toContain('@marmeon/demo: 10 names (');
    expect(text).toMatch(/keep \(\d+\)\n {2}docs {2}— docs 1/);
    expect(text).toContain('MailFake  — tests 1');
  });
});

describe('names the docs mention without importing them', () => {
  const prose = 'Call `createApplication(definition)` once. A Key in prose is no import, and the `Key` span alone is.\n```tsx\nconst b = useBlocker({ when });\n```\n';

  it('finds a call in inline code and in a block, but not a bare word', () => {
    const known = new Set(['createApplication', 'useBlocker', 'Key', 'when']);
    expect([...mentionsOf(prose.replace('`Key` span', 'span'), known)].sort()).toEqual(['createApplication', 'useBlocker']);
    expect(mentionsOf('Pass a Key to it.', known).size).toBe(0);
    expect(mentionsOf('class A extends Key {}', known).size).toBe(0);
    expect([...mentionsOf('```ts\nclass A extends Key {}\n```', known)]).toEqual(['Key']);
    expect(mentionsOf('`x.createApplication(1)`', known).size).toBe(0);
  });

  it('suggests keep for them', () => {
    const usage = usageOf('@marmeon/demo', repository(), [file('docs/modules.md', prose)])!;
    const by = (name: string) => usage.names.find((entry) => entry.name === name)!;
    expect(by('createApplication')).toMatchObject({ suggestion: 'keep', mentioned: ['docs/modules.md'], docs: [] });
    expect(by('useBlocker')).toMatchObject({ suggestion: 'keep' });
  });
});

describe('which mentions count', () => {
  const known = new Set(['Translator', 'compose', 'teamId', 'uploads']);

  it('skips paths, file names and placeholders', () => {
    expect(mentionsOf('`/_marmeon/uploads` `deploy/website/compose.yaml` `/teams/${accepted.error.teamId}` `compose.yaml` `my-compose(1)`', known).size).toBe(0);
    expect([...mentionsOf('`compose(1)`', known)]).toEqual(['compose']);
  });

  it('finds a name anywhere in inline code, and pairs backtick runs as CommonMark does', () => {
    const names = new Set(['LogConfig', 'MarmeonApp', 'SessionConfig', 'fromHtml', 'html', 'Key']);
    expect([...mentionsOf("`LogConfig`, `<MarmeonApp>` and `SessionConfig.resolve`", names)].sort()).toEqual(['LogConfig', 'MarmeonApp', 'SessionConfig']);
    expect([...mentionsOf('Write `` html`…` `` or `fromHtml(x)`.', names)].sort()).toEqual(['fromHtml', 'html']);
    expect(mentionsOf('Use a Key here, which is no code.', names).size).toBe(0);
    expect([...mentionsOf('```tsx\nreturn <MarmeonApp />;\n```', names)]).toEqual(['MarmeonApp']);
  });

  it('does not count a name the page imports from another specifier', () => {
    const page = "```ts\nimport { unused } from '@marmeon/other';\n```\nUse `unused` here.";
    const usage = usageOf('@marmeon/demo', repository(), [file('docs/mail.md', page)])!;
    expect(usage.names.find((entry) => entry.name === 'unused')).toMatchObject({ mentioned: [], suggestion: 'drop' });
  });

  it('names the other entries that export a mentioned name', () => {
    const usage = usageOf('@marmeon/demo', repository(), [file('docs/a.md', 'Call `shared()`.')])!;
    expect(usage.names.find((entry) => entry.name === 'shared')!.reason).toContain('also exported by @marmeon/other');
  });
});

describe('which words of a page are a use', () => {
  const known = new Set(['run', 'Output', 'PageObject', 'new']);

  it('counts inline code that starts like a use, and no word of prose or of a sentence in code', () => {
    expect(mentionsOf('We run the tests. The Output is long.', known).size).toBe(0);
    expect(mentionsOf('`run the tests` and `see Output here`', known).size).toBe(0);
    expect([...mentionsOf('`run()`', known)]).toEqual(['run']);
    expect([...mentionsOf('`new PageObject(page)` and `Output<T>`', known)].sort()).toEqual(['Output', 'PageObject']);
    expect([...mentionsOf('`<Output>`', known)]).toEqual(['Output']);
  });
});

describe('public declarations that name an export', () => {
  /** `@marmeon/demo` with the entries `.` and `/page`, and `@marmeon/other`; the names `Route`, `Handler` and `PageObject` of `.` are used by nobody. */
  function snapshots(entries: ApiItem[]) {
    const root = tempDir('marmeon-api-usage-');
    for (const [directory, items] of [['demo', entries.filter((entry) => entry.entry.startsWith('@marmeon/demo'))], ['other', entries.filter((entry) => entry.entry === '@marmeon/other')]] as const) {
      if (items.length === 0) continue;
      mkdirSync(join(root, 'packages', directory), { recursive: true });
      writeFileSync(join(root, 'packages', directory, 'api.md'), renderSnapshot(`@marmeon/${directory}`, items, new Map()));
    }
    return root;
  }
  const base = [item('@marmeon/demo', 'Route'), item('@marmeon/demo', 'Handler'), item('@marmeon/demo', 'PageObject')];

  it('keeps a name that a stable declaration of another entry or package names', () => {
    const root = snapshots([
      ...base,
      item('@marmeon/demo/page', 'check', 'export declare function check(route: Route): void;'),
      item('@marmeon/other', 'Mount', 'export declare class Mount { handle(h: Handler): void }'),
    ]);
    const usage = usageOf('@marmeon/demo', root, [])!;
    const by = (name: string) => usage.names.find((entry) => entry.name === name)!;
    expect(by('Route')).toMatchObject({ suggestion: 'keep', namedBy: ['@marmeon/demo/page check'] });
    expect(by('Route').reason).toContain('named by a public declaration of @marmeon/demo/page');
    expect(by('Handler')).toMatchObject({ suggestion: 'keep', namedBy: ['@marmeon/other Mount'] });
    expect(by('PageObject')).toMatchObject({ suggestion: 'drop', namedBy: [] });
    expect(renderUsage(usage)).toContain('Route  — named by @marmeon/demo/page check');
  });

  it('keeps a name that only an experimental option of another entry names', () => {
    const root = snapshots([
      ...base,
      item('@marmeon/demo/page', 'Options', 'export interface Options {\n    path: string;\n}'),
      { entry: '@marmeon/demo/page', section: 'experimental', name: 'Options.server', text: 'server?: Handler;' },
    ]);
    const handler = usageOf('@marmeon/demo', root, [])!.names.find((entry) => entry.name === 'Handler')!;
    expect(handler).toMatchObject({ suggestion: 'keep', namedBy: ['@marmeon/demo/page Options.server (experimental)'] });
    expect(handler.reason).toContain('named by a public declaration of @marmeon/demo/page');
  });

  it('counts a Referenced item and an Experimental one, but not the middle of a word or a member', () => {
    const root = snapshots([
      ...base,
      { entry: '@marmeon/demo/page', section: 'referenced', name: 'Hidden', text: 'export interface Hidden { r: Route }' },
      { entry: '@marmeon/demo/page', section: 'experimental', name: 'Trial', text: 'export declare const Trial: Handler;' },
      item('@marmeon/demo/page', 'PageObjectLike', 'export declare const PageObjectLike: { PageObject: 1; x: Other.PageObject };'),
    ]);
    const usage = usageOf('@marmeon/demo', root, [])!;
    const by = (name: string) => usage.names.find((entry) => entry.name === name)!;
    expect(by('Route').namedBy).toEqual(['@marmeon/demo/page Hidden']);
    expect(by('Handler').namedBy).toEqual(['@marmeon/demo/page Trial']);
    expect(by('PageObject').namedBy).toEqual([]);
  });

  it('does not count property keys, method or parameter names, string literals or comment lines', () => {
    const root = snapshots([
      ...base,
      item('@marmeon/demo/page', 'Keys', 'export interface Keys { Route: 1; Handler?: 2 }'),
      item('@marmeon/demo/page', 'Methods', 'export interface Methods { Route(x: 1): void; PageObject?(): void }'),
      item('@marmeon/demo/page', 'param', 'export declare function param(Route: 1, Handler?: 2): void;'),
      item('@marmeon/demo/page', 'LABEL', 'export declare const LABEL: "layers/Route" | \'Handler\' | `PageObject`;'),
      item('@marmeon/demo/page', 'Commented', 'export interface Commented {\n  // Route Handler PageObject\n  x: 1;\n}'),
    ]);
    const usage = usageOf('@marmeon/demo', root, [])!;
    for (const name of ['Route', 'Handler', 'PageObject']) expect(usage.names.find((entry) => entry.name === name)!.namedBy, name).toEqual([]);
  });

  it('counts the placeholders of a template literal type, but not its text', () => {
    const root = snapshots([
      ...base,
      item('@marmeon/demo/page', 'Join', 'export type Join<T> = `Handler/${Route<T>}/${`PageObject-${Handler}`}`;'),
    ]);
    const by = (name: string) => usageOf('@marmeon/demo', root, [])!.names.find((entry) => entry.name === name)!;
    expect(by('Route').namedBy).toEqual(['@marmeon/demo/page Join']);
    expect(by('Handler').namedBy).toEqual(['@marmeon/demo/page Join']);
    expect(by('PageObject').namedBy).toEqual([]);
  });

  it('counts a qualified import type of the entry, and none of another specifier', () => {
    const root = snapshots([
      ...base,
      item('@marmeon/other', 'Mount', 'export declare const Mount: import("@marmeon/demo").Route;'),
      item('@marmeon/other', 'Other', 'export declare const Other: import("@marmeon/demo/page").Handler;'),
    ]);
    const by = (name: string) => usageOf('@marmeon/demo', root, [])!.names.find((entry) => entry.name === name)!;
    expect(by('Route')).toMatchObject({ suggestion: 'keep', namedBy: ['@marmeon/other Mount'] });
    expect(by('Handler').namedBy).toEqual([]);
  });

  it('only hints when the entry itself names the export', () => {
    const root = snapshots([...base, item('@marmeon/demo', 'check', 'export declare function check(route: Route): void;')]);
    const route = usageOf('@marmeon/demo', root, [])!.names.find((entry) => entry.name === 'Route')!;
    expect(route).toMatchObject({ suggestion: 'drop', namedBy: [], namedHere: ['check'] });
    expect(route.reason).toContain('named by check — would show as Referenced');
    expect(renderUsage(usageOf('@marmeon/demo', root, [])!)).toContain('named here by check — would show as Referenced');
  });
});

describe('namespace imports', () => {
  const run = (text: string) => {
    const usage = usageOf('@marmeon/demo', repository(), [file('apps/web-app/c.ts', text)])!;
    return { usage, by: (name: string) => usage.names.find((entry) => entry.name === name)! };
  };

  it('reads the members of a dynamic import kept in a constant', () => {
    const { usage, by } = run("const m = await import('@marmeon/demo');\nm.used();");
    expect(by('used')).toMatchObject({ suggestion: 'keep', apps: ['apps/web-app/c.ts'] });
    expect(usage.wholeImports).toEqual([]);
  });

  it('reads the members of import * as and the names of a destructuring', () => {
    const { usage, by } = run("import * as demo from '@marmeon/demo';\nconst { docs, neighbour: n } = demo;\ntype T = demo.Key; demo?.used();");
    expect(['docs', 'neighbour', 'Key', 'used'].map((name) => by(name).suggestion)).toEqual(['keep', 'keep', 'keep', 'keep']);
    expect(usage.wholeImports).toEqual([]);
  });

  it('still counts the entry as a whole when the namespace is passed on, spread or indexed', () => {
    for (const use of ['register(m);', 'const copy = { ...m };', 'm[key]();', 'const { a, ...rest } = m;', 'export { m };']) {
      const { usage } = run(`const m = await import('@marmeon/demo');\nm.used();\n${use}`);
      expect(usage.wholeImports, use).toEqual(['apps/web-app/c.ts']);
    }
  });

  it('keeps export * as a whole import', () => {
    expect(run("export * as demo from '@marmeon/demo';").usage.wholeImports).toEqual(['apps/web-app/c.ts']);
  });
});

describe('test doubles', () => {
  it('goes to testing for a documented double that @marmeon/testing imports', () => {
    const usage = usageOf('@marmeon/demo', repository(), [file('docs/a.md', 'Call `MailFake()`.'), file('packages/testing/src/a.ts', "import { MailFake } from '@marmeon/demo';")])!;
    expect(usage.names.find((entry) => entry.name === 'MailFake')).toMatchObject({ suggestion: 'testing' });
  });

  it('suggests no testing inside the testing package itself', () => {
    const root = tempDir('marmeon-api-usage-');
    mkdirSync(join(root, 'packages/testing'), { recursive: true });
    writeFileSync(join(root, 'packages/testing/api.md'), renderSnapshot('@marmeon/testing', [item('@marmeon/testing', 'TestResponse')], new Map()));
    const usage = usageOf('@marmeon/testing', root, [file('apps/web-app/a.test.ts', "import { TestResponse } from '@marmeon/testing';")])!;
    expect(usage.names[0]).toMatchObject({ suggestion: 'keep' });
  });
});

describe('what the suggestions leave out', () => {
  it('ignores the repository\'s scripts and counts UPGRADING as docs', () => {
    const usage = usageOf('@marmeon/demo', repository(), [
      file('scripts/x.test.ts', "import { unused } from '@marmeon/demo';"),
      file('UPGRADING.md', "```ts\nimport { docs } from '@marmeon/demo';\n```"),
    ])!;
    expect(usage.names.find((entry) => entry.name === 'unused')).toMatchObject({ suggestion: 'drop', tests: [] });
    expect(usage.names.find((entry) => entry.name === 'docs')).toMatchObject({ suggestion: 'keep', docs: ['UPGRADING.md'] });
  });

  it('counts the bin/ launcher of another package as a keep, in plain JavaScript too', () => {
    const usage = usageOf('@marmeon/demo', repository(), [
      file('packages/other/bin/x.js', "import { neighbour } from '@marmeon/demo';"),
      file('packages/other/bin/y.mjs', "const { used } = await import('@marmeon/demo');"),
      file('packages/other/bin/z.cjs', "const { MailFake } = require('@marmeon/demo');"),
      file('packages/demo/bin/own.js', "import { unused } from '@marmeon/demo';"),
    ])!;
    const find = (name: string) => usage.names.find((entry) => entry.name === name);
    expect(find('neighbour')).toMatchObject({ suggestion: 'keep', launchers: { other: ['packages/other/bin/x.js'] }, siblings: {} });
    expect(find('neighbour')!.reason).toContain('check:source');
    expect(find('used')).toMatchObject({ suggestion: 'keep', launchers: { other: ['packages/other/bin/y.mjs'] } });
    expect(find('MailFake')!.launchers).toEqual({ other: ['packages/other/bin/z.cjs'] });
    expect(find('unused')).toMatchObject({ suggestion: 'drop' });
  });

  it('leaves out build output and installed packages', () => {
    const usage = usageOf('@marmeon/demo', repository(), [
      file('packages/other/dist/index.js', "import { unused } from '@marmeon/demo';"),
      file('apps/web-app/node_modules/x/index.js', "import { unused } from '@marmeon/demo';"),
      file('apps/web-app/dist/server.js', "import { unused } from '@marmeon/demo';"),
    ])!;
    expect(usage.names.find((entry) => entry.name === 'unused')).toMatchObject({ suggestion: 'drop', apps: [], siblings: {} });
  });

  it('warns on drop and internal while an app imports the entry as a whole', () => {
    const usage = usageOf('@marmeon/demo', repository(), [file('apps/web-app/c.ts', "export * from '@marmeon/demo';")])!;
    expect(usage.names.find((entry) => entry.name === 'unused')!.reason).toContain('imported as a whole by apps/web-app/c.ts');
  });
});

describe('the command', () => {
  it('needs exactly one entry', () => {
    expect(main([])).toBe(2);
    expect(main(['--nope'])).toBe(2);
  });

  it('refuses an entry no api.md lists', () => {
    expect(main(['@marmeon/nope'])).toBe(1);
  });
});
