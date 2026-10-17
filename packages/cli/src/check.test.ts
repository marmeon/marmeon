import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { marmeon, repo } from './__fixtures__/cli.js';

const blank = join(repo, 'apps/blank-app');
const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, target: 'esnext', module: 'esnext', moduleResolution: 'bundler', types: [], allowImportingTsExtensions: true },
  include: ['src'],
});

/** A small app with its own tsconfig; `tools` names the packages of the blank app's `node_modules` it can use. */
function app(files: Record<string, string>, tools: ('typescript' | 'oxlint')[] = ['typescript', 'oxlint']): string {
  const root = realpathSync(tempDir('marmeon-check-'));
  const all = { 'tsconfig.json': TSCONFIG, 'src/ok.ts': 'export const ok: number = 1;\n', ...files };
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  if (tools.length > 0) {
    mkdirSync(join(root, 'node_modules'));
    for (const tool of tools) symlinkSync(realpathSync(join(blank, 'node_modules', tool)), join(root, 'node_modules', tool), 'dir');
  }
  return root;
}

const check = (root: string, args: string[] = []) => marmeon(root, ['check', ...args], {}, 60_000);

describe('marmeon check', { timeout: 90_000 }, () => {
  it('passes a clean app: every check passed, exit 0', () => {
    const { code, stdout } = check(app({}), ['--json']);
    expect(code).toBe(0);
    const document = JSON.parse(stdout);
    expect(document).toMatchObject({ format: 1, ok: true, exitCode: 0, warnings: [] });
    expect(document.checks.map((report: { name: string; status: string }) => [report.name, report.status])).toEqual([
      ['types', 'passed'],
      ['lint', 'passed'],
      ['internal-imports', 'passed'],
    ]);
  });

  it('prints one line per check without --json', () => {
    const { code, stdout } = check(app({}));
    expect(code).toBe(0);
    expect(stdout).toMatch(/✓ types\n✓ lint\n✓ internal-imports\n/);
    expect(stdout).toContain('Passed (exit 0).');
  });

  it('fails a type error with file, line, column and code: exit 1', () => {
    const { code, stdout } = check(app({ 'src/a.ts': "const a: number = 'x';\nexport { a };\n" }), ['--only=types']);
    expect(code).toBe(1);
    expect(stdout).toContain("src/a.ts:1:7  Type 'string' is not assignable to type 'number'.  (TS2322)");
    expect(stdout).toContain('Failed: a check found errors (exit 1).');
  });

  it('reports a lint error from the real oxlint, with its place', () => {
    const { code, stdout } = check(app({ '.oxlintrc.json': '{ "rules": { "no-debugger": "error" } }', 'src/d.ts': 'export function f() {\n  debugger;\n}\n' }), ['--only=lint', '--json']);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).checks[0]).toMatchObject({ name: 'lint', status: 'failed', problems: [{ severity: 'error', file: 'src/d.ts', line: 2, column: 3, rule: 'eslint(no-debugger)' }] });
  });

  it('reports lint warnings without failing', () => {
    const { code, stdout } = check(app({ '.oxlintrc.json': '{ "rules": { "no-debugger": "warn" } }', 'src/d.ts': 'export function f() {\n  debugger;\n}\n' }), ['--only=lint', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).checks[0]).toMatchObject({ status: 'warning', problems: [{ severity: 'warning', rule: 'eslint(no-debugger)' }] });
  });

  it('fails on a framework internal without any .oxlintrc.json, although the lint passes', () => {
    const root = app({ 'src/b.ts': "import { x } from '@marmeon/core/internal';\nexport { x };\n" });
    const { code, stdout } = check(root, ['--only=internal-imports,lint', '--json']);
    expect(code).toBe(1);
    const reports = JSON.parse(stdout).checks;
    expect(reports.map((report: { name: string; status: string }) => [report.name, report.status])).toEqual([
      ['lint', 'passed'],
      ['internal-imports', 'failed'],
    ]);
    expect(reports[1].problems).toMatchObject([{ file: 'src/b.ts', line: 1, column: 19, rule: 'marmeon(no-internal-imports)' }]);
  });

  it('fails on the other spellings: exit 1 each', () => {
    const spellings = {
      'src/a.ts': "import type { X } from '@marmeon/core/internal';\nexport type { X };\n",
      'src/b.ts': "export * from '@marmeon/http/internal';\n",
      'src/c.ts': "export const m = await import('@marmeon/http/internal');\n",
      'src/d.ts': "import { vi } from 'vitest';\nvi.mock('@marmeon/queue/internal');\n",
      'src/e.ts': 'export const m = await import(`@marmeon/queue/internal`);\n',
      'src/f.ts': "export { x } from 'marmeon/internal';\n",
      'src/g.ts': "export { x } from '../node_modules/@marmeon/core/dist/x.js';\n",
      'src/h.js': "const m = require('@marmeon/core/internal');\n",
    };
    for (const [name, text] of Object.entries(spellings)) {
      const { code, stdout } = check(app({ [name]: text }, []), ['--only=internal-imports']);
      expect(code, name).toBe(1);
      expect(stdout, name).toContain(`${name}:`);
    }
    const viaConfig: Record<string, string>[] = [
      { 'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@x': ['@marmeon/core/internal'] } } }) },
      { 'package.json': JSON.stringify({ imports: { '#x': '@marmeon/core/internal' } }) },
    ];
    for (const files of viaConfig) expect(check(app(files, []), ['--only=internal-imports']).code, Object.keys(files)[0]).toBe(1);
  });

  it('finds no fault in look-alikes, a comment or a file under node_modules', () => {
    const root = app(
      {
        'src/a.ts': "import '@marmeon/core/internals';\nimport '@marmeon/core';\n// import '@marmeon/core/internal'\nexport {};\n",
        'node_modules/pkg/index.ts': "import '@marmeon/core/internal';\n",
      },
      [],
    );
    expect(check(root, ['--only=internal-imports']).code).toBe(0);
  });

  it('exits 3 and names the check when TypeScript is not installed', () => {
    const { code, stdout } = check(app({}, ['oxlint']), ['--json']);
    expect(code).toBe(3);
    const document = JSON.parse(stdout);
    expect(document).toMatchObject({ ok: false, exitCode: 3 });
    expect(document.checks[0]).toMatchObject({ name: 'types', status: 'error', reason: expect.stringContaining('TypeScript is not installed') });
  });

  it('exits 1, not 3, when one check found errors and another could not run', () => {
    const root = app({ 'src/b.ts': "import '@marmeon/core/internal';\n" }, ['oxlint']);
    expect(check(root).code).toBe(1);
  });

  it('skips lint when oxlint is not installed, and still exits 0', () => {
    const { code, stdout } = check(app({}, ['typescript']), ['--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).checks[1]).toMatchObject({ name: 'lint', status: 'skipped', reason: 'oxlint is not installed — pnpm add -D oxlint' });
  });

  it('skips types without a tsconfig.json', () => {
    const root = app({});
    rmSync(join(root, 'tsconfig.json'));
    const { code, stdout } = check(root, ['--only=types', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).checks[0]).toMatchObject({ name: 'types', status: 'skipped', reason: 'no tsconfig.json' });
  });

  it('runs only the checks --only names, and not the ones --skip names', () => {
    const root = app({});
    expect(JSON.parse(check(root, ['--only=types', '--json']).stdout).checks.map((report: { name: string }) => report.name)).toEqual(['types']);
    expect(JSON.parse(check(root, ['--skip=types,lint', '--json']).stdout).checks.map((report: { name: string }) => report.name)).toEqual(['internal-imports']);
  });

  it('exits 2 for a name no check has, listing the valid ones, with nothing on stdout', () => {
    for (const args of [['--skip=bogus'], ['--only=types,bogus'], ['--only='], ['--only']]) {
      const { code, stdout, stderr } = check(app({}, []), [...args, '--json']);
      expect(code, args.join(' ')).toBe(2);
      expect(stdout).toBe('');
      if (args[0] !== '--only') expect(stderr).toContain('The checks are: types, lint, internal-imports.');
    }
  });

  it('writes a control character of a message as \\xNN in the text', () => {
    const root = app({ 'src/a.ts': "import '\\x1b[31mRED';\n" }, ['typescript']);
    const { stdout } = check(root, ['--only=types']);
    expect(stdout).toContain('\\x1b[31mRED');
    expect(stdout).not.toContain('\u001b');
  });

  it('exits 2 when --only and --skip leave nothing to run', () => {
    const { code, stdout, stderr } = check(app({}, []), ['--only=lint', '--skip=lint', '--json']);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('leave no check to run');
  });

  it('writes a control character of a file name as \\xNN in the text', () => {
    const root = app({ 'src/a\u001b[31mb.ts': "import '@marmeon/core/internal';\n" }, []);
    const { stdout } = check(root, ['--only=internal-imports']);
    expect(stdout).toContain('src/a\\x1b[31mb.ts:1:8');
    expect(stdout).not.toContain('\u001b');
  });

  it('prints one document that matches the stored format, also on exit 1', () => {
    const root = app({ 'src/a.ts': "const a: number = 'x';\nexport { a };\n", 'src/b.ts': "// @ts-ignore\nimport { x } from '@marmeon/core/internal';\nexport { x };\n" }, ['typescript']);
    const { code, stdout } = check(root, ['--json']);
    expect(code).toBe(1);
    expect(stdout.endsWith('\n')).toBe(true);
    const document = JSON.parse(stdout);
    expect(Object.keys(document)[0]).toBe('format');
    const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/formats/cli-check/v1.json', import.meta.url), 'utf8'));
    expect(document).toMatchObject(fixture);
    for (const report of document.checks) {
      expect(report.ms).toEqual(expect.any(Number));
      expect(Object.keys(report)).toEqual(['name', 'status', 'ms', 'reason', 'problems']);
      for (const problem of report.problems) {
        expect(Object.keys(problem)).toEqual(['severity', 'message', 'file', 'line', 'column', 'code', 'rule', 'fix', 'docs']);
      }
    }
  });

  it.each(['blank-app', 'web-app'])('finds no fault in apps/%s', (name) => {
    expect(check(join(repo, 'apps', name), ['--only=internal-imports']).code).toBe(0);
  });
});

describe('marmeon build and framework internals', { timeout: 90_000 }, () => {
  /** The last line a build prints: where it stopped. */
  const lastLine = (stderr: string) => stderr.trim().split('\n').filter((line) => !line.includes('src/') && !line.includes('marmeon check fails')).at(-1);

  it('warns with file and line, and stops where it stops without the import', () => {
    const clean = app({});
    const dirty = app({ 'src/b.ts': "import { x } from '@marmeon/core/internal';\nexport { x };\n" });
    const without = marmeon(clean, ['build', '--no-typecheck'], {}, 60_000);
    const withImport = marmeon(dirty, ['build', '--no-typecheck'], {}, 60_000);
    expect(withImport.code).toBe(without.code);
    expect(lastLine(withImport.stderr)).toBe(lastLine(without.stderr));
    expect(withImport.stdout).toBe(without.stdout);
    expect(withImport.stderr).toContain('src/b.ts:1:19');
    expect(withImport.stderr).toContain('marmeon check fails on these imports.');
    expect(without.stderr).not.toContain('marmeon check fails');
  });
});
