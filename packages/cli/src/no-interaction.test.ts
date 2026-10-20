import { cpSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { marmeon, repo } from './__fixtures__/cli.js';

describe('marmeon --no-interaction and the prompt of a command', { timeout: 30_000 }, () => {
  const blank = join(repo, 'apps/blank-app');

  /** A copy of the blank app with `ask`, which reports what it was given, and `abort`, which is cancelled at a question. */
  function appWithAsk(): string {
    const app = realpathSync(tempDir('marmeon-prompt-'));
    cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
    writeFileSync(
      join(app, 'modules/system/Ask.ts'),
      [
        'export class AskCommand {',
        "  static command = 'ask';",
        "  static description = 'Reports what it was given';",
        "  static options = { name: { type: 'string' } } as const;",
        '  async handle(input: { args: string[]; options: object; prompt: { interactive: boolean; choose(question: string, choices: string[]): Promise<number[]> } }) {',
        '    let asked = null;',
        "    try { await input.prompt.choose('Which?', ['a']); asked = 'answered'; } catch (error) { asked = (error as Error).message; }",
        '    console.log(JSON.stringify({ args: input.args, options: input.options, interactive: input.prompt.interactive, asked, env: process.env.MARMEON_NO_INTERACTION ?? null }));',
        '  }',
        '}',
        'export class RelayCommand {',
        "  static command = 'relay';",
        "  static description = 'Runs ask in a new process';",
        '  handle(input: { spawn(...args: string[]): Promise<number> }) {',
        "    return input.spawn('ask');",
        '  }',
        '}',
        'export class TimeoutCommand {',
        "  static command = 'timeout';",
        "  static description = 'Fails with the abort error of a timer';",
        '  async handle() {',
        "    await (await import('node:timers/promises')).setTimeout(1, undefined, { signal: AbortSignal.abort() });",
        '  }',
        '}',
        'export class AbortCommand {',
        "  static command = 'abort';",
        "  static description = 'Is cancelled at a question';",
        '  handle() {',
        "    throw Object.assign(new Error('The prompt was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR', [Symbol.for('marmeon.prompt.cancelled')]: true });",
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(app, 'modules/system/index.ts'),
      "import { defineModule } from '@marmeon/core';\nimport { AbortCommand, AskCommand, RelayCommand, TimeoutCommand } from './Ask.ts';\nexport default defineModule({ name: 'system', commands: [AskCommand, AbortCommand, RelayCommand, TimeoutCommand], migrations: new URL('./migrations/', import.meta.url) });\n",
    );
    return app;
  }

  it('asks nothing without a terminal: the command sees interactive false and choose() says what to do', () => {
    const app = appWithAsk();
    const { code, stdout } = marmeon(app, ['ask', 'x']);
    expect(code).toBe(0);
    const seen = JSON.parse(stdout) as { interactive: boolean; asked: string };
    expect(seen.interactive).toBe(false);
    expect(seen.asked).toMatch(/no terminal.*Check prompt\.interactive/);
  });

  it('does not hand --no-interaction to the command, wherever it stands after the command name and before --', () => {
    const app = appWithAsk();
    for (const args of [['ask', '--no-interaction', 'x'], ['ask', 'x', '--no-interaction']]) {
      const { code, stdout } = marmeon(app, args);
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ args: ['x'], options: {}, interactive: false });
    }
    // Before the command name it is no option of any command.
    const leading = marmeon(app, ['--no-interaction', 'ask', 'x']);
    expect(leading.code).toBe(2);
    expect(leading.stderr).toContain('Command "--no-interaction" is not defined');
    // After `--` it is an argument.
    expect(JSON.parse(marmeon(app, ['ask', '--', '--no-interaction']).stdout)).toMatchObject({ args: ['--no-interaction'] });
  });

  it('names the option once in marmeon list and in a command’s help', () => {
    const app = appWithAsk();
    expect(marmeon(app, ['list']).stdout.match(/--no-interaction/g)).toHaveLength(1);
    expect(marmeon(app, ['ask', '--help']).stdout).toMatch(/^ {2}--no-interaction +Ask no questions/m);
    expect(marmeon(app, ['list', '--no-interaction']).code).toBe(0);
  });

  it('passes it on to a command started with spawn, through the environment', () => {
    const app = appWithAsk();
    expect(JSON.parse(marmeon(app, ['relay', '--no-interaction']).stdout)).toMatchObject({ interactive: false, env: '1' });
    expect(JSON.parse(marmeon(app, ['relay']).stdout)).toMatchObject({ interactive: false, env: null });
  });

  it('runs through the launcher for dev, start and build', () => {
    const app = appWithAsk();
    for (const command of ['dev', 'start', 'build']) {
      const help = marmeon(app, [command, '--no-interaction', '--help']);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain('Usage: marmeon');
      expect(help.stderr).not.toContain('Unknown option');
      // A wrong option is still the wrong option, not --no-interaction.
      const wrong = marmeon(app, [command, '--no-interaction', '--bogus']);
      expect(wrong.code).toBe(2);
      expect(wrong.stderr).toContain("Unknown option '--bogus'");
    }
  });

  it('prints the error of an abort that is no cancelled question, with exit code 1', () => {
    const { code, stderr } = marmeon(appWithAsk(), ['timeout']);
    expect(code).toBe(1);
    expect(stderr).toContain('AbortError');
    expect(stderr).not.toContain('cancelled');
  });

  it('answers a cancelled question with exit code 130', () => {
    const { code, stderr, stdout } = marmeon(appWithAsk(), ['abort']);
    expect(code).toBe(130);
    expect(stderr).toContain('cancelled');
    expect(stdout).toBe('');
  });
});
