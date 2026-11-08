import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { installedTools } from './agents/install.ts';
import { AGENTS_BLOCK, agentsBlock, NO_TOOLS } from './agents/block.ts';
import { AgentsSyncCommand } from './commands/agents-sync.ts';
import { BUILT_IN } from './built-in.ts';
import { AgentsInstallCommand } from './commands/agents-install.ts';
import { mergeMcpJson } from './agents/mcp-json.ts';
import { shippedSkills } from './agents/skills.ts';
import { Output } from './output.ts';

const skills = shippedSkills();
const ENTRY = { command: 'node', args: ['node_modules/marmeon/bin/marmeon.js', 'mcp'] };

/** Every file and link under `root` with its content or target: the tree as it is, to compare before and after. */
function tree(root: string): Record<string, string> {
  const all: Record<string, string> = {};
  for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    const path = join(root, file);
    const stat = lstatSync(path);
    all[file] = stat.isSymbolicLink() ? `-> ${readlinkSync(path)}` : stat.isDirectory() ? '/' : readFileSync(path, 'utf8');
  }
  return all;
}

function put(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
}

function app(files: Record<string, string> = {}): string {
  const root = realpathSync(tempDir('marmeon-install-'));
  put(root, files);
  return root;
}

function install(root: string, options: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const say = (prefix: string) => (line = '') => void lines.push(`${prefix}${line}`);
  const output = { success: say('✓ '), error: say('✗ '), warn: say('! '), line: say('') };
  const code = new AgentsInstallCommand().handle({ root, args: [], options, output, spawn: async () => 0 } as never) as number;
  return { code, lines, text: lines.join('\n') };
}

const markedSkill = (mark: string, body = 'old') => `---\nname: marmeon-migration\ndescription: x\nmetadata:\n  marmeon-skill: "${mark}"\n---\n${body}\n`;

describe('marmeon agents:install', () => {
  it('is a built-in command with its options', () => {
    expect(BUILT_IN).toContain(AgentsInstallCommand);
    expect(Object.keys(AgentsInstallCommand.options).sort()).toEqual(['check', 'no-mcp', 'shared']);
    expect(AgentsInstallCommand.boots).toBe(false);
  });

  it('makes the skills and .mcp.json in an empty app, and a second run changes nothing', () => {
    const root = app();
    const first = install(root);
    expect(first.code).toBe(0);
    for (const skill of skills) expect(readFileSync(join(root, '.claude/skills', skill.name, 'SKILL.md'), 'utf8')).toBe(skill.text);
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(`${JSON.stringify({ mcpServers: { marmeon: ENTRY } }, null, 2)}\n`);
    expect(first.text).toContain('approve the server marmeon');
    expect(existsSync(join(root, '.agents'))).toBe(false);
    const before = tree(root);
    const second = install(root);
    expect(second.code).toBe(0);
    expect(second.text).toContain('current');
    expect(second.text).not.toContain('approve');
    expect(tree(root)).toEqual(before);
    expect(install(root, { check: true }).code).toBe(0);
    expect(readdirSync(join(root, '.claude/skills')).sort()).toEqual(skills.map((skill) => skill.name));
  });

  it('leaves no temporary file beside what it wrote', () => {
    const root = app();
    install(root);
    expect(Object.keys(tree(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('installs into .agents/skills with --shared, and a later run without it updates there', () => {
    const root = app();
    expect(install(root, { shared: true }).code).toBe(0);
    for (const skill of skills) expect(readFileSync(join(root, '.agents/skills', skill.name, 'SKILL.md'), 'utf8')).toBe(skill.text);
    expect(existsSync(join(root, '.claude'))).toBe(false);
    writeFileSync(join(root, '.agents/skills/marmeon-migration/SKILL.md'), markedSkill('1'));
    const again = install(root);
    expect(again.code).toBe(0);
    expect(again.text).toContain('Updated .agents/skills/marmeon-migration/SKILL.md.');
    expect(readFileSync(join(root, '.agents/skills/marmeon-migration/SKILL.md'), 'utf8')).toBe(skills.find((skill) => skill.name === 'marmeon-migration')!.text);
    expect(existsSync(join(root, '.claude'))).toBe(false);
  });

  it('warns, and does not move the skills, when --shared meets skills in .claude/skills', () => {
    const root = app();
    install(root);
    const result = install(root, { shared: true });
    expect(result.code).toBe(0);
    expect(result.text).toContain('--shared was ignored');
    expect(existsSync(join(root, '.agents'))).toBe(false);
  });

  it('updates both folders when both hold skills with the mark', () => {
    const root = app();
    install(root);
    install(root, { shared: true }); // warned, no move
    put(root, { '.agents/skills/marmeon-migration/SKILL.md': markedSkill('1') });
    put(root, { '.claude/skills/marmeon-migration/SKILL.md': markedSkill('1') });
    install(root);
    const current = skills.find((skill) => skill.name === 'marmeon-migration')!.text;
    expect(readFileSync(join(root, '.agents/skills/marmeon-migration/SKILL.md'), 'utf8')).toBe(current);
    expect(readFileSync(join(root, '.claude/skills/marmeon-migration/SKILL.md'), 'utf8')).toBe(current);
    expect(existsSync(join(root, '.agents/skills/marmeon-feature-module/SKILL.md'))).toBe(true);
  });

  it('writes no .mcp.json with --no-mcp', () => {
    const root = app();
    expect(install(root, { 'no-mcp': true }).code).toBe(0);
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
    expect(existsSync(join(root, '.claude/skills/marmeon-migration/SKILL.md'))).toBe(true);
  });

  it('adds marmeon to an existing .mcp.json and keeps the entries, the keys, the indentation and the CRLF', () => {
    const original = { mcpServers: { db: { command: 'db-mcp', args: ['--x'] } }, other: 1 };
    const crlf = (text: string) => text.replaceAll('\n', '\r\n');
    const root = app({ '.mcp.json': crlf(`${JSON.stringify(original, null, 4)}\n`) });
    expect(install(root).code).toBe(0);
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(crlf(`${JSON.stringify({ ...original, mcpServers: { ...original.mcpServers, marmeon: ENTRY } }, null, 4)}\n`));
  });

  it('keeps a tab indent and a byte order mark', () => {
    const root = app({ '.mcp.json': `\uFEFF${JSON.stringify({ mcpServers: {} }, null, '\t')}\n` });
    install(root);
    const text = readFileSync(join(root, '.mcp.json'), 'utf8');
    expect(text.startsWith('\uFEFF{\n\t"mcpServers"')).toBe(true);
    expect(JSON.parse(text.slice(1)).mcpServers.marmeon).toEqual(ENTRY);
  });

  it('puts a missing mcpServers at the end of the file and keeps the other keys', () => {
    const root = app({ '.mcp.json': '{\n  "a": 1\n}\n' });
    install(root);
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(`${JSON.stringify({ a: 1, mcpServers: { marmeon: ENTRY } }, null, 2)}\n`);
  });

  it('replaces another entry named marmeon, says so, and keeps the order of the entries', () => {
    const root = app({ '.mcp.json': JSON.stringify({ mcpServers: { a: {}, marmeon: { command: 'other' }, z: {} } }, null, 2) });
    const result = install(root);
    expect(result.text).toContain('Replaced the entry marmeon in .mcp.json (it belongs to marmeon agents:install).');
    const parsed = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    expect(Object.keys(parsed.mcpServers)).toEqual(['a', 'marmeon', 'z']);
    expect(parsed.mcpServers.marmeon).toEqual(ENTRY);
  });

  it('writes nothing when the entry is current, whatever the formatting of the file', () => {
    const text = `{"mcpServers":{"marmeon":${JSON.stringify(ENTRY)}}}`;
    const root = app({ '.mcp.json': text });
    install(root, { shared: true });
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(text);
  });

  it('reads every fixture of the entry: the newest is current, each older one is ours and is updated', () => {
    const directory = new URL('./__fixtures__/formats/agents-mcp-json/', import.meta.url);
    const versions = readdirSync(directory)
      .filter((name) => /^v\d+\.json$/.test(name))
      .sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));
    expect(versions.length).toBeGreaterThan(0);
    for (const [index, name] of versions.entries()) {
      const entry = JSON.parse(readFileSync(new URL(name, directory), 'utf8'));
      const result = mergeMcpJson(JSON.stringify({ mcpServers: { marmeon: entry } }));
      expect(result.ok, name).toBe(true);
      if (!result.ok) continue;
      if (index === versions.length - 1) {
        expect(entry).toEqual(ENTRY);
        expect(result.value.change).toBe('unchanged');
      } else {
        expect(result.value.change).toBe('update');
      }
    }
  });

  it.skipIf(process.getuid?.() === 0)('refuses, before the first write, a SKILL.md that is a link to a file in a read-only folder', () => {
    const root = app({ 'own/migration.md': markedSkill('1') });
    mkdirSync(join(root, '.claude/skills/marmeon-migration'), { recursive: true });
    symlinkSync(join(root, 'own/migration.md'), join(root, '.claude/skills/marmeon-migration/SKILL.md'));
    chmodSync(join(root, 'own'), 0o500);
    onTestFinished(() => chmodSync(join(root, 'own'), 0o700));
    const before = tree(root);
    const result = install(root);
    expect(result.code).toBe(1);
    expect(result.text).toContain('own is not writable. Nothing was written.');
    expect(tree(root)).toEqual(before);
  });

  it('replaces an outdated SKILL.md with the mark and leaves another file of the folder', () => {
    const root = app({ '.claude/skills/marmeon-migration/SKILL.md': markedSkill('1'), '.claude/skills/marmeon-migration/notes.md': 'mine\n' });
    expect(install(root).code).toBe(0);
    expect(readFileSync(join(root, '.claude/skills/marmeon-migration/SKILL.md'), 'utf8')).toBe(skills.find((skill) => skill.name === 'marmeon-migration')!.text);
    expect(readFileSync(join(root, '.claude/skills/marmeon-migration/notes.md'), 'utf8')).toBe('mine\n');
  });

  it('keeps the permissions of a file it replaces', () => {
    const root = app({ '.mcp.json': '{}' });
    chmodSync(join(root, '.mcp.json'), 0o600);
    install(root);
    expect(statSync(join(root, '.mcp.json')).mode & 0o777).toBe(0o600);
  });

  it('reports a skill it no longer ships and leaves it', () => {
    const root = app({ '.claude/skills/marmeon-old/SKILL.md': markedSkill('1', 'retired'), '.claude/skills/my-own/SKILL.md': 'mine' });
    const result = install(root);
    expect(result.code).toBe(0);
    expect(result.text).toContain('.claude/skills/marmeon-old');
    expect(readFileSync(join(root, '.claude/skills/marmeon-old/SKILL.md'), 'utf8')).toContain('retired');
    expect(readFileSync(join(root, '.claude/skills/my-own/SKILL.md'), 'utf8')).toBe('mine');
  });

  describe('prints nothing a terminal would obey', () => {
    afterEach(() => vi.restoreAllMocks());

    /** The run with the real `Output`, so what the command prints is judged as the terminal gets it. */
    function printed(root: string, options: Record<string, unknown> = {}) {
      const written: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => void written.push(text)) as never);
      vi.spyOn(process.stderr, 'write').mockImplementation(((text: string) => void written.push(text)) as never);
      const code = new AgentsInstallCommand().handle({ root, args: [], options, output: new Output(), spawn: async () => 0 } as never) as number;
      return { code, text: written.join('') };
    }
    // oxlint-disable-next-line no-control-regex -- control characters are what the test looks for
    const noControl = (text: string) => expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e]/);

    it('in the name of a skill folder it no longer ships', () => {
      const name = 'marmeon-\x1b]52;c;aGk=\x07\u202e\x9bx';
      const root = app({ [`.claude/skills/${name}/SKILL.md`]: markedSkill('1', 'retired') });
      const result = printed(root);
      expect(result.code).toBe(0);
      noControl(result.text);
      expect(result.text).toContain('\\u001b]52;c;aGk=\\u0007');
      expect(result.text).toContain('\\u202e\\u009bx');
    });

    it('in a folder name with a line feed, which cannot forge a line', (ctx) => {
      const name = 'marmeon-x\n! forged line';
      const root = app();
      try {
        put(root, { [`.claude/skills/${name}/SKILL.md`]: markedSkill('1', 'retired') });
      } catch {
        // Some file systems refuse a line feed in a name; there is then nothing to print.
        ctx.skip();
      }
      const result = printed(root);
      expect(result.text.split('\n').filter((line) => line.startsWith('! forged'))).toEqual([]);
      expect(result.text).toContain('marmeon-x\\n! forged line');
    });

    it('in the message about a .mcp.json that does not parse', () => {
      const root = app({ '.mcp.json': '{ "mcpServers": \x1b]52;c;aGk=\x07\u202e }' });
      const result = printed(root);
      expect(result.code).toBe(1);
      noControl(result.text);
      expect(result.text).toContain('is not valid JSON');
      expect(result.text).toContain('\\u001b]52;c;aGk');
    });
  });

  it('writes through a link that stays inside the app and leaves the link a link', () => {
    const root = app({ 'elsewhere/keep': '1' });
    symlinkSync(join(root, 'elsewhere'), join(root, '.claude'));
    expect(install(root).code).toBe(0);
    expect(lstatSync(join(root, '.claude')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, 'elsewhere/skills/marmeon-migration/SKILL.md'), 'utf8')).toBe(skills.find((skill) => skill.name === 'marmeon-migration')!.text);
  });

  it('writes a SKILL.md that is a link inside the app to where it leads, not over the link', () => {
    const root = app({ 'own/migration.md': markedSkill('1') });
    mkdirSync(join(root, '.claude/skills/marmeon-migration'), { recursive: true });
    symlinkSync(join(root, 'own/migration.md'), join(root, '.claude/skills/marmeon-migration/SKILL.md'));
    expect(install(root).code).toBe(0);
    expect(lstatSync(join(root, '.claude/skills/marmeon-migration/SKILL.md')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, 'own/migration.md'), 'utf8')).toBe(skills.find((skill) => skill.name === 'marmeon-migration')!.text);
  });

  it('writes once when .claude/skills is a link to .agents/skills', () => {
    const root = app();
    install(root, { shared: true });
    mkdirSync(join(root, '.claude'));
    symlinkSync(join(root, '.agents/skills'), join(root, '.claude/skills'));
    writeFileSync(join(root, '.agents/skills/marmeon-migration/SKILL.md'), markedSkill('1'));
    const result = install(root);
    expect(result.code).toBe(0);
    expect(result.lines.filter((line) => line.includes('marmeon-migration'))).toHaveLength(1);
    expect(readFileSync(join(root, '.agents/skills/marmeon-migration/SKILL.md'), 'utf8')).toBe(skills.find((skill) => skill.name === 'marmeon-migration')!.text);
  });

  it('counts a skill as current when a checkout turned its line ends or added a byte order mark', () => {
    const root = app();
    install(root);
    const file = join(root, '.claude/skills/marmeon-migration/SKILL.md');
    const text = skills.find((skill) => skill.name === 'marmeon-migration')!.text;
    for (const variant of [text.replaceAll('\n', '\r\n'), `\uFEFF${text}`, `\uFEFF${text.replaceAll('\n', '\r\n')}`]) {
      writeFileSync(file, variant);
      expect(install(root, { check: true }).code).toBe(0);
      expect(install(root).code).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe(variant);
    }
  });

  it('leaves .mcp.json out of a later run and of --check when the skills were installed with --no-mcp', () => {
    const root = app();
    install(root, { 'no-mcp': true });
    expect(install(root, { check: true }).code).toBe(0);
    expect(install(root).code).toBe(0);
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
  });

  it('keeps a .mcp.json that has no entry marmeon as it is once the skills are installed', () => {
    const text = '{"mcpServers":{"db":{}}}';
    const root = app({ '.mcp.json': text });
    install(root, { 'no-mcp': true });
    expect(install(root).code).toBe(0);
    expect(install(root, { check: true }).code).toBe(0);
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(text);
  });

  it('ignores an unreadable .mcp.json once the skills are installed without it', () => {
    const outside = realpathSync(tempDir('marmeon-install-outside-'));
    const root = app();
    install(root, { 'no-mcp': true });
    symlinkSync(join(outside, 'nope'), join(root, '.mcp.json'));
    expect(install(root).code).toBe(0);
  });

  it('does not touch an entry marmeon with --no-mcp', () => {
    const text = JSON.stringify({ mcpServers: { marmeon: { command: 'mine' } } });
    const root = app({ '.mcp.json': text });
    install(root, { 'no-mcp': true });
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(text);
  });

  it.skipIf(process.getuid?.() === 0)('refuses before the first write when a folder cannot be written', () => {
    const root = app({ '.mcp.json': '{}' });
    mkdirSync(join(root, '.claude'));
    chmodSync(join(root, '.claude'), 0o500);
    try {
      const before = tree(root);
      const result = install(root);
      expect(result.code).toBe(1);
      expect(result.text).toContain('.claude is not writable. Nothing was written.');
      expect(tree(root)).toEqual(before);
    } finally {
      chmodSync(join(root, '.claude'), 0o700);
    }
  });

  it('finds skill folders that are links inside the app, so a later run does not add .mcp.json', () => {
    const root = app();
    install(root, { 'no-mcp': true });
    for (const skill of skills) {
      mkdirSync(join(root, 'store'), { recursive: true });
      renameSync(join(root, '.claude/skills', skill.name), join(root, 'store', skill.name));
      symlinkSync(join(root, 'store', skill.name), join(root, '.claude/skills', skill.name));
    }
    expect(install(root).code).toBe(0);
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
    expect(install(root, { check: true }).code).toBe(0);
  });

  it('does not warn that --shared was ignored when .claude/skills is a link to .agents/skills', () => {
    const root = app();
    install(root, { shared: true });
    mkdirSync(join(root, '.claude'));
    symlinkSync(join(root, '.agents/skills'), join(root, '.claude/skills'));
    const result = install(root, { shared: true });
    expect(result.code).toBe(0);
    expect(result.text).not.toContain('--shared was ignored');
  });

  it.skipIf(process.getuid?.() === 0)('writes none of the files when a later one cannot be written', () => {
    const root = app();
    install(root);
    for (const name of ['marmeon-feature-module', 'marmeon-migration']) writeFileSync(join(root, '.claude/skills', name, 'SKILL.md'), markedSkill('1').replace('marmeon-migration', name));
    chmodSync(join(root, '.claude/skills/marmeon-migration'), 0o500);
    try {
      const before = tree(root);
      const result = install(root);
      expect(result.code).toBe(1);
      expect(result.text).toContain('.claude/skills/marmeon-migration is not writable. Nothing was written.');
      expect(tree(root)).toEqual(before);
    } finally {
      chmodSync(join(root, '.claude/skills/marmeon-migration'), 0o700);
    }
  });

  it('refuses a link that leads nowhere on the path of a skill, and writes nothing', () => {
    const root = app({ '.claude/skills/marmeon-feature-module/SKILL.md': markedSkill('1') });
    symlinkSync('./missing', join(root, '.claude/skills/marmeon-migration'));
    const before = tree(root);
    const result = install(root);
    expect(result.code).toBe(1);
    expect(result.text).toContain('leads nowhere');
    expect(tree(root)).toEqual(before);
  });

  describe('--check', () => {
    it('exits with 1 and writes nothing when a skill is out of date', () => {
      const root = app();
      install(root);
      writeFileSync(join(root, '.claude/skills/marmeon-migration/SKILL.md'), markedSkill('1'));
      const before = tree(root);
      const result = install(root, { check: true });
      expect(result.code).toBe(1);
      expect(result.text).toContain('.claude/skills/marmeon-migration/SKILL.md is out of date.');
      expect(tree(root)).toEqual(before);
    });

    it('exits with 1 when nothing is installed, and writes nothing', () => {
      const root = app({ 'package.json': '{}' });
      const result = install(root, { check: true });
      expect(result.code).toBe(1);
      expect(result.text).toContain('Not installed. Run marmeon agents:install.');
      expect(tree(root)).toEqual({ 'package.json': '{}' });
    });

    it('exits with 1 when the entry of .mcp.json differs', () => {
      const root = app();
      install(root);
      writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { marmeon: { command: 'x' } } }));
      const result = install(root, { check: true });
      expect(result.code).toBe(1);
      expect(result.text).toContain('.mcp.json is out of date.');
    });

    it('does not ask for skills that were never installed when only the entry is there', () => {
      const root = app({ '.mcp.json': JSON.stringify({ mcpServers: { marmeon: ENTRY } }) });
      expect(install(root, { check: true }).code).toBe(0);
      expect(existsSync(join(root, '.claude'))).toBe(false);
    });

    it('lets --no-mcp ignore .mcp.json', () => {
      const root = app();
      install(root, { 'no-mcp': true });
      expect(install(root, { check: true, 'no-mcp': true }).code).toBe(0);
    });
  });

  describe('refuses, and writes nothing, when', () => {
    /** Runs the command on `root`, expects a refusal and an unchanged tree (and no change outside). */
    function refused(root: string, expected: string | RegExp, options: Record<string, unknown> = {}, outside?: string) {
      const before = tree(root);
      const beforeOutside = outside ? tree(outside) : undefined;
      const result = install(root, options);
      expect(result.code).toBe(1);
      expect(result.text).toMatch(expected);
      expect(result.text).toContain('Nothing was written.');
      expect(tree(root)).toEqual(before);
      if (outside) expect(tree(outside)).toEqual(beforeOutside);
    }

    it('.claude is a link to a place outside the app', () => {
      const outside = realpathSync(tempDir('marmeon-install-outside-'));
      const root = app();
      symlinkSync(outside, join(root, '.claude'));
      refused(root, /\.claude is a link/, {}, outside);
      expect(readdirSync(outside)).toEqual([]);
    });

    it('a skill folder is a link to the outside', () => {
      const outside = realpathSync(tempDir('marmeon-install-outside-'));
      const root = app({ '.claude/skills/other/SKILL.md': 'x' });
      symlinkSync(outside, join(root, '.claude/skills/marmeon-migration'));
      refused(root, /marmeon-migration is a link/, {}, outside);
    });

    it('a SKILL.md is a link to the outside', () => {
      const outside = realpathSync(tempDir('marmeon-install-outside-'));
      writeFileSync(join(outside, 'bashrc'), 'precious\n');
      const root = app({ '.claude/skills/marmeon-feature-module/SKILL.md': markedSkill('1') });
      mkdirSync(join(root, '.claude/skills/marmeon-migration'));
      symlinkSync(join(outside, 'bashrc'), join(root, '.claude/skills/marmeon-migration/SKILL.md'));
      refused(root, /SKILL\.md is a link/, {}, outside);
      expect(readFileSync(join(outside, 'bashrc'), 'utf8')).toBe('precious\n');
    });

    it('a SKILL.md is a directory', () => {
      const root = app();
      mkdirSync(join(root, '.claude/skills/marmeon-migration/SKILL.md'), { recursive: true });
      refused(root, /SKILL\.md is not a file/);
    });

    it('.claude/skills is a file', () => {
      const root = app({ '.claude/skills': 'x' });
      refused(root, /\.claude\/skills is not a directory/);
    });

    it('a SKILL.md has no mark (it is a file of the app), and the other skills stay as they are', () => {
      const root = app({ '.claude/skills/marmeon-migration/SKILL.md': '---\nname: marmeon-migration\ndescription: mine\n---\nmine\n', '.claude/skills/marmeon-feature-module/SKILL.md': markedSkill('1') });
      refused(root, /marmeon-migration\/SKILL\.md is not marmeon's/);
    });

    it('a SKILL.md has a malformed mark', () => {
      const root = app({ '.claude/skills/marmeon-migration/SKILL.md': '---\nname: x\nmetadata:\n  marmeon-skill: 1\n---\n' });
      refused(root, /is not marmeon's/);
    });

    it('a SKILL.md has the mark "2"', () => {
      const root = app({ '.claude/skills/marmeon-migration/SKILL.md': markedSkill('2'), '.claude/skills/marmeon-feature-module/SKILL.md': markedSkill('1') });
      refused(root, /format 2, newer than this marmeon writes/);
    });

    for (const [name, content] of [['invalid JSON', '{ "mcpServers": '], ['an array', '[]'], ['a string for mcpServers', '{"mcpServers": "x"}'], ['a null root', 'null'], ['an array for mcpServers', '{"mcpServers": []}']] as const) {
      it(`.mcp.json is ${name}`, () => {
        const root = app({ '.mcp.json': content });
        refused(root, /\.mcp\.json|mcpServers/);
        expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(content);
      });
    }

    it('.mcp.json is a link to the outside', () => {
      const outside = realpathSync(tempDir('marmeon-install-outside-'));
      writeFileSync(join(outside, 'mcp.json'), '{"mcpServers":{}}');
      const root = app();
      symlinkSync(join(outside, 'mcp.json'), join(root, '.mcp.json'));
      refused(root, /\.mcp\.json is a link/, {}, outside);
    });

    it('.mcp.json is a directory', () => {
      const root = app();
      mkdirSync(join(root, '.mcp.json'));
      refused(root, /\.mcp\.json is not a file/);
    });

    it('--check also refuses', () => {
      const outside = realpathSync(tempDir('marmeon-install-outside-'));
      const root = app();
      symlinkSync(outside, join(root, '.claude'));
      refused(root, /is a link/, { check: true });
    });
  });

  it('keeps a key __proto__ of .mcp.json as an ordinary key and leaves Object.prototype alone', () => {
    const result = mergeMcpJson('{"__proto__": {"x": 1}, "mcpServers": {}}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain('"__proto__": {\n    "x": 1\n  }');
    expect(Object.hasOwn(JSON.parse(result.value.text), '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, 'mcpServers')).toBe(false);
  });

  it('keeps a key __proto__ among the servers, and does not rebuild the file with Object.assign', () => {
    const result = mergeMcpJson('{"mcpServers": {"__proto__": {"command": "mine"}, "db": {}}}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const servers = JSON.parse(result.value.text).mcpServers;
    expect(Object.keys(servers)).toEqual(['__proto__', 'db', 'marmeon']);
    expect(Object.getOwnPropertyDescriptor(servers, '__proto__')?.value).toEqual({ command: 'mine' });
  });

  it('does not read mcpServers from the prototype chain', () => {
    const result = mergeMcpJson('{"__proto__": {"mcpServers": "x"}}');
    expect(result.ok).toBe(true);
  });
});

describe('marmeon agents:install and the block of AGENTS.md', () => {
  const blocked = (block = AGENTS_BLOCK) => `# shop\n\n${block}\n\n## This app\n\nMine.\n`;
  const read = (root: string, name: string) => readFileSync(join(root, name), 'utf8');
  const sync = (root: string, check = false) => {
    const lines: string[] = [];
    const say = (prefix: string) => (line = '') => void lines.push(`${prefix}${line}`);
    const output = { success: say('✓ '), error: say('✗ '), warn: say('! '), line: say('') };
    return new AgentsSyncCommand().handle({ root, args: [], options: { check }, output, spawn: async () => 0 } as never) as number;
  };

  it('replaces the plain block by the one for what it installed, the way agents:sync writes it', () => {
    for (const [options, heading, path] of [
      [{}, '## Skills and MCP tools', '.claude/skills/<name>'],
      [{ 'no-mcp': true }, '## Skills\n', '.claude/skills/<name>'],
      [{ shared: true }, '## Skills and MCP tools', '.agents/skills/<name>'],
    ] as const) {
      const root = app({ 'AGENTS.md': blocked() });
      const result = install(root, options);
      expect(result.code).toBe(0);
      expect(result.lines).toContain('✓ Updated the block of AGENTS.md.');
      expect(result.lines.indexOf('✓ Updated the block of AGENTS.md.')).toBeGreaterThan(result.lines.findIndex((line) => line.startsWith('✓ Wrote')));
      expect(read(root, 'AGENTS.md')).toContain(heading);
      expect(read(root, 'AGENTS.md')).toContain(path);
      expect(read(root, 'AGENTS.md')).toContain('## This app\n\nMine.\n');
      expect(sync(root, true)).toBe(0);
      expect(install(root, { ...options, check: true }).code).toBe(0);
    }
  });

  it('prints the lines docs/agents.md shows for a new app', () => {
    const root = app();
    expect(sync(root)).toBe(0);
    const result = install(root);
    expect(result.code).toBe(0);
    const docs = readFileSync(new URL('../../../docs/agents.md', import.meta.url), 'utf8');
    const shown = /pnpm marmeon agents:install\n```\n\n```txt\n([\s\S]*?)\n```/.exec(docs)?.[1];
    expect(shown, 'docs/agents.md shows the output of agents:install').toBeDefined();
    expect(result.text).toBe(shown);
  });

  it('makes no AGENTS.md and adds no block, and says so', () => {
    const root = app();
    const result = install(root);
    expect(result.text).toContain('AGENTS.md has no marmeon block; marmeon agents:sync writes one');
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    const quiet = install(root, { check: true });
    expect(quiet.code).toBe(0);
    expect(quiet.lines.filter((line) => /^[✗!]/.test(line))).toEqual([]);

    const bare = app({ 'AGENTS.md': '# mine\n' });
    install(bare);
    expect(read(bare, 'AGENTS.md')).toBe('# mine\n');
    expect(install(bare).text).toContain('has no marmeon block');
  });

  it('warns, and leaves the file, when its marks are broken; the skills are written anyway', () => {
    const text = `${AGENTS_BLOCK}\n\n${AGENTS_BLOCK}\n`;
    const root = app({ 'AGENTS.md': text });
    const result = install(root);
    expect(result.code).toBe(0);
    expect(result.lines.some((line) => line.startsWith('! '))).toBe(true);
    expect(read(root, 'AGENTS.md')).toBe(text);
    expect(existsSync(join(root, '.claude/skills/marmeon-page/SKILL.md'))).toBe(true);
  });

  it('does not follow AGENTS.md out of the app', () => {
    const outside = realpathSync(tempDir('marmeon-install-outside-'));
    const target = join(outside, 'AGENTS.md');
    writeFileSync(target, blocked());
    const root = app();
    symlinkSync(target, join(root, 'AGENTS.md'));
    for (const options of [{}, { check: true }]) {
      const result = install(root, options);
      expect(result.code).toBe(0);
      expect(result.lines.some((line) => line.startsWith('! ') && line.includes('outside the app'))).toBe(true);
      expect(result.text).not.toContain('Nothing was written');
      expect(readFileSync(target, 'utf8')).toBe(blocked());
    }
  });

  it('under --check, fails on a block that is out of date and writes nothing', () => {
    const root = app();
    install(root);
    writeFileSync(join(root, 'AGENTS.md'), blocked(agentsBlock(NO_TOOLS)));
    const before = tree(root);
    const result = install(root, { check: true });
    expect(result.code).toBe(1);
    expect(result.lines).toEqual(["✗ AGENTS.md's block is out of date.", '✗ Run marmeon agents:install.']);
    expect(tree(root)).toEqual(before);
    expect(sync(root, true)).toBe(1);

    install(root);
    expect(install(root, { check: true }).code).toBe(0);
  });

  it('does not judge the block of an app that installed nothing', () => {
    const root = app({ 'AGENTS.md': blocked() });
    const result = install(root, { check: true });
    expect(result.code).toBe(1);
    expect(result.lines).toEqual(['✗ Not installed. Run marmeon agents:install.']);
  });

  it('refuses, naming no path, when the app cannot be inspected at all', () => {
    const missing = join(app(), 'not-there');
    const result = installedTools(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/could not be read \(\w+\)\. Nothing was written\./);
      expect(result.error.message).not.toContain(missing);
    }
  });
});
