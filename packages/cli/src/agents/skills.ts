import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The version of the mark in a skill's front matter (`marmeon-skill: "1"`). It names the shape of the file the program owns, not the
 * wording of the skill, which changes with the release. A skill marked with a newer version is left alone.
 */
export const SKILL_FORMAT = 1;

/** The folder with the skills the package ships: `skills/<name>/SKILL.md`, next to `src/` and `dist/`. */
export function skillsDirectory(): string {
  return fileURLToPath(new URL('../../skills/', import.meta.url));
}

/** Every skill of the package, by name, with the text of its `SKILL.md`. */
export function shippedSkills(): { name: string; text: string }[] {
  const root = skillsDirectory();
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, text: readFileSync(join(root, entry.name, 'SKILL.md'), 'utf8') }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

const FENCE = /^---[ \t]*$/;
const KEY = /^\s*marmeon-skill:/;
const MARK = /^ {2}marmeon-skill: "([1-9]\d*)"$/;

/**
 * The format a skill's text is marked with: the number, `'none'` when the front matter has no mark (or there is none), `'malformed'`
 * when it has one in another form — unquoted, indented with a tab, outside `metadata:` or more than once. A byte order mark and
 * `\r\n` line ends are read past.
 */
export function skillMark(text: string): number | 'none' | 'malformed' {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!FENCE.test(lines[0] ?? '')) return 'none';
  const end = lines.findIndex((line, index) => index > 0 && FENCE.test(line));
  const front = lines.slice(1, end === -1 ? undefined : end);
  const marked = front.flatMap((line, index) => (KEY.test(line) ? [index] : []));
  if (marked.length === 0) return 'none';
  if (end === -1 || marked.length > 1) return 'malformed';
  const at = marked[0]!;
  const match = MARK.exec(front[at]!);
  const parent = front.indexOf('metadata:');
  // Between `metadata:` and the mark every line is indented, so the mark belongs to that block.
  if (!match || parent === -1 || parent > at || front.slice(parent + 1, at).some((line) => !/^\s/.test(line))) return 'malformed';
  return Number(match[1]);
}
