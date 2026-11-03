import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repo } from './__fixtures__/cli.js';
import { commandNames } from './__fixtures__/commands.ts';
import { shippedSkills, skillMark, SKILL_FORMAT, skillsDirectory } from './agents/skills.ts';
import { headingsOf } from './anchors.ts';
import { TOOLS } from './mcp/tools.ts';

const skills = shippedSkills();
const fixtures = new URL('./__fixtures__/formats/agents-skill/', import.meta.url);

/** The lines between the first two `---` lines, as `[key, rest]` for the top level keys. */
function frontMatter(text: string): { keys: string[]; values: Map<string, string>; lines: number } {
  const lines = text.split('\n');
  expect(lines[0]).toBe('---');
  const end = lines.indexOf('---', 1);
  expect(end).toBeGreaterThan(0);
  const values = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([a-z-]+):[ ]?(.*)$/.exec(line);
    if (match) values.set(match[1]!, match[2]!);
  }
  return { keys: [...values.keys()], values, lines: end };
}

/** The anchors GitHub makes are lower case, so `#Retiring-a-column` or `#a.b` name no heading. */
const SLUG = /^[a-z0-9_-]+$/;

/** The command of every `marmeon <command>` in a skill: in code spans and in code blocks, with or without a package manager in front. */
function commandsIn(text: string): string[] {
  return [...text.matchAll(/(?:`|^[ \t]*|\$ )(?:pnpm (?:exec )?)?marmeon ([a-z][a-z0-9:-]*)/gm)].map((match) => match[1]!);
}

/** The name of every MCP tool a skill names: a backtick-quoted name next to the word "tool", as in "its `schema` tool" or "the tool `routes`". */
function toolsIn(text: string): string[] {
  return [...text.matchAll(/`([a-z][a-z0-9_]*)`\s+(?:MCP\s+)?tools?\b|\btools?\s+`([a-z][a-z0-9_]*)`/g)].map((match) => (match[1] ?? match[2])!);
}

/**
 * Every page a skill names with `marmeon docs <page>` or `docs/<page>.md`, and the anchor after it, up to what ends a link.
 * A full stop or colon that ends the sentence is not part of the anchor, as in the website's link test.
 */
function referencesIn(text: string): { page: string; anchor: string | undefined }[] {
  const anchor = '(?:#([^\\s`\'"()[\\]<>,;]*))?';
  return [
    ...[...text.matchAll(new RegExp(`marmeon docs ([a-z][a-z0-9-]*)${anchor}`, 'g'))],
    ...[...text.matchAll(new RegExp(`docs/([a-z][a-z0-9-]*)\\.md${anchor}`, 'g'))],
  ].map((match) => ({ page: match[1]!, anchor: match[2]?.replace(/[.:!?]+$/, '') }));
}

describe('the skills of the package', () => {
  it('are the ones the framework ships', () => {
    expect(skills.map((skill) => skill.name)).toEqual(['marmeon-feature-module', 'marmeon-migration', 'marmeon-security-review', 'marmeon-testing']);
    expect(readdirSync(skillsDirectory())).toEqual(skills.map((skill) => skill.name));
  });

  describe.each(skills)('$name', ({ name, text }) => {
    it('follows the specification of an agent skill', () => {
      const front = frontMatter(text);
      expect(front.keys).toEqual(['name', 'description', 'metadata']);
      expect(front.values.get('name')).toBe(name);
      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name.startsWith('marmeon-')).toBe(true);
      const description = front.values.get('description')!;
      expect(description.length).toBeGreaterThanOrEqual(1);
      expect(description.length).toBeLessThanOrEqual(1024);
      expect(text).not.toContain('allowed-tools');
      expect(text).not.toContain('\r');
      expect(text.endsWith('\n')).toBe(true);
      expect(text.split('\n').length).toBeLessThanOrEqual(200);
    });

    it('carries the mark of the current format and the note on who owns the file', () => {
      expect(skillMark(text)).toBe(SKILL_FORMAT);
      expect(text).toContain('\n<!-- Managed by marmeon agents:install — edits are replaced; copy the folder under another name to keep your own. -->\n');
    });

    it('names only commands that exist', () => {
      const named = commandsIn(text);
      expect(named.length).toBeGreaterThan(2);
      const known = commandNames();
      expect(named.filter((command) => !known.has(command))).toEqual([]);
    });

    it('names only MCP tools that the server registers', () => {
      const registered = new Set(TOOLS.map((tool) => tool.name));
      expect(toolsIn(text).filter((tool) => !registered.has(tool))).toEqual([]);
    });

    it('points only at pages and sections of the documentation that exist', () => {
      const references = referencesIn(text);
      expect(references.length).toBeGreaterThan(1);
      for (const { page, anchor } of references) {
        const file = join(repo, 'docs', `${page}.md`);
        expect(existsSync(file), `docs/${page}.md`).toBe(true);
        if (anchor !== undefined) {
          expect(anchor, `docs/${page}.md#${anchor}`).toMatch(SLUG);
          expect(headingsOf(readFileSync(file, 'utf8')).some((heading) => heading.anchor === anchor), `docs/${page}.md#${anchor}`).toBe(true);
        }
      }
    });
  });

  it('name no wave, step or decision id', () => {
    for (const { name, text } of skills) expect(text, name).not.toMatch(/\b[A-Z]\d{1,3}\b(?<!\bD\d{1,2})/);
  });
});

describe('what the test reads out of a skill', () => {
  it('finds a tool named before or after the word, across a line break, and no other quoted word', () => {
    const text = 'Its `routes` tool lists them, and the\n`check`\ntool runs. Use the tool `schema`, not `marmeon check` or `devtools`.';
    expect(toolsIn(text)).toEqual(['routes', 'check', 'schema']);
  });

  it('finds a tool in the plural or with MCP in front; of two names before "tools" only the last is found', () => {
    expect(toolsIn('The `routes` MCP tool and its `routes` and `check` tools.')).toEqual(['routes', 'check']);
  });

  it('finds a tool that does not exist, so the registry check fails for it', () => {
    const registered = new Set(TOOLS.map((tool) => tool.name));
    expect(toolsIn('Its `nothing_here` tool and its `routes` tool.').filter((tool) => !registered.has(tool))).toEqual(['nothing_here']);
  });

  it('finds a command with or without a package manager, in a code span or an indented block', () => {
    const text = 'Run `marmeon check`.\n\n```sh\n  pnpm exec marmeon make:nothing x\npnpm marmeon route:types\n$ marmeon nope\n```\n';
    expect(commandsIn(text)).toEqual(['check', 'make:nothing', 'route:types', 'nope']);
  });

  it('keeps the whole anchor, so a capital letter or a dot fails instead of being cut off', () => {
    const found = referencesIn('See docs/migrations.md#Retiring-a-column, `docs/check.md#a.b` and marmeon docs errors#x_y ok');
    expect(found).toEqual([
      { page: 'errors', anchor: 'x_y' },
      { page: 'migrations', anchor: 'Retiring-a-column' },
      { page: 'check', anchor: 'a.b' },
    ]);
    expect(found.filter(({ anchor }) => !SLUG.test(anchor!)).map(({ anchor }) => anchor)).toEqual(['Retiring-a-column', 'a.b']);
  });

  it('leaves the full stop that ends a sentence out of the anchor', () => {
    expect(referencesIn('Read docs/check.md#exit-codes. Then marmeon docs errors#codes:')).toEqual([
      { page: 'errors', anchor: 'codes' },
      { page: 'check', anchor: 'exit-codes' },
    ]);
  });
});

describe('skillMark', () => {
  const marked = (front: string, body = '# Title') => `---\nname: marmeon-x\ndescription: d\n${front}---\n${body}\n`;

  it('reads every file of the stored fixtures as format 1', () => {
    const files = readdirSync(fixtures);
    expect(files).toContain('v1.md');
    for (const file of files) {
      const text = readFileSync(new URL(file, fixtures), 'utf8');
      expect(skillMark(text), file).toBe(1);
      expect(skillMark(text.replaceAll('\n', '\r\n')), `${file} (CRLF)`).toBe(1);
      expect(skillMark(`\uFEFF${text}`), `${file} (BOM)`).toBe(1);
    }
  });

  it('reads another number as it is', () => {
    expect(skillMark(marked('metadata:\n  marmeon-skill: "2"\n'))).toBe(2);
  });

  it('finds no mark in a file without one', () => {
    expect(skillMark(marked(''))).toBe('none');
    expect(skillMark(marked('metadata:\n  other: "1"\n'))).toBe('none');
    expect(skillMark('# Title\n')).toBe('none');
    expect(skillMark('')).toBe('none');
  });

  it('finds no mark outside the front matter', () => {
    expect(skillMark(marked('', 'metadata:\n  marmeon-skill: "1"'))).toBe('none');
  });

  it('calls a mark of another form malformed', () => {
    expect(skillMark(marked('metadata:\n  marmeon-skill: 1\n'))).toBe('malformed');
    expect(skillMark(marked('metadata:\n  marmeon-skill: "01"\n'))).toBe('malformed');
    expect(skillMark(marked('metadata:\n  marmeon-skill: "0"\n'))).toBe('malformed');
    expect(skillMark(marked("metadata:\n  marmeon-skill: '1'\n"))).toBe('malformed');
    expect(skillMark(marked('metadata:\n\tmarmeon-skill: "1"\n'))).toBe('malformed');
    expect(skillMark(marked('metadata:\n    marmeon-skill: "1"\n'))).toBe('malformed');
    expect(skillMark(marked('marmeon-skill: "1"\n'))).toBe('malformed');
    expect(skillMark(marked('metadata:\n  marmeon-skill: "1"\n  marmeon-skill: "1"\n'))).toBe('malformed');
    expect(skillMark(marked('metadata:\n  marmeon-skill: "1"\nmarmeon-skill: "1"\n'))).toBe('malformed');
    expect(skillMark('---\nmetadata:\n  marmeon-skill: "1"\n')).toBe('malformed');
  });
});
