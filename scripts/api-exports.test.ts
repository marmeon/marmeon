import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPORT_EXCEPTIONS, EXPORT_PENDING, exportProblems, type ExportLists } from './api-exports.ts';
import { renderSnapshot, type ApiItem } from './api-snapshot.ts';
import type { SourceFile } from './source-files.ts';
import { tempDir } from './test/temp-dir.js';

const ENTRY = '@marmeon/demo';
const NONE: ExportLists = { exceptions: {}, pending: {} };
const item = (name: string, text: string, section: ApiItem['section'] = 'stable'): ApiItem => ({ entry: ENTRY, section, name, text });
const fn = (name: string) => item(name, `export declare function ${name}(): void;`);
const constant = (name: string) => item(name, `export declare const ${name}: 1;`);

/** `@marmeon/demo` with the given items, next to `@marmeon/other`, a second framework package. */
function repository(items: ApiItem[]) {
  const root = tempDir('marmeon-api-exports-');
  for (const [directory, list] of [['demo', items], ['other', []]] as const) {
    mkdirSync(join(root, 'packages', directory), { recursive: true });
    writeFileSync(join(root, 'packages', directory, 'package.json'), JSON.stringify({ name: `@marmeon/${directory}` }));
    writeFileSync(join(root, 'packages', directory, 'api.md'), renderSnapshot(`@marmeon/${directory}`, list, new Map()));
  }
  return root;
}
const file = (path: string, text: string): SourceFile => ({ path, text });
const problems = (items: ApiItem[], files: SourceFile[] = [], lists: ExportLists = NONE) => exportProblems(repository(items), files, lists);
const nowhere = (name: string) => `${ENTRY} ${name} is used nowhere outside the framework (docs, apps, the kit) — mark it @internal, stop exporting it, or list it in EXPORT_EXCEPTIONS with the reason an app needs it; see \`pnpm api:usage ${ENTRY} --files\``;
const frameworkOnly = (name: string) => `${ENTRY} ${name} is used only by other framework packages — mark it @internal (they may still call it), or list it in EXPORT_EXCEPTIONS with the reason an app needs it; see \`pnpm api:usage ${ENTRY} --files\``;

describe('exports only the framework uses', () => {
  it('reports a function that only its own package uses', () => {
    const own = file('packages/demo/src/a.ts', `import { helper } from '${ENTRY}';`);
    expect(problems([fn('helper')], [own])).toEqual([nowhere('helper')]);
  });

  it('reports a constant that only the launcher of another package imports', () => {
    const launcher = file('packages/other/bin/run.ts', `import { LIMIT } from '${ENTRY}';`);
    expect(problems([constant('LIMIT')], [launcher])).toEqual([frameworkOnly('LIMIT')]);
  });

  it('reports a function that only the code of another package imports', () => {
    const sibling = file('packages/other/src/a.ts', `import { helper } from '${ENTRY}';`);
    expect(problems([fn('helper')], [sibling])).toEqual([frameworkOnly('helper')]);
  });

  it('counts an import by an app, the kit or a docs page, and inline code in the docs', () => {
    const items = [fn('byApp'), fn('byKit'), fn('byImport'), fn('inProse')];
    const files = [
      file('apps/web-app/src/a.ts', `import { byApp } from '${ENTRY}';`),
      file('packages/other/stubs/a.ts', `import { byKit } from '${ENTRY}';`),
      file('docs/a.md', `\`\`\`ts\nimport { byImport } from '${ENTRY}';\n\`\`\``),
      file('docs/b.md', 'Call `inProse()` before the response.'),
    ];
    expect(problems(items, files)).toEqual([]);
  });

  it('counts a use through an entry that re-exports the name', () => {
    const root = repository([fn('f')]);
    mkdirSync(join(root, 'packages/other'), { recursive: true });
    writeFileSync(join(root, 'packages/other/api.md'), renderSnapshot('@marmeon/other', [{ entry: '@marmeon/other', section: 'stable', name: 'f', text: `export { f } from '${ENTRY}';` }, { entry: '@marmeon/other', section: 'stable', name: 'g', text: 'export declare function g(): void;' }], new Map()));
    const page = file('docs/a.md', "```ts\nimport { f } from '@marmeon/other';\n```");
    expect(exportProblems(root, [page], { exceptions: {}, pending: { '@marmeon/other g': 'reason' } })).toEqual([]);
    expect(exportProblems(root, [], NONE)).toEqual([nowhere('f'), '@marmeon/other g is used nowhere outside the framework (docs, apps, the kit) — mark it @internal, stop exporting it, or list it in EXPORT_EXCEPTIONS with the reason an app needs it; see `pnpm api:usage @marmeon/other --files`']);
  });

  it('counts the tests of an app and of the starter, not the tests of a package', () => {
    const items = [fn('byApp'), fn('byTemplate'), fn('byPackage')];
    const files = [
      file('apps/web-app/src/a.test.ts', `import { byApp } from '${ENTRY}';`),
      file('packages/other/stubs/a.test.ts', `import { byTemplate } from '${ENTRY}';`),
      file('packages/other/src/a.test.ts', `import { byPackage } from '${ENTRY}';`),
    ];
    expect(problems(items, files)).toEqual([nowhere('byPackage')]);
  });

  it('checks an enum like a constant', () => {
    expect(problems([item('Mode', 'export declare enum Mode {\n}'), item('Kind', '// type-only\nexport declare const Kind: 1;')])).toEqual([nowhere('Kind'), nowhere('Mode')]);
  });

  it('reports an orphan type and leaves one alone that a public declaration names', () => {
    const items = [
      item('Orphan', 'export interface Orphan {\n    a: 1;\n}'),
      item('Named', 'export interface Named {\n    a: 1;\n}'),
      item('make', 'export declare function make(): Named;'),
    ];
    const files = [file('docs/a.md', '`make()`')];
    expect(problems(items, files)).toEqual([nowhere('Orphan')]);
  });

  it('never checks an error, a config, a service provider, a class, a re-export or an experimental export', () => {
    const items = [
      constant('FooError'),
      constant('FooConfig'),
      constant('FooServiceProvider'),
      item('Widget', 'export declare class Widget {\n}'),
      item('moved', "export { moved } from '@marmeon/other';"),
      item('trial', 'export declare function trial(): void;', 'experimental'),
    ];
    expect(problems(items)).toEqual([]);
  });

  it('suppresses a listed export, and `<entry> *` every export of an entry', () => {
    const items = [fn('a'), fn('b')];
    expect(problems(items, [], { exceptions: { [`${ENTRY} a`]: 'reason' }, pending: {} })).toEqual([nowhere('b')]);
    expect(problems(items, [], { exceptions: {}, pending: { [`${ENTRY} b`]: 'reason' } })).toEqual([nowhere('a')]);
    expect(problems(items, [], { exceptions: { [`${ENTRY} *`]: 'reason' }, pending: {} })).toEqual([]);
  });

  it('reports a line of either list that follows the rule', () => {
    const files = [file('apps/web-app/src/a.ts', `import { used } from '${ENTRY}';`)];
    const lists = { exceptions: { [`${ENTRY} used`]: 'reason', [`${ENTRY} gone`]: 'reason' }, pending: { [`${ENTRY} used`]: 'reason', '@marmeon/none *': 'reason' } };
    expect(problems([fn('used')], files, lists)).toEqual([
      `${ENTRY} used is listed in EXPORT_EXCEPTIONS but follows the rule — delete the line`,
      `${ENTRY} gone is listed in EXPORT_EXCEPTIONS but follows the rule — delete the line`,
      `${ENTRY} used is listed in EXPORT_PENDING but follows the rule — delete the line`,
      '@marmeon/none * is listed in EXPORT_PENDING but follows the rule — delete the line',
    ]);
  });
});

describe('the lists', () => {
  it('name an entry and an export, or `*`, and give a reason', () => {
    for (const [line, reason] of [...Object.entries(EXPORT_EXCEPTIONS), ...Object.entries(EXPORT_PENDING)]) {
      expect(line).toMatch(/^@marmeon\/[\w/-]+ (?:\*|[\w$]+)$/);
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});
