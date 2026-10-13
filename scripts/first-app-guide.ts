/**
 * Checks `docs/first-app.md` against the notes demo (`examples/notes`): the guide shows the demo's files and edits, and runs the
 * demo's commands. A function for the test next to it, no command of its own.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { OVERLAY, readCommands, readEdits } from './notes-demo.ts';

const PACKAGES = new URL('../packages/', import.meta.url);

/** The names every `static command = '…'` of the packages' sources defines — what `marmeon <name>` can run. */
export function knownCommands(): Set<string> {
  const names = new Set<string>();
  for (const pkg of readdirSync(PACKAGES)) {
    const src = new URL(`${pkg}/src/`, PACKAGES);
    if (!existsSync(src)) continue;
    for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      for (const match of readFileSync(join(entry.parentPath, entry.name), 'utf8').matchAll(/(?:static command = |\{ command: )'([^']+)'/g)) names.add(match[1]!);
    }
  }
  return names;
}

export const GUIDE = new URL('../docs/first-app.md', import.meta.url);

interface Block {
  /** The 1-based line of the opening fence. */
  line: number;
  lang: string;
  title: string | undefined;
  text: string;
}

function blocks(markdown: string): Block[] {
  const found: Block[] = [];
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const open = /^```(\w*)(?: title="([^"]+)")?\s*$/.exec(lines[index]!);
    if (!open) continue;
    const start = index;
    const body: string[] = [];
    while (++index < lines.length && lines[index] !== '```') body.push(lines[index]!);
    found.push({ line: start + 1, lang: open[1]!, title: open[2], text: body.join('\n') });
  }
  return found;
}

function filesBelow(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesBelow(dir, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

/**
 * What differs between the guide and the demo, one message each, with the guide's line: a titled block that is neither a piece
 * of a demo file nor an edit's text, a demo file or edit the guide never shows in full, and a command of `commands.json` that
 * is missing from the `sh` blocks or stands out of order, and a `marmeon` command that does not exist. Empty when the two agree.
 */
export function guideProblems(markdown: string, overlay: string = OVERLAY, known: ReadonlySet<string> = knownCommands()): string[] {
  const problems: string[] = [];
  const files = new Map(filesBelow(join(overlay, 'files')).map((path) => [path, readFileSync(join(overlay, 'files', path), 'utf8').replace(/\n$/, '')]));
  const edits = readEdits(overlay);
  const all = blocks(markdown);
  const shown = new Set<string>();

  for (const block of all) {
    if (block.title === undefined) continue;
    const where = `docs/first-app.md:${block.line} (${block.title})`;
    const file = files.get(block.title);
    if (file !== undefined) {
      if (!file.includes(block.text)) problems.push(`${where}: the block is not part of examples/notes/files/${block.title}.`);
      else if (block.text === file) shown.add(block.title);
      continue;
    }
    const edit = edits.find((candidate) => candidate.file === block.title && candidate.replace === block.text);
    if (edit) shown.add(`edit:${edits.indexOf(edit)}`);
    else problems.push(`${where}: the block is neither a part of a file in examples/notes/files nor the text of an edit in edits.json.`);
  }
  for (const path of files.keys()) if (!shown.has(path)) problems.push(`docs/first-app.md: examples/notes/files/${path} is not shown in full.`);
  edits.forEach((edit, index) => {
    if (!shown.has(`edit:${index}`)) problems.push(`docs/first-app.md: the edit of ${edit.file} that adds "${edit.replace.split('\n').at(-1)!.trim()}" is not shown.`);
  });

  const commands = readCommands(overlay);
  const lines = all.filter((block) => block.lang === 'sh').flatMap((block) => block.text.split('\n').map((text) => text.trim()));
  let last = -1;
  for (const command of [...commands.beforeCopy, ...commands.afterCopy]) {
    const at = lines.indexOf(`pnpm ${command}`, last + 1);
    if (at < 0) problems.push(`docs/first-app.md: the command "pnpm ${command}" of commands.json is missing or out of order in the sh blocks.`);
    else last = at;
  }
  for (const block of all) {
    if (block.lang !== 'sh') continue;
    block.text.split('\n').forEach((text, offset) => {
      const name = /^pnpm marmeon ([\w:-]+)/.exec(text.trim())?.[1];
      if (name !== undefined && !known.has(name)) problems.push(`docs/first-app.md:${block.line + 1 + offset}: "marmeon ${name}" is not a command of the framework.`);
    });
  }
  return problems;
}
