import { cpSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { marmeon, repo } from './__fixtures__/cli.js';
import { appFrameOf, noteCompileFailure } from './load-failure.js';

describe('marmeon names the file where the app failed to load', { timeout: 60_000 }, () => {
  const blank = join(repo, 'apps/blank-app');

  /** A copy of the blank app whose `system` module imports `modules/system/broken.ts` (or the `imports` in order) with the given source; `files` adds more. */
  function appWithBrokenModule(source: string, { file = 'broken.ts', imports = [file], files = {} }: { file?: string; imports?: string[]; files?: Record<string, string> } = {}): string {
    const app = realpathSync(tempDir('marmeon-load-failure-'));
    cpSync(blank, app, { recursive: true, filter: (path) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(path.slice(blank.length)) && !/[/\\]\.env$/.test(path) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
    writeFileSync(join(app, 'modules/system', file), source);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(app, 'modules/system', name), text);
    writeFileSync(
      join(app, 'modules/system/index.ts'),
      `import { defineModule } from '@marmeon/core';\n${imports.map((name) => `import './${name}';\n`).join('')}export default defineModule({ name: 'system', migrations: new URL('./migrations/', import.meta.url) });\n`,
    );
    return app;
  }

  it('names the module and its line for a syntax error', () => {
    // The error is below line 1: Node prints the lines before it as well, the caret is not on the third line.
    const app = appWithBrokenModule('export const a = 1;\nexport const b = 2;\nexport const c = (;\n');
    const run = marmeon(app, ['route:list']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('Could not start the application');
    expect(run.stderr).toMatch(/at modules\/system\/broken\.ts:3:19\n/);
    expect(run.stderr).not.toContain(app);
  });

  it('finds the column when an empty line comes before the broken one', () => {
    const app = appWithBrokenModule('export const a = 1;\n\nexport const c = (;\n');
    const run = marmeon(app, ['route:list']);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/at modules\/system\/broken\.ts:3:19\n/);
  });

  it('names the file, without a line, of a syntax error only V8 reports', () => {
    // An invisible character in a regular expression: Node's message names no file at all.
    const app = appWithBrokenModule('export const a = 1;\nexport const pattern = /a\u2028b/;\n');
    const run = marmeon(app, ['route:list']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('Invalid regular expression');
    expect(run.stderr).toMatch(/\n {2}at modules\/system\/broken\.ts\n/);
    expect(run.stderr).not.toContain('ExperimentalWarning');
  });

  it('names a .js file with a duplicate export', () => {
    const app = appWithBrokenModule('export const a = 1;\nexport const a = 2;\n', { file: 'broken.js' });
    const run = marmeon(app, ['route:list']);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/\n {2}at modules\/system\/broken\.js\n/);
  });

  it('names the broken file, not a sibling imported before or after it', () => {
    const app = appWithBrokenModule('export const a = /a\u2028b/;\n', { imports: ['before.ts', 'broken.ts', 'after.ts'], files: { 'before.ts': 'export const before = 1;\n', 'after.ts': 'export const after = 1;\n' } });
    const run = marmeon(app, ['route:list']);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/\n {2}at modules\/system\/broken\.ts\n/);
    expect(run.stderr).not.toMatch(/before\.ts|after\.ts/);
  });

  it('names no file for a broken module behind a top-level await import()', () => {
    const app = appWithBrokenModule("await import('./inner.ts');\n", { files: { 'inner.ts': 'export const a = /a\u2028b/;\n' } });
    const run = marmeon(app, ['route:list']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('Invalid regular expression');
    expect(run.stderr).not.toMatch(/\n {2}at /);
  });

  it('still names the importer and its line for a missing named export', () => {
    const app = appWithBrokenModule("import { nope } from './other.ts';\nexport const a = nope;\n", { files: { 'other.ts': 'export const other = 1;\n' } });
    const run = marmeon(app, ['route:list']);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/\n {2}at modules\/system\/broken\.ts:1(:\d+)?\n/);
  });

  it('names the module a thrown error came from', () => {
    const app = appWithBrokenModule("export const a = 1;\nthrow new Error('the table is gone');\n");
    const run = marmeon(app, ['route:list']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('the table is gone');
    expect(run.stderr).toMatch(/at modules\/system\/broken\.ts:2:\d+\n/);
  });
});

describe('appFrameOf', () => {
  const root = '/srv/app';

  it('takes the first frame inside the app, not node_modules nor node:', () => {
    const error = new Error('x');
    error.stack = ['Error: x', '    at node:internal/modules/esm/loader:1:1', '    at file:///srv/app/node_modules/pkg/index.js:3:4', '    at load (/srv/app/modules/a/b.ts:12:3)', '    at /srv/app/modules/c.ts:1:1'].join('\n');
    expect(appFrameOf(error, root)).toBe('modules/a/b.ts:12:3');
  });

  it('reads a file: URL frame and follows the cause', () => {
    const inner = new Error('inner');
    inner.stack = 'Error: inner\n    at file:///srv/app/modules/a/x.ts:5:7';
    expect(appFrameOf(new Error('outer', { cause: inner }), root)).toBe('modules/a/x.ts:5:7');
  });

  it('answers nothing for an error from a package alone, or for a file outside the app', () => {
    const error = new Error('x');
    error.stack = 'Error: x\n    at file:///srv/app/node_modules/pkg/index.js:3:4\n    at /elsewhere/y.ts:1:1';
    expect(appFrameOf(error, root)).toBeUndefined();
    expect(appFrameOf('text', root)).toBeUndefined();
  });

  it('does not take the importer in the frames of a compile error for the broken file', () => {
    const error = new SyntaxError('Invalid regular expression: missing /');
    error.stack = 'SyntaxError: Invalid regular expression: missing /\n    at compileSourceTextModule (node:internal/modules/esm/utils:355:16)\n    at file:///srv/app/bootstrap/routes.ts:5:9';
    expect(appFrameOf(error, root)).toBeUndefined();
  });

  it('takes the frame of a SyntaxError thrown while the module runs', () => {
    let thrown: unknown;
    try {
      JSON.parse('{oops');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SyntaxError);
    expect(appFrameOf(thrown, import.meta.dirname)).toMatch(/^load-failure\.test\.ts:\d+:\d+$/);
  });

  it('reads the line and column of a TypeScript SyntaxError from a head of several lines', () => {
    const error = new SyntaxError('Unexpected token');
    error.stack = '/srv/app/modules/a/bad.ts:4\nexport const a = 1;\nexport const b = 2;\nexport const c = (;\n                  ^\n\nSyntaxError: Unexpected token\n    at parseTypeScript (node:internal/modules/typescript:61:36)';
    expect(appFrameOf(error, root)).toBe('modules/a/bad.ts:4:19');
  });

  const compileError = (stack?: string): SyntaxError => {
    const error = new SyntaxError('Duplicate export');
    error.stack = stack ?? 'SyntaxError: Duplicate export\n    at compileSourceTextModule (node:internal/modules/esm/utils:355:16)';
    return error;
  };

  it('names a file the load hook noted, without a line', () => {
    const error = compileError();
    noteCompileFailure(error, 'file:///srv/app/modules/a/broken.js');
    expect(appFrameOf(error, root)).toBe('modules/a/broken.js');
  });

  it('names no noted file in node_modules or outside the app', () => {
    const inPackage = compileError();
    noteCompileFailure(inPackage, 'file:///srv/app/node_modules/pkg/index.js');
    expect(appFrameOf(inPackage, root)).toBeUndefined();
    const outside = compileError();
    noteCompileFailure(outside, 'file:///elsewhere/broken.js');
    expect(appFrameOf(outside, root)).toBeUndefined();
  });

  it('prefers the line of the head to a noted file', () => {
    const error = compileError('/srv/app/modules/a/bad.ts:4\nexport const c = (;\n                  ^\n\nSyntaxError: Unexpected token\n    at parseTypeScript (node:internal/modules/typescript:61:36)');
    noteCompileFailure(error, 'file:///srv/app/modules/a/other.ts');
    expect(appFrameOf(error, root)).toBe('modules/a/bad.ts:4:19');
  });
});
