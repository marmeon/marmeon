import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { mergeMcpJson } from '../agents/mcp-json.ts';
import { shippedSkills } from '../agents/skills.ts';
import { AGENTS_BLOCK, agentsBlock } from '../agents/block.ts';
import { installedTools } from '../agents/install.ts';
import { agentsCheck, parseOxlint, plainReason } from './tools.ts';

describe('parseOxlint', () => {
  // The shape `oxlint --format=json` prints (checked against the oxlint in this repository by check.test.ts).
  const document = JSON.stringify({
    diagnostics: [
      { message: '`debugger` statement is not allowed', code: 'eslint(no-debugger)', severity: 'error', help: 'Remove the debugger statement', filename: '/app/src/a.ts', labels: [{ span: { offset: 0, length: 9, line: 4, column: 3 } }] },
      { message: 'Unused', code: 'eslint(no-unused-vars)', severity: 'warning', filename: 'src/b.ts', labels: [] },
    ],
    number_of_files: 2,
  });

  it('maps severity, place and rule, with paths relative to the root', () => {
    expect(parseOxlint(document, '/app')).toEqual([
      { severity: 'error', message: '`debugger` statement is not allowed — Remove the debugger statement', file: 'src/a.ts', line: 4, column: 3, rule: 'eslint(no-debugger)' },
      { severity: 'warning', message: 'Unused', file: 'src/b.ts', rule: 'eslint(no-unused-vars)' },
    ]);
  });

  it('returns undefined for anything that is not the document', () => {
    expect(parseOxlint('not json', '/app')).toBeUndefined();
    expect(parseOxlint('{"other":1}', '/app')).toBeUndefined();
    expect(parseOxlint('null', '/app')).toBeUndefined();
  });
});

describe('plainReason', () => {
  it('writes the app directory as a dot', () => {
    expect(plainReason(new Error('ENOENT: no such file /srv/app/src/a.ts and /srv/app'), '/srv/app')).toBe('ENOENT: no such file ./src/a.ts and .');
  });
});

describe('agentsCheck: the installed skills and the entry in .mcp.json', () => {
  const [first] = shippedSkills();
  const mcp = () => {
    const merged = mergeMcpJson(undefined);
    if (!merged.ok) throw new Error('mergeMcpJson refused an empty file');
    return merged.value.text;
  };

  /** An app with every shipped skill copied into `.claude/skills/` and the entry in `.mcp.json`, then `files` on top. */
  function installed(files: Record<string, string> = {}): string {
    const root = realpathSync(tempDir('marmeon-agents-check-'));
    const all: Record<string, string> = { '.mcp.json': mcp(), ...files };
    for (const skill of shippedSkills()) all[`.claude/skills/${skill.name}/SKILL.md`] ??= skill.text;
    for (const [name, text] of Object.entries(all)) {
      mkdirSync(join(root, name, '..'), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    return root;
  }

  /** Every file under `root`, with its text: a check that wrote something changes this. */
  function snapshot(root: string): string[] {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort()
      .map((file) => `${file}\n${readFileSync(file, 'utf8')}`);
  }

  it('says nothing about a current installation', () => {
    const root = installed();
    expect(agentsCheck(root).report).toMatchObject({ status: 'passed', problems: [] });
    writeFileSync(join(root, 'AGENTS.md'), '');
    const before = snapshot(root);
    expect(agentsCheck(root).report.problems.filter((problem) => problem.fix === 'marmeon agents:install')).toEqual([]);
    expect(snapshot(root)).toEqual(before);
  });

  it('warns about an out-of-date skill with the command that fixes it, and writes nothing', () => {
    const path = `.claude/skills/${first!.name}/SKILL.md`;
    const root = installed({ [path]: first!.text.replace(/\n$/, '\nan older line\n') });
    const before = snapshot(root);
    const { report } = agentsCheck(root);
    expect(report.status).toBe('warning');
    expect(report.problems).toEqual([
      { severity: 'warning', message: `${path} is out of date — marmeon agents:install`, file: path, fix: 'marmeon agents:install', docs: 'docs/agents.md#skills-and-the-mcp-server' },
    ]);
    expect(snapshot(root)).toEqual(before);
  });

  it('warns about a skill that is missing from an installation', () => {
    const root = installed();
    const path = `.claude/skills/${shippedSkills()[1]!.name}/SKILL.md`;
    rmSync(join(root, path));
    expect(agentsCheck(root).report.problems).toEqual([expect.objectContaining({ file: path, fix: 'marmeon agents:install', message: `${path} is missing — marmeon agents:install` })]);
  });

  it('says nothing when nothing is installed, with or without an .mcp.json of the app', () => {
    const root = realpathSync(tempDir('marmeon-agents-check-'));
    expect(agentsCheck(root).report).toMatchObject({ status: 'skipped', problems: [] });
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    expect(agentsCheck(root).report.problems).toEqual([]);
    writeFileSync(join(root, '.mcp.json'), '{ not json');
    expect(agentsCheck(root).report.problems).toEqual([]);
  });

  it('warns about an entry marmeon in .mcp.json that is not the one marmeon writes', () => {
    const root = realpathSync(tempDir('marmeon-agents-check-'));
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { marmeon: { command: 'other' } } }));
    expect(agentsCheck(root).report.problems).toEqual([
      expect.objectContaining({ severity: 'warning', file: '.mcp.json', fix: 'marmeon agents:install', message: '.mcp.json is out of date — marmeon agents:install' }),
    ]);
  });

  it('refuses a link out of the app without reading its target, and offers no fix', () => {
    const outside = realpathSync(tempDir('marmeon-agents-outside-'));
    writeFileSync(join(outside, 'SKILL.md'), 'SECRET-TEXT');
    const root = installed();
    const file = join(root, '.claude/skills', first!.name, 'SKILL.md');
    rmSync(file);
    symlinkSync(join(outside, 'SKILL.md'), file);
    const { report } = agentsCheck(root);
    expect(report.status).toBe('warning');
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ file: `.claude/skills/${first!.name}/SKILL.md` });
    expect(report.problems[0]).not.toHaveProperty('fix');
    expect(JSON.stringify(report)).not.toContain('SECRET-TEXT');
  });

  it('says nothing in an app that installed nothing, whatever lies where the skills would go', () => {
    const outside = realpathSync(tempDir('marmeon-agents-outside-'));
    const linked = realpathSync(tempDir('marmeon-agents-check-'));
    mkdirSync(join(linked, '.claude'));
    symlinkSync(outside, join(linked, '.claude/skills'));
    const file = realpathSync(tempDir('marmeon-agents-check-'));
    mkdirSync(join(file, '.claude'));
    writeFileSync(join(file, '.claude/skills'), 'x');
    const foreign = realpathSync(tempDir('marmeon-agents-check-'));
    mkdirSync(join(foreign, `.claude/skills/${first!.name}`), { recursive: true });
    writeFileSync(join(foreign, `.claude/skills/${first!.name}/SKILL.md`), 'MY-OWN-SKILL');
    for (const root of [linked, file, foreign]) expect(agentsCheck(root).report.problems).toEqual([]);
  });

  it('refuses an unmarked skill of the same name next to installed ones, with the file and without its text', () => {
    const path = `.claude/skills/${first!.name}/SKILL.md`;
    const root = installed({ [path]: 'MY-OWN-SKILL' });
    const { report } = agentsCheck(root);
    expect(report.status).toBe('warning');
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ file: path });
    expect(report.problems[0]).not.toHaveProperty('fix');
    expect(JSON.stringify(report)).not.toContain('MY-OWN-SKILL');
  });

  it('passes a current installation in an app without AGENTS.md', () => {
    expect(agentsCheck(installed()).report).toMatchObject({ status: 'passed', problems: [] });
  });

  it('judges only the entry when only .mcp.json is installed, whatever lies in the skill folders', () => {
    const root = realpathSync(tempDir('marmeon-agents-check-'));
    writeFileSync(join(root, '.mcp.json'), mcp());
    mkdirSync(join(root, '.claude/skills/marmeon-migration'), { recursive: true });
    writeFileSync(join(root, '.claude/skills/marmeon-migration/SKILL.md'), 'MY-OWN-SKILL');
    expect(agentsCheck(root).report.problems).toEqual([]);
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { marmeon: { command: 'other' } } }));
    expect(agentsCheck(root).report.problems).toEqual([expect.objectContaining({ file: '.mcp.json', fix: 'marmeon agents:install' })]);
  });

  it('judges the block against what is installed: the full block passes, the plain one is out of date', () => {
    const root = installed();
    const tools = installedTools(root);
    if (!tools.ok) throw new Error(tools.error.message);
    writeFileSync(join(root, 'AGENTS.md'), `# x\n\n${agentsBlock(tools.value)}\n`);
    expect(agentsCheck(root).report.problems).toEqual([]);
    writeFileSync(join(root, 'AGENTS.md'), `# x\n\n${AGENTS_BLOCK}\n`);
    expect(agentsCheck(root).report.problems).toEqual([
      expect.objectContaining({ file: 'AGENTS.md', message: "AGENTS.md's marmeon block is out of date — marmeon agents:sync" }),
    ]);
  });

  it.skipIf(process.getuid?.() === 0)('warns once, and judges no block, when .mcp.json cannot be read', () => {
    const root = installed();
    writeFileSync(join(root, 'AGENTS.md'), `# x\n\n${AGENTS_BLOCK}\n`);
    chmodSync(join(root, '.mcp.json'), 0o000);
    onTestFinished(() => chmodSync(join(root, '.mcp.json'), 0o600));
    const { report } = agentsCheck(root);
    expect(report.status).toBe('warning');
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]!.message).toContain('".mcp.json" cannot be read');
    expect(JSON.stringify(report)).not.toContain(root);
  });
});
