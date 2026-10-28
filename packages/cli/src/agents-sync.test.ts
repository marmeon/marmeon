import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { marmeon, repo } from './__fixtures__/cli.js';
import { AGENTS_BEGIN, AGENTS_BLOCK, AGENTS_BLOCK_FORMAT, AGENTS_END } from './agents/block.ts';
import { syncAgents } from './agents/sync.ts';
import { BUILT_IN } from './built-in.ts';
import { AgentsSyncCommand } from './commands/agents-sync.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

/** `AGENTS.md` and `CLAUDE.md` as the command left them, what it printed and its exit code. */
function sync(files: Record<string, string>, options: Record<string, unknown> = {}) {
  const root = realpathSync(tempDir('marmeon-agents-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  const lines: string[] = [];
  const say = (prefix: string) => (line = '') => void lines.push(`${prefix}${line}`);
  const output = { success: say('✓ '), error: say('✗ '), warn: say('! '), line: say('') };
  const code = new AgentsSyncCommand().handle({ root, args: [], options, output, spawn: async () => 0 } as never);
  const read = (name: string) => (existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : undefined);
  return { code, lines, agents: read('AGENTS.md'), claude: read('CLAUDE.md') };
}

const fixtures = new URL('./__fixtures__/formats/agents-block/', import.meta.url);

/** Every fixture, and its CRLF twin made here: a checkout may turn the line ends of a stored file. */
function variants(): [string, string][] {
  const all = readdirSync(fixtures).flatMap((name): [string, string][] => {
    const text = readFileSync(new URL(name, fixtures), 'utf8');
    return [[name, text], [`${name} (CRLF)`, text.replaceAll('\n', '\r\n')]];
  });
  for (const [name, text] of all) if (name.endsWith('(CRLF)')) expect(text.replaceAll('\r\n', '')).not.toContain('\n');
  expect(all.some(([name, text]) => name.endsWith('(CRLF)') && text.includes('\r\n'))).toBe(true);
  return all;
}

describe('marmeon agents:sync', () => {
  it('makes AGENTS.md and CLAUDE.md in an app that has neither', () => {
    const { code, agents, claude } = sync({ 'package.json': '{ "name": "shop" }' });
    expect(code).toBe(0);
    expect(agents).toBe(`# shop\n\n${AGENTS_BLOCK}\n\n## This app\n\nNotes for agents that belong to this app go here.\n`);
    expect(claude).toBe('@AGENTS.md\n');
  });

  it('tells an agent to run marmeon from the app\'s root', () => {
    expect(AGENTS_BLOCK).toContain('Run `marmeon` from the app\'s root, never from inside `node_modules`.');
  });

  it('titles a new file "This app" when package.json names nothing', () => {
    expect(sync({}).agents).toMatch(/^# This app\n/);
    expect(sync({ 'package.json': '{ not json' }).agents).toMatch(/^# This app\n/);
  });

  it('replaces the block and leaves every byte outside it, in a file with Unicode and CRLF', () => {
    for (const [name, text] of variants()) {
      const begin = text.indexOf(AGENTS_BEGIN);
      const end = text.indexOf(AGENTS_END) + AGENTS_END.length;
      const result = syncAgents(text, AGENTS_BLOCK);
      expect(result.ok, name).toBe(true);
      if (!result.ok) continue;
      const crlf = text.includes('\r\n');
      expect(result.value.change, name).toBe('replaced');
      expect(result.value.text.slice(0, begin), name).toBe(text.slice(0, begin));
      expect(result.value.text.endsWith(text.slice(end)), name).toBe(true);
      const inserted = result.value.text.slice(begin, result.value.text.length - (text.length - end));
      expect(inserted, name).toBe(crlf ? AGENTS_BLOCK.replaceAll('\n', '\r\n') : AGENTS_BLOCK);
      // Nothing but CRLF in a CRLF file.
      if (crlf) expect(result.value.text.replaceAll('\r\n', '')).not.toContain('\n');
    }
  });

  it('is unchanged the second time, to the byte', () => {
    for (const [name, text] of variants()) {
      const once = syncAgents(text, AGENTS_BLOCK);
      if (!once.ok) throw new Error(name);
      const twice = syncAgents(once.value.text, AGENTS_BLOCK);
      expect(twice.ok && twice.value.change, name).toBe('unchanged');
      expect(twice.ok && twice.value.text, name).toBe(once.value.text);
    }
    const run = sync({});
    const again = sync({ 'AGENTS.md': run.agents!, 'CLAUDE.md': run.claude! });
    expect(again.agents).toBe(run.agents);
    expect(again.lines).toEqual(['✓ The block of AGENTS.md is current.']);
  });

  it('appends the block to a file without marks, with a blank line between', () => {
    expect(sync({ 'AGENTS.md': '# Mine\n' }).agents).toBe(`# Mine\n\n${AGENTS_BLOCK}\n`);
    expect(sync({ 'AGENTS.md': '# Mine' }).agents).toBe(`# Mine\n\n${AGENTS_BLOCK}\n`);
    expect(sync({ 'AGENTS.md': '# Mine\r\n' }).agents).toBe(`# Mine\r\n\r\n${AGENTS_BLOCK.replaceAll('\n', '\r\n')}\r\n`);
    expect(sync({ 'AGENTS.md': '' }).agents).toBe(`${AGENTS_BLOCK}\n`);
  });

  it('keeps a byte order mark in front of line 1 and still finds the marks', () => {
    const bom = '\uFEFF';
    const text = `${bom}${readFileSync(new URL('v1.md', fixtures), 'utf8')}`;
    const result = syncAgents(text, AGENTS_BLOCK);
    expect(result.ok && result.value.change).toBe('replaced');
    expect(result.ok && result.value.text.startsWith(`${bom}# Shop`)).toBe(true);
    const marked = `${bom}${AGENTS_BEGIN}\nold\n${AGENTS_END}\n`;
    expect(syncAgents(marked, AGENTS_BLOCK)).toMatchObject({ ok: true, value: { text: `${bom}${AGENTS_BLOCK}\n` } });
    expect(syncAgents(`${bom}# Mine\n`, AGENTS_BLOCK)).toMatchObject({ ok: true, value: { change: 'appended', text: `${bom}# Mine\n\n${AGENTS_BLOCK}\n` } });
  });

  describe('links', () => {
    const link = (target: string, name: string) => (root: string) => symlinkSync(target, join(root, name));
    function run(prepare: (root: string) => void, options: Record<string, unknown> = {}) {
      const root = realpathSync(tempDir('marmeon-agents-link-'));
      prepare(root);
      const lines: string[] = [];
      const say = (prefix: string) => (line = '') => void lines.push(`${prefix}${line}`);
      const output = { success: say('✓ '), error: say('✗ '), warn: say('! '), line: say('') };
      const code = new AgentsSyncCommand().handle({ root, args: [], options, output, spawn: async () => 0 } as never);
      return { root, code, lines };
    }

    it('refuses a dead link as AGENTS.md or CLAUDE.md, with nothing written', () => {
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        for (const options of [{}, { check: true }]) {
          const { root, code, lines } = run(link('nowhere.md', name), options);
          expect(code, name).toBe(1);
          expect(lines).toHaveLength(1);
          expect(lines[0]).toContain(`${name} is a link that leads nowhere`);
          expect(existsSync(join(root, name === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md'))).toBe(false);
        }
      }
    });

    it('refuses a directory as AGENTS.md or CLAUDE.md, with nothing written', () => {
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        for (const options of [{}, { check: true }]) {
          const { root, code, lines } = run((dir) => mkdirSync(join(dir, name)), options);
          expect(code, name).toBe(1);
          expect(lines).toEqual([`✗ ${name} is not a file. Nothing was written.`]);
          expect(existsSync(join(root, name === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md'))).toBe(false);
        }
      }
    });

    it.skipIf(process.getuid?.() === 0)('refuses an AGENTS.md or CLAUDE.md that cannot be read, with nothing written', () => {
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        for (const options of [{}, { check: true }]) {
          const { root, code, lines } = run((dir) => {
            writeFileSync(join(dir, name), '# mine\n', { mode: 0 });
            chmodSync(join(dir, name), 0);
          }, options);
          expect(code, name).toBe(1);
          expect(lines).toEqual([`✗ ${name} cannot be read. Nothing was written.`]);
          expect(existsSync(join(root, name === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md'))).toBe(false);
        }
      }
    });

    it('refuses a link that leaves the app, and writes nothing through it', () => {
      const outside = realpathSync(tempDir('marmeon-agents-outside-'));
      writeFileSync(join(outside, 'target.md'), 'not yours\n');
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        const { root, code, lines } = run(link(join(outside, 'target.md'), name));
        expect(code, name).toBe(1);
        expect(lines[0]).toContain('outside the app');
        expect(readFileSync(join(outside, 'target.md'), 'utf8')).toBe('not yours\n');
        expect(existsSync(join(root, name === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md'))).toBe(false);
      }
    });

    it('writes through a link that stays inside the app', () => {
      const { root, code } = run((app) => {
        mkdirSync(join(app, 'docs'));
        writeFileSync(join(app, 'docs/agents.md'), '# Mine\n');
        symlinkSync('docs/agents.md', join(app, 'AGENTS.md'));
      });
      expect(code).toBe(0);
      expect(readFileSync(join(root, 'docs/agents.md'), 'utf8')).toBe(`# Mine\n\n${AGENTS_BLOCK}\n`);
    });
  });

  it('leaves a CLAUDE.md that does not import AGENTS.md, and says so', () => {
    const { code, claude, lines } = sync({ 'CLAUDE.md': '# My own\n' });
    expect(code).toBe(0);
    expect(claude).toBe('# My own\n');
    expect(lines.some((line) => line.startsWith('! CLAUDE.md does not import AGENTS.md') && line.includes('"@AGENTS.md"'))).toBe(true);
    expect(sync({ 'CLAUDE.md': '# Mine\n\n@AGENTS.md\n' }).lines.some((line) => line.startsWith('!'))).toBe(false);
  });

  describe('refuses a file whose marks it cannot trust, and writes nothing', () => {
    const cases: Record<string, string> = {
      'a begin without an end': `# A\n\n${AGENTS_BEGIN}\ntext\n`,
      'an end without a begin': `# A\n\n${AGENTS_END}\n`,
      'two blocks': `${AGENTS_BEGIN}\na\n${AGENTS_END}\n\n${AGENTS_BEGIN}\nb\n${AGENTS_END}\n`,
      'the end before the begin': `${AGENTS_END}\nmine\n${AGENTS_BEGIN}\n`,
      'a newer version of the marks': `# A\n\n<!-- marmeon:begin v${AGENTS_BLOCK_FORMAT + 1} -->\nnew\n${AGENTS_END}\n`,
      'a mark that is none of the two forms': `# A\n\n<!-- marmeon:begin -->\ntext\n${AGENTS_END}\n`,
    };
    for (const [name, text] of Object.entries(cases)) {
      it(name, () => {
        for (const options of [{}, { check: true }]) {
          const result = sync({ 'AGENTS.md': text }, options);
          expect(result.code).toBe(1);
          expect(result.agents).toBe(text);
          expect(result.claude).toBeUndefined();
          expect(result.lines).toHaveLength(1);
          expect(result.lines[0]).toMatch(/^✗ AGENTS\.md was left as it is: /);
        }
      });
    }

    it('names the newer version', () => {
      expect(sync({ 'AGENTS.md': cases['a newer version of the marks']! }).lines[0]).toContain('marked v2');
    });
  });

  describe('--check', () => {
    it('exits 1 for an out-of-date block and writes nothing', () => {
      const text = readFileSync(new URL('v1.md', fixtures), 'utf8');
      const { code, agents, claude, lines } = sync({ 'AGENTS.md': text }, { check: true });
      expect(code).toBe(1);
      expect(agents).toBe(text);
      expect(claude).toBeUndefined();
      expect(lines).toEqual(['✗ The block of AGENTS.md is out of date. Run marmeon agents:sync.']);
    });

    it('exits 1 for a missing block or file and writes nothing', () => {
      for (const files of [{ 'AGENTS.md': '# Mine\n' }, {} as Record<string, string>]) {
        const { code, agents, claude, lines } = sync(files, { check: true });
        expect(code).toBe(1);
        expect(agents).toBe(files['AGENTS.md']);
        expect(claude).toBeUndefined();
        expect(lines).toEqual(['✗ AGENTS.md has no block of marmeon. Run marmeon agents:sync.']);
      }
    });

    it('exits 0 for a current block', () => {
      const current = sync({}).agents!;
      const { code, lines } = sync({ 'AGENTS.md': current }, { check: true });
      expect(code).toBe(0);
      expect(lines).toEqual(['✓ The block of AGENTS.md is current.']);
    });
  });

  it('runs without booting the app', () => {
    expect(AgentsSyncCommand.boots).toBe(false);
    expect(BUILT_IN).toContain(AgentsSyncCommand);
  });
});

describe('the block', () => {
  /** Every `static command = '…'` of the code of a package, tests aside: the names `marmeon <command>` can mean. */
  function commandNames(): Set<string> {
    // `list` and `help` are answered by marmeon itself, no class has them.
    const names = new Set(['list', 'help', ...BUILT_IN.map((command) => command.command)]);
    for (const entry of readdirSync(join(repo, 'packages'), { withFileTypes: true })) {
      const src = join(repo, 'packages', entry.name, 'src');
      if (!entry.isDirectory() || !existsSync(src)) continue;
      for (const file of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
        if (!file.endsWith('.ts') || /\.(?:test|type-test)\.ts$|__fixtures__/.test(file)) continue;
        for (const [, name] of readFileSync(join(src, file), 'utf8').matchAll(/static command = '([^']+)'/g)) names.add(name!);
      }
    }
    return names;
  }

  it('names only commands that exist', () => {
    const named = [...AGENTS_BLOCK.matchAll(/`marmeon ([a-z][a-z0-9:-]*)/g)].map((match) => match[1]!);
    expect(named).toEqual(expect.arrayContaining(['check', 'migrate', 'route:types', 'list', 'agents:sync']));
    const known = commandNames();
    expect(named.filter((name) => !known.has(name))).toEqual([]);
  });

  it('points at the documentation of the installed version, then at the website', () => {
    expect(AGENTS_BLOCK).toContain('`node_modules/marmeon/docs/`');
    expect(AGENTS_BLOCK).toContain('`marmeon docs <page>`');
    expect(AGENTS_BLOCK).toContain('`marmeon docs errors` (section "Server error codes")');
    expect(AGENTS_BLOCK).toContain('https://marmeon.com/docs');
    expect(AGENTS_BLOCK).toContain('`marmeon make:resource <Name>`');
  });

  it('sends an agent with a whole task to its recipe', () => {
    expect(AGENTS_BLOCK).toContain('start with its\n  recipe: `marmeon docs` lists them under "Recipes"; each names the generators, the files and the test.');
    expect(AGENTS_BLOCK.indexOf('start with its')).toBeGreaterThan(AGENTS_BLOCK.indexOf('## Documentation'));
    expect(AGENTS_BLOCK.indexOf('start with its')).toBeLessThan(AGENTS_BLOCK.indexOf('## After a change'));
  });

  it('keeps the rule about silencing a finding', () => {
    expect(AGENTS_BLOCK).toContain('// marmeon-check-ignore <check>: <why it is safe>` (docs/check.md#silencing-a-finding), and tell the user');
  });

  it('is fenced by its own marks, with \\n line ends, and is short', () => {
    const lines = AGENTS_BLOCK.split('\n');
    expect(lines[0]).toBe(AGENTS_BEGIN);
    expect(lines.at(-1)).toBe(AGENTS_END);
    expect(AGENTS_BLOCK).not.toContain('\r');
    expect(lines.length).toBeLessThanOrEqual(40);
    expect(lines.filter((line) => line.startsWith('<!-- marmeon:'))).toHaveLength(2);
  });
});

describe('marmeon agents:sync in an app of its own', { timeout: 30_000 }, () => {
  const blank = join(repo, 'apps/blank-app');

  function appWithCommand(name: string): string {
    const app = realpathSync(tempDir('marmeon-agents-names-'));
    cpSync(blank, app, { recursive: true, filter: (source) => !/[/\\](node_modules|\.marmeon|storage|dist)([/\\]|$)/.test(source.slice(blank.length)) && !/[/\\]\.env$/.test(source) });
    symlinkSync(join(blank, 'node_modules'), join(app, 'node_modules'), 'dir');
    mkdirSync(join(app, 'storage'));
    writeFileSync(join(app, 'modules/system/Ours.ts'), `export class OursCommand {\n  static command = '${name}';\n  static description = 'Ours';\n  handle() {\n    console.log('OURS RAN');\n  }\n}\n`);
    writeFileSync(
      join(app, 'modules/system/index.ts'),
      "import { defineModule } from '@marmeon/core';\nimport { OursCommand } from './Ours.ts';\nexport default defineModule({ name: 'system', commands: [OursCommand], migrations: new URL('./migrations/', import.meta.url) });\n",
    );
    return app;
  }

  it('is listed and writes the files', () => {
    const app = appWithCommand('ours:run');
    expect(marmeon(app, ['list']).stdout).toContain('agents:sync');
    const { code, stdout } = marmeon(app, ['agents:sync']);
    expect(code).toBe(0);
    expect(stdout).toContain('Wrote AGENTS.md.');
    expect(readFileSync(join(app, 'AGENTS.md'), 'utf8')).toContain(AGENTS_BLOCK);
    expect(readFileSync(join(app, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
    expect(marmeon(app, ['agents:sync', '--check']).code).toBe(0);
  });

  it('stops every other command of an app that has a command of its own with that name, and agents:sync itself still runs', () => {
    const app = appWithCommand('agents:sync');
    for (const args of [['list'], ['route:list']]) {
      const { code, stdout, stderr } = marmeon(app, args);
      expect(code, args.join(' ')).toBe(1);
      expect(stderr, args.join(' ')).toContain('Two commands are named "agents:sync": AgentsSyncCommand (marmeon) and OursCommand (module system)');
      expect(stderr).toContain('[marmeon:K8]');
      expect(stdout).not.toContain('OURS RAN');
    }
    // It boots nothing, so it never meets the clash: the app's own command is shadowed, not run.
    const { code, stdout } = marmeon(app, ['agents:sync']);
    expect(code).toBe(0);
    expect(stdout).not.toContain('OURS RAN');
    expect(existsSync(join(app, 'AGENTS.md'))).toBe(true);
  });
});
