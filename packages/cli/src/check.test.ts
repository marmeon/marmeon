import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { marmeon, repo } from './__fixtures__/cli.js';
import { AGENTS_BLOCK } from './agents/block.ts';

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

/** The tools only: these apps have no `bootstrap/app.ts`, so `boot` and `readiness` are left out (check-app.test.ts runs those). */
function check(root: string, args: string[] = []) {
  const skipped = args.some((arg) => arg.startsWith('--skip='));
  const given = args.map((arg) => (arg.startsWith('--skip=') ? `${arg},boot,readiness` : arg));
  return marmeon(root, ['check', ...given, ...(skipped ? [] : ['--skip=boot,readiness'])], {}, 60_000);
}

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
      ['raw-sql', 'passed'],
      ['inner-html', 'passed'],
      ['agents', 'skipped'],
    ]);
  });

  it('prints one line per check without --json', () => {
    const { code, stdout } = check(app({}));
    expect(code).toBe(0);
    expect(stdout).toMatch(/✓ types\n✓ lint\n✓ internal-imports\n✓ raw-sql\n✓ inner-html\n- agents skipped: no AGENTS.md\n/);
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
    expect(JSON.parse(check(root, ['--skip=types,lint', '--json']).stdout).checks.map((report: { name: string }) => report.name)).toEqual(['internal-imports', 'raw-sql', 'inner-html', 'agents']);
  });

  it('exits 2 for empty name lists, and fails on the boot, with a warning, for a name nobody knows when the app did not load', () => {
    for (const args of [['--only='], ['--only']]) {
      const { code, stdout } = check(app({}, []), [...args, '--json']);
      expect(code, args.join(' ')).toBe(2);
      expect(stdout).toBe('');
    }
    for (const args of [['--skip=bogus'], ['--only=types,bogus']]) {
      const { code, stdout } = marmeon(app({}, []), ['check', ...args, '--json'], {}, 60_000);
      expect(code, args.join(' ')).toBe(1);
      expect(JSON.parse(stdout).warnings).toContain('No check is known by the name bogus: they may be checks the app adds itself.');
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
    // The stored document lists the checks of its time; one added since follows them.
    expect({ ...document, checks: document.checks.slice(0, fixture.checks.length) }).toMatchObject(fixture);
    for (const report of document.checks) {
      expect(report.ms).toEqual(expect.any(Number));
      expect(Object.keys(report)).toEqual(['name', 'status', 'ms', 'reason', 'problems', 'silenced']);
      for (const problem of report.problems) {
        expect(Object.keys(problem)).toEqual(['severity', 'message', 'file', 'line', 'column', 'code', 'rule', 'fix', 'docs']);
      }
    }
  });

  it.each(['blank-app', 'web-app'])('finds no fault in apps/%s', (name) => {
    expect(check(join(repo, 'apps', name), ['--only=internal-imports']).code).toBe(0);
  });
});

describe('marmeon check raw-sql', { timeout: 90_000 }, () => {
  const SQL = "import { sql } from '@marmeon/database';\n";

  it('warns about a non-literal argument and still exits 0', () => {
    const { code, stdout, stderr } = check(app({ 'src/order.ts': `${SQL}export const by = (column: string) => sql.raw(column);\n` }, []), ['--only=raw-sql']);
    expect(code).toBe(0);
    expect(stderr).toContain('raw-sql — 1 warning');
    expect(stdout).toContain('src/order.ts:2:47');
    expect(stdout).toContain('(marmeon(raw-sql))');
    expect(stdout).toContain('docs: docs/check.md#raw-sql');
    expect(stdout).toContain('Passed (exit 0).');
  });

  it('passes a literal argument and an interpolation in a sql template', () => {
    const { code, stdout } = check(app({ 'src/order.ts': `${SQL}export const a = sql.raw('now()');\nexport const b = (x: string) => sql\`select ${'${x}'}\`;\n` }, []), ['--only=raw-sql']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^✓ raw-sql\n/);
  });

  it('is silenced by a comment with a reason: passed, listed as silenced in the text and in the document', () => {
    const files = { 'src/order.ts': `${SQL}// marmeon-check-ignore raw-sql: the column comes from a list in this file\nexport const by = (column: string) => sql.raw(column);\n` };
    const text = check(app(files, []), ['--only=raw-sql']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('✓ raw-sql (1 silenced)\n  silenced  src/order.ts:3  the column comes from a list in this file\n');
    const json = check(app(files, []), ['--only=raw-sql', '--json']);
    expect(json.code).toBe(0);
    const document = JSON.parse(json.stdout);
    expect(document).toMatchObject(JSON.parse(readFileSync(new URL('./__fixtures__/formats/cli-check/v1-silenced.json', import.meta.url), 'utf8')));
    expect(document.checks[0].problems).toEqual([]);
    for (const item of document.checks[0].silenced) {
      expect(Object.keys(item)).toEqual(['severity', 'message', 'file', 'line', 'column', 'code', 'rule', 'fix', 'docs', 'reason']);
    }
  });

  it('keeps the finding of a comment without a reason, and warns about the comment', () => {
    const { code, stdout } = check(app({ 'src/order.ts': `${SQL}// marmeon-check-ignore raw-sql\nexport const by = (column: string) => sql.raw(column);\n` }, []), ['--only=raw-sql', '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(stdout).checks[0];
    expect(report).toMatchObject({ status: 'warning', silenced: [] });
    expect(report.problems.map((problem: { rule: string }) => problem.rule)).toEqual(['marmeon(raw-sql)', 'marmeon(check-ignore)']);
  });

  it('never silences internal-imports: the import stays an error, exit 1', () => {
    const { code, stdout } = check(app({ 'src/b.ts': "// marmeon-check-ignore internal-imports: needed here\nimport { x } from '@marmeon/core/internal';\nexport { x };\n" }, []), ['--only=internal-imports,raw-sql', '--json']);
    expect(code).toBe(1);
    const reports = JSON.parse(stdout).checks;
    expect(reports.map((report: { name: string; status: string }) => [report.name, report.status])).toEqual([
      ['internal-imports', 'failed'],
      ['raw-sql', 'passed'],
    ]);
    expect(reports[0].silenced).toEqual([]);
  });

  it.each(['blank-app', 'web-app'])('finds nothing in apps/%s', (name) => {
    const { code, stdout } = check(join(repo, 'apps', name), ['--only=raw-sql', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).checks[0]).toMatchObject({ name: 'raw-sql', status: 'passed', problems: [] });
  });
});

describe('marmeon check inner-html', { timeout: 90_000 }, () => {
  it('warns about HTML set from a value and still exits 0', () => {
    const { code, stdout, stderr } = check(app({ 'src/show.ts': 'export const show = (el: HTMLElement, html: string) => { el.innerHTML = html; };\n' }, []), ['--only=inner-html']);
    expect(code).toBe(0);
    expect(stderr).toContain('inner-html — 1 warning');
    expect(stdout).toContain('src/show.ts:1:');
    expect(stdout).toContain('(marmeon(inner-html))');
    expect(stdout).toContain('docs: docs/check.md#html-from-code');
    expect(stdout).toContain('Passed (exit 0).');
  });

  it('is silenced in JSX by a comment above the attribute: passed, listed as silenced', () => {
    const files = {
      'src/Block.tsx': ['export const Block = ({ html }: { html: string }) => (', '  <div>', '    {/* marmeon-check-ignore inner-html: the markup is the highlighter output */}', '    <p dangerouslySetInnerHTML={{ __html: html }} />', '  </div>', ');', ''].join('\n'),
    };
    const { code, stdout } = check(app(files, []), ['--only=inner-html', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).checks[0]).toMatchObject({
      name: 'inner-html',
      status: 'passed',
      problems: [],
      silenced: [{ file: 'src/Block.tsx', line: 4, rule: 'marmeon(inner-html)', reason: 'the markup is the highlighter output' }],
    });
  });

  it.each(['blank-app', 'web-app'])('finds nothing in apps/%s', (name) => {
    const { code, stdout } = check(join(repo, 'apps', name), ['--only=inner-html', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).checks[0]).toMatchObject({ name: 'inner-html', status: 'passed', problems: [], silenced: [] });
  });

  it('finds one silenced place in apps/website', () => {
    const { code, stdout } = check(join(repo, 'apps', 'website'), ['--only=inner-html', '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(stdout).checks[0];
    expect(report).toMatchObject({ name: 'inner-html', status: 'passed', problems: [] });
    expect(report.silenced).toMatchObject([{ file: 'modules/site/components/CodeBlock.tsx', rule: 'marmeon(inner-html)' }]);
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

describe('marmeon check: the block of AGENTS.md', { timeout: 90_000 }, () => {
  /** Only the `agents` check, as the document `--json` prints, and whether the call left `AGENTS.md` as it was. */
  function agents(files: Record<string, string>) {
    const root = app(files, []);
    const before = files['AGENTS.md'];
    const { code, stdout } = check(root, ['--only=agents', '--json']);
    const after = (() => {
      try {
        return readFileSync(join(root, 'AGENTS.md'), 'utf8');
      } catch {
        return undefined;
      }
    })();
    return { code, report: JSON.parse(stdout).checks[0], untouched: after === before, root };
  }

  it('passes a current block', () => {
    const { code, report, untouched } = agents({ 'AGENTS.md': `# Shop\n\n${AGENTS_BLOCK}\n\nMine.\n` });
    expect(code).toBe(0);
    expect(report).toMatchObject({ name: 'agents', status: 'passed', problems: [] });
    expect(untouched).toBe(true);
  });

  it('warns about an out-of-date block with the command that fixes it, exit 0, and writes nothing', () => {
    const { code, report, untouched } = agents({ 'AGENTS.md': `# Shop\n\n${AGENTS_BLOCK.replace('Managed', 'Old')}\n` });
    expect(code).toBe(0);
    expect(report.status).toBe('warning');
    expect(report.problems).toEqual([
      expect.objectContaining({ severity: 'warning', file: 'AGENTS.md', fix: 'marmeon agents:sync', message: "AGENTS.md's marmeon block is out of date — marmeon agents:sync" }),
    ]);
    expect(untouched).toBe(true);
  });

  it('warns about a file without a block', () => {
    const { code, report, untouched } = agents({ 'AGENTS.md': '# Shop\n\nMine.\n' });
    expect(code).toBe(0);
    expect(report.status).toBe('warning');
    expect(report.problems[0]).toMatchObject({ severity: 'warning', fix: 'marmeon agents:sync' });
    expect(untouched).toBe(true);
  });

  it('warns about marks it cannot read, naming the reason, exit 0', () => {
    for (const text of ['<!-- marmeon:begin v1 -->\nx\n', `${AGENTS_BLOCK}\n${AGENTS_BLOCK}\n`, '<!-- marmeon:begin v999 -->\nx\n<!-- marmeon:end -->\n']) {
      const { code, report, untouched } = agents({ 'AGENTS.md': text });
      expect(code).toBe(0);
      expect(report.status).toBe('warning');
      expect(report.problems[0].message).toContain('AGENTS.md was left as it is');
      expect(untouched).toBe(true);
    }
  });

  it('skips an app without AGENTS.md: the file is the app\'s', () => {
    const { code, report } = agents({});
    expect(code).toBe(0);
    expect(report).toMatchObject({ name: 'agents', status: 'skipped', reason: 'no AGENTS.md', problems: [] });
  });

  it('follows a link that stays inside the app', () => {
    const root = app({ 'docs/guide.md': `${AGENTS_BLOCK}\n` }, []);
    symlinkSync(join(root, 'docs/guide.md'), join(root, 'AGENTS.md'));
    expect(JSON.parse(check(root, ['--only=agents', '--json']).stdout).checks[0].status).toBe('passed');
  });

  it('does not read a link that leads out of the app, or nowhere', () => {
    const outside = realpathSync(tempDir('marmeon-check-outside-'));
    writeFileSync(join(outside, 'secret.md'), 'SECRET-TEXT\n');
    for (const target of [join(outside, 'secret.md'), join(outside, 'missing.md')]) {
      const root = app({}, []);
      symlinkSync(target, join(root, 'AGENTS.md'));
      const { code, stdout } = check(root, ['--only=agents', '--json']);
      expect(code).toBe(0);
      const report = JSON.parse(stdout).checks[0];
      expect(report.status).toBe('warning');
      expect(report.problems[0].message).toMatch(/outside the app|leads nowhere/);
      expect(stdout).not.toContain('SECRET-TEXT');
    }
  });

  it('warns about a directory as AGENTS.md instead of failing, exit 0', () => {
    const root = app({}, []);
    mkdirSync(join(root, 'AGENTS.md'));
    const { code, stdout } = check(root, ['--only=agents', '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(stdout).checks[0];
    expect(report.status).toBe('warning');
    expect(report.problems[0].message).toBe('AGENTS.md is not a file. It was not read.');
  });

  it('is listed after inner-html, and --skip=agents leaves it out', () => {
    const root = app({ 'AGENTS.md': '# Shop\n' });
    expect(JSON.parse(check(root, ['--json']).stdout).checks.map((report: { name: string }) => report.name)).toEqual(['types', 'lint', 'internal-imports', 'raw-sql', 'inner-html', 'agents']);
    expect(JSON.parse(check(root, ['--skip=agents', '--json']).stdout).checks.map((report: { name: string }) => report.name)).toEqual(['types', 'lint', 'internal-imports', 'raw-sql', 'inner-html']);
  });
});
