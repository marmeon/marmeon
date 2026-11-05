import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { marmeon, repo } from './__fixtures__/cli.js';

describe('what marmeon prints about a failure', { timeout: 60_000 }, () => {
  const blank = join(repo, 'apps/blank-app');
  // Built at run time: a literal of this shape would look like a leaked key.
  const key = ['wa', 'live', 'q8fz0kzb3t5wyvlp9nr2xcj7'].join('_');

  /** A copy of the blank app with a command that throws `message`, a `redact` pattern for the partner key, and a provider that fails at boot when `BOOT_FAILS` is set. */
  function appThrowing(message: string): string {
    const app = realpathSync(tempDir('marmeon-failure-'));
    cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
    writeFileSync(
      join(app, 'modules/system/Failing.ts'),
      [
        "import { CommandArgumentsError } from 'marmeon';",
        'export class FailingProvider {',
        '  register() {',
        '    if (process.env.BOOT_FAILS_CODE) throw Object.assign(new Error(`Unknown file extension ".tsx" for ${process.env.BOOT_FAILS_FILE}`), { code: process.env.BOOT_FAILS_CODE });',
        '    if (process.env.BOOT_FAILS) throw new Error(process.env.BOOT_FAILS);',
        '  }',
        '}',
        'export class FailCommand {',
        "  static command = 'fail';",
        "  static description = 'Throws';",
        '  handle() {',
        `    throw new Error(${JSON.stringify(message)});`,
        '  }',
        '}',
        'export class UsageCommand {',
        "  static command = 'usage-fail';",
        "  static description = 'Refuses its arguments';",
        '  handle() {',
        "    throw new CommandArgumentsError('Pass a name\\nUsage: marmeon usage-fail <name>');",
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(app, 'modules/system/index.ts'),
      "import { defineModule } from '@marmeon/core';\nimport { FailCommand, FailingProvider, UsageCommand } from './Failing.ts';\nexport default defineModule({ name: 'system', providers: [FailingProvider], commands: [FailCommand, UsageCommand], migrations: new URL('./migrations/', import.meta.url) });\n",
    );
    const definition = join(app, 'bootstrap/app.ts');
    writeFileSync(definition, readFileSync(definition, 'utf8').replace('middleware: {', 'redact: { patterns: [/\\bwa_live_[a-z0-9]{24}\\b/] },\n  middleware: {'));
    return app;
  }

  it('masks a secret in the error of a command with the redactor of the app', () => {
    const app = appThrowing(`refused ${key} and postgres://u:s3cret@h/db`);
    const run = marmeon(app, ['fail']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('refused [redacted]');
    for (const secret of [key, 's3cret']) expect(run.stdout + run.stderr).not.toContain(secret);
  });

  it('masks a secret in the error that stops the start, for a command and for list', () => {
    const app = appThrowing('x');
    const env = { BOOT_FAILS: `cannot connect: ${key} postgres://u:s3cret@h/db` };
    for (const args of [['fail'], ['list']]) {
      const run = marmeon(app, args, env);
      for (const secret of [key, 's3cret']) expect(run.stdout + run.stderr, args.join(' ')).not.toContain(secret);
    }
    const start = marmeon(app, ['fail'], env);
    expect(start.code).toBe(1);
    expect(start.stdout + start.stderr).toContain('cannot connect: [redacted]');
  });

  it('writes control characters of an error message out, and keeps the lines of a usage message', () => {
    const app = appThrowing('boom\u001b]52;c;eA==\u0007 end');
    const run = marmeon(app, ['fail']);
    expect(run.stderr).not.toContain('\u001b');
    expect(run.stderr).not.toContain('\u0007');
    expect(run.stderr).toContain('\\u001b]52;c;eA==\\u0007');
    const usage = marmeon(app, ['usage-fail']);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('Pass a name\n');
    expect(usage.stderr).toContain('Usage: marmeon usage-fail <name>');
  });

  it('indents the lines after the first of an error message, so a message cannot forge a line of its own', () => {
    const app = appThrowing('boom\n✗ Error: forged\n[12:00:00.000] ERROR: forged');
    const lines = marmeon(app, ['fail']).stderr.split('\n');
    expect(lines.filter((line) => line.startsWith('✗'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('forged')).every((line) => line.startsWith('  '))).toBe(true);
  });

  it('prints only the name of an unknown option of list, not its value', () => {
    const app = appThrowing('x');
    const run = marmeon(app, ['list', '--db=postgres://u:s3cret@h/db']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Unknown option '--db'");
    expect(run.stdout + run.stderr).not.toContain('s3cret');
  });

  it('does not run the code of the app for a wrong call to a command that needs no app', () => {
    const app = appThrowing('x');
    const marker = join(app, 'storage/imported');
    const definition = join(app, 'bootstrap/app.ts');
    writeFileSync(definition, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nsetInterval(() => {}, 1000);\n${readFileSync(definition, 'utf8')}`);
    const run = marmeon(app, ['key:generate', '--bogus'], {}, 20_000);
    expect(run.code).toBe(2);
    expect(existsSync(marker)).toBe(false);
  });

  it('masks the hint for a start error, which may quote a value from the error', () => {
    const app = appThrowing('x');
    const env = { BOOT_FAILS: 'tsx', BOOT_FAILS_CODE: 'ERR_UNKNOWN_FILE_EXTENSION', BOOT_FAILS_FILE: `${key} postgres://u:s3cret@h/db` };
    const run = marmeon(app, ['fail'], env);
    expect(run.code).toBe(1);
    // The core's hint for a .tsx file names the file the error names.
    expect(run.stdout + run.stderr).toContain('How to fix it');
    for (const secret of [key, 's3cret']) expect(run.stdout + run.stderr).not.toContain(secret);
  });

  it('masks the command and the docs link that marmeon check shows for a start error', () => {
    const app = appThrowing('x');
    // The app's node_modules plus one package: its provider brings a hint that quotes the error in `command` and `docs`.
    rmSync(join(app, 'node_modules'));
    const pkg = join(app, 'node_modules/fake-hints');
    mkdirSync(pkg, { recursive: true });
    for (const entry of readdirSync(join(blank, 'node_modules'))) symlinkSync(join(blank, 'node_modules', entry), join(app, 'node_modules', entry));
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fake-hints', version: '1.0.0', type: 'module', main: 'index.js', types: 'index.d.ts', marmeon: { providers: ['HintsProvider'] } }));
    writeFileSync(
      join(pkg, 'index.js'),
      "export class HintsProvider {\n  static solutions = [{ for: Error, when: (e) => e.message.includes('hint-me'), solve: (e) => ({ title: 'Try again', text: 'Look again.', command: `fix ${e.message}`, docs: `docs/${e.message}` }) }];\n  register() {}\n}\n",
    );
    writeFileSync(join(pkg, 'index.d.ts'), 'export declare class HintsProvider {\n  static solutions: unknown[];\n  register(): void;\n}\n');
    const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    writeFileSync(join(app, 'package.json'), JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, 'fake-hints': '1.0.0' } }));
    const run = marmeon(app, ['check', '--only=boot', '--json'], { BOOT_FAILS: `hint-me ${key}` }, 90_000);
    const reports = JSON.parse(run.stdout).checks as { name: string; problems: { fix?: string; docs?: string }[] }[];
    const problem = reports.find((report) => report.name === 'boot')!.problems[0]!;
    expect(problem.fix).toContain('hint-me');
    expect(problem.docs).toContain('hint-me');
    expect(run.stdout + run.stderr).not.toContain(key);
  });
});
