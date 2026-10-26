import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { marmeon, repo } from './__fixtures__/cli.js';

describe('marmeon commands and the error reporters', { timeout: 60_000 }, () => {
  const blank = join(repo, 'apps/blank-app');

  /** A copy of the blank app whose reporter appends every report to `storage/reports.jsonl`, with commands that throw, fail quietly or are called wrong. */
  function appWithReporter(): string {
    const app = realpathSync(tempDir('marmeon-reports-'));
    cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
    writeFileSync(
      join(app, 'modules/system/Reports.ts'),
      [
        "import { appendFileSync } from 'node:fs';",
        "import { CommandArgumentsError } from 'marmeon';",
        'export class FileReporter {',
        '  report(report: unknown) {',
        "    appendFileSync(process.env.REPORTS_FILE!, JSON.stringify(report) + '\\n');",
        '  }',
        '}',
        'export class ReportingProvider {',
        '  static errorReporters = [FileReporter];',
        '}',
        'export class BoomCommand {',
        "  static command = 'boom';",
        "  static description = 'Throws';",
        "  static options = { password: { type: 'string' } } as const;",
        '  handle() {',
        "    throw new Error('the export service is down');",
        '  }',
        '}',
        'export class WrongCallCommand {',
        "  static command = 'wrong-call';",
        "  static description = 'Refuses its arguments';",
        '  handle() {',
        "    throw new CommandArgumentsError('Pass a name: marmeon wrong-call <name>');",
        '  }',
        '}',
        'export class QuietFailCommand {',
        "  static command = 'quiet-fail';",
        "  static description = 'Ends with exit code 1 and no error';",
        '  handle() {',
        '    return 1;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(app, 'modules/system/index.ts'),
      "import { defineModule } from '@marmeon/core';\nimport { BoomCommand, QuietFailCommand, ReportingProvider, WrongCallCommand } from './Reports.ts';\nexport default defineModule({ name: 'system', providers: [ReportingProvider], commands: [BoomCommand, QuietFailCommand, WrongCallCommand], migrations: new URL('./migrations/', import.meta.url) });\n",
    );
    return app;
  }

  const reportsOf = (app: string): { source: string; error: { message: string }; context: Record<string, string> }[] => {
    const file = join(app, 'storage/reports.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  };

  it('reports a command that throws, by its name and never its arguments', () => {
    const app = appWithReporter();
    const env = { REPORTS_FILE: join(app, 'storage/reports.jsonl') };
    const run = marmeon(app, ['boom', '--password=x-secret-arg'], env);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('the export service is down');
    const reports = reportsOf(app);
    expect(reports).toMatchObject([{ source: 'command', error: { message: 'the export service is down' }, context: { command: 'boom' } }]);
    expect(JSON.stringify(reports)).not.toContain('x-secret-arg');
    // The error is said once: the screen has it, the log does not repeat it.
    expect(run.stderr.match(/the export service is down/g)).toHaveLength(1);
  });

  it('does not report a wrong call (exit 2), a command that ends with a code, or one that is asked for help', () => {
    const app = appWithReporter();
    const env = { REPORTS_FILE: join(app, 'storage/reports.jsonl') };
    expect(marmeon(app, ['boom', '--bogus'], env).code).toBe(2);
    expect(marmeon(app, ['quiet-fail'], env).code).toBe(1);
    // An app's own command that throws a CommandArgumentsError: exit 2, the message alone on stderr, no stack, nothing on stdout.
    const wrong = marmeon(app, ['wrong-call'], env);
    expect(wrong.code).toBe(2);
    expect(wrong.stdout).toBe('');
    expect(wrong.stderr).toContain('Pass a name: marmeon wrong-call <name>');
    expect(wrong.stderr).not.toMatch(/\n\s+at /);
    expect(marmeon(app, ['boom', '--help'], env).code).toBe(0);
    expect(reportsOf(app)).toEqual([]);
  });
});
