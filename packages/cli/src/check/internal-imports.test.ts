import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { INSTALLED_MESSAGE, internalImports } from './internal-imports.ts';

function scan(files: Record<string, string>) {
  const root = tempDir('marmeon-check-');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return internalImports(root);
}

const unreadable: string[] = [];
afterEach(() => {
  for (const path of unreadable.splice(0)) chmodSync(path, 0o755);
});

describe('internalImports', () => {
  it.each([
    ['import', "import { x } from '@marmeon/core/internal';"],
    ['import type', "import type { X } from '@marmeon/core/internal';"],
    ['import of a file inside it', "import { x } from '@marmeon/core/internal/x.js';"],
    ['export *', "export * from '@marmeon/core/internal';"],
    ['named re-export', "export { x } from '@marmeon/core/internal';"],
    ['import()', "const m = await import('@marmeon/http/internal');"],
    ['require', "const m = require('@marmeon/http/internal');"],
    ['import = require', "import m = require('@marmeon/http/internal');"],
    ['type import()', "type T = typeof import('@marmeon/http/internal');"],
    ['vi.mock', "vi.mock('@marmeon/queue/internal');"],
    ['a template without an expression', 'const m = await import(`@marmeon/queue/internal`);'],
    ['the main package', "import { x } from 'marmeon/internal';"],
    ['a package dist', "import { x } from '@marmeon/core/dist/index.js';"],
    ['a package src', "import { x } from '@marmeon/core/src/index.ts';"],
    ['the main package dist', "import { x } from 'marmeon/dist/main.js';"],
    ['a relative path into node_modules', "import { x } from '../node_modules/@marmeon/core/dist/x.js';"],
    ['a pnpm store path', "import { x } from '../node_modules/.pnpm/@marmeon+core@1/node_modules/@marmeon/core/x.js';"],
    ['a path to the main package in node_modules', "import { x } from '../node_modules/marmeon/dist/x.js';"],
    ['a Windows path', "import { x } from '..\\\\node_modules\\\\@marmeon\\\\core\\\\x.js';"],
    ['a file: URL', "const u = new URL('file:///app/node_modules/@marmeon/core/x.js');"],
    ['an escaped letter', "import { x } from '@\\u006darmeon/core/internal';"],
    ['a JSX file', "import { x } from '@marmeon/react/internal';\nexport const a = <div />;"],
  ])('finds %s', (_name, source) => {
    const found = scan({ 'src/a.tsx': source });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', file: 'src/a.tsx', line: 1, rule: 'marmeon(no-internal-imports)' });
  });

  it.each(['a.ts', 'a.mts', 'a.cts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs'])('reads %s', (name) => {
    expect(scan({ [name]: "import '@marmeon/core/internal';" })).toHaveLength(1);
  });

  it('reports the line and column of the string', () => {
    expect(scan({ 'a.ts': "import { y } from 'y';\n\nimport { x } from '@marmeon/core/internal';" })[0]).toMatchObject({ line: 3, column: 19 });
  });

  it('finds tsconfig paths, keys and values, with comments in the file', () => {
    const found = scan({
      'tsconfig.json': '{\n  // comment\n  "compilerOptions": { "paths": { "@x/*": ["@marmeon/core/internal"], "marmeon/internal": ["./a.ts"], }, },\n}',
      'tsconfig.app.json': '{ "compilerOptions": { "paths": { "@x": ["../node_modules/@marmeon/core/dist/x.js"] } } }',
    });
    expect(found.map((problem) => [problem.file, problem.line])).toEqual([
      ['tsconfig.app.json', 1],
      ['tsconfig.json', 3],
      ['tsconfig.json', 3],
    ]);
  });

  it('finds package.json imports, and only those', () => {
    const found = scan({ 'package.json': '{\n  "imports": { "#core": "@marmeon/core/internal" },\n  "scripts": { "x": "@marmeon/core/internal" }\n}' });
    expect(found.map((problem) => [problem.file, problem.line])).toEqual([['package.json', 2]]);
  });

  it('keeps to the imports field of a package.json written on one line', () => {
    const text = '{ "overrides": { "a": "link:../node_modules/@marmeon/core" }, "imports": { "#c": "@marmeon/core/internal" }, "x": "@marmeon/http/internal" }';
    expect(scan({ 'package.json': text })).toHaveLength(1);
  });

  it('has no false alarms', () => {
    expect(
      scan({
        'a.ts': ["import '@marmeon/core/internals';", "import '@marmeon/core';", "import 'marmeon';", "import '@marmeon/core/testing';", "import 'marmeon/internals';", "import '@other/marmeon/internal';"].join('\n'),
        'b.ts': "// import '@marmeon/core/internal'\n/* '@marmeon/core/internal' */\nconst a = `@marmeon/core/${'internal'}`;",
        'node_modules/pkg/index.ts': "import '@marmeon/core/internal';",
        'dist/index.js': "import '@marmeon/core/internal';",
        '.hidden/a.ts': "import '@marmeon/core/internal';",
        'broken.ts': "import '@marmeon/core/internal' ===",
        'notes.md': "import '@marmeon/core/internal'",
        'package.json': '{ "dependencies": { "@marmeon/core": "workspace:*" } }',
      }),
    ).toEqual([]);
  });

  it('catches a query or fragment after the subpath', () => {
    expect(scan({ 'a.ts': "import '@marmeon/core/internal?raw';\nimport '@marmeon/core/dist#x';" })).toHaveLength(2);
  });

  it('reads node_modules paths case-insensitively', () => {
    expect(scan({ 'a.ts': "import '../Node_Modules/@Marmeon/core/x.js';" })).toHaveLength(1);
  });

  it('catches the pre-bundled copy under node_modules/.vite', () => {
    expect(scan({ 'a.ts': "import '/node_modules/.vite/deps/@marmeon_core_internal.js';" })).toHaveLength(1);
    expect(scan({ 'a.ts': "import '/node_modules/.vite/deps/react.js';" })).toEqual([]);
  });

  it('catches a triple-slash reference', () => {
    expect(scan({ 'a.ts': '/// <reference types="@marmeon/core/internal" />\nexport {};' })).toMatchObject([{ line: 1 }]);
  });

  it('finishes on a long run of node_modules segments', () => {
    const long = '/node_modules/'.repeat(50_000);
    expect(scan({ 'a.ts': `import '${long}x.js';` })).toEqual([]);
  });

  it('says what a dist, src or node_modules path is, apart from an /internal import', () => {
    expect(scan({ 'a.ts': "import '@marmeon/core/dist/x.js';" })[0]!.message).toBe(INSTALLED_MESSAGE);
    expect(scan({ 'a.ts': "import '@marmeon/core/internal';" })[0]!.message).not.toBe(INSTALLED_MESSAGE);
  });

  it('reads a directory called storage, dist or coverage below the root', () => {
    expect(scan({ 'modules/storage/a.ts': "import '@marmeon/core/internal';", 'storage/b.ts': "import '@marmeon/core/internal';" }).map((problem) => problem.file)).toEqual([
      'modules/storage/a.ts',
    ]);
  });

  it('skips a directory it cannot read and still reports the rest', () => {
    const root = tempDir('marmeon-check-');
    mkdirSync(join(root, 'locked'));
    mkdirSync(join(root, 'open'));
    writeFileSync(join(root, 'open/a.ts'), "import '@marmeon/core/internal';");
    chmodSync(join(root, 'locked'), 0o000);
    unreadable.push(join(root, 'locked'));
    expect(internalImports(root).map((problem) => problem.file)).toEqual(['open/a.ts']);
  });

  it('reports each place once', () => {
    expect(scan({ 'a.ts': "import '@marmeon/core/internal';\nimport '@marmeon/http/internal';" })).toHaveLength(2);
  });
});
