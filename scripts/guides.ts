/**
 * Checks a guide page against the overlay it shows: `docs/first-app.md` against the notes demo (`examples/notes`), a recipe
 * against its directory of `examples/recipes`. The page shows the overlay's files and edits (for a recipe, also files of an app
 * of this repository) and runs its commands. Functions for the tests next to them, no command of their own.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeInfo, markdownParser } from '../apps/website/modules/docs/markdown.ts';
import { readCommands, readEdits } from './notes-demo.ts';

const PACKAGES = new URL('../packages/', import.meta.url);
const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));

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

export interface Block {
  /** The 1-based line of the opening fence. */
  line: number;
  lang: string;
  title: string | undefined;
  text: string;
}

/**
 * Every code block of a page, found by the parser and the reading of the info string the website uses: fences (backticks or
 * tildes, in lists and quotes too) and indented blocks, which have neither a language nor a title.
 */
export function blocks(markdown: string): Block[] {
  return markdownParser
    .parse(markdown, {})
    .filter((token) => token.type === 'fence' || token.type === 'code_block')
    .map((token) => {
      const { lang, title } = token.type === 'fence' ? codeInfo(token.info) : { lang: '', title: '' };
      return { line: token.map![0] + 1, lang, title: title || undefined, text: token.content.replace(/\n$/, '') };
    });
}

function filesBelow(dir: string, prefix = ''): string[] {
  if (!existsSync(join(dir, prefix))) return [];
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesBelow(dir, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

/** The languages of a block that shows no file of the app: commands and their output. */
const UNTITLED = ['sh', 'text', 'txt'];

export interface GuideOptions {
  /** The page's path in the repository, for the messages. */
  readonly page: string;
  /** The directory of the overlay (`files/`, `edits.json`, `commands.json`). */
  readonly overlay: string;
  /** A directory of the repository, relative to its root: a titled block may also be part of the file of that path below it. */
  readonly reference?: string;
  /** Every block but `sh`, `text` and `txt` needs a title. */
  readonly requireTitles?: boolean;
  readonly known?: ReadonlySet<string>;
  /** The repository `reference` is relative to (this one by default). */
  readonly root?: string;
}

/** The overlay as the messages name it: relative to the repository when it lies inside, else as given. */
function labelOf(overlay: string): string {
  const inside = relative(REPOSITORY, overlay);
  return inside.startsWith('..') ? overlay : inside.split(sep).join('/');
}

/**
 * What differs between the page and its overlay, one message each, with the page's line: a titled block that is neither a piece
 * of an overlay file, an edit's text nor a piece of the file of that path below `reference`, an overlay file or edit the page
 * never shows in full, a block without a title other than `sh`, `text` and `txt` (with `requireTitles`), a command of `commands.json` that is
 * missing from the `sh` blocks or stands out of order, and a `marmeon` command that does not exist. Empty when the two agree.
 */
export function guideProblems(markdown: string, options: GuideOptions): string[] {
  const { page, overlay, reference, requireTitles = false, known = knownCommands(), root = REPOSITORY } = options;
  const label = labelOf(overlay);
  const problems: string[] = [];
  const files = new Map(filesBelow(join(overlay, 'files')).map((path) => [path, readFileSync(join(overlay, 'files', path), 'utf8').replace(/\n$/, '')]));
  const edits = readEdits(overlay);
  const all = blocks(markdown);
  const shown = new Set<string>();

  for (const block of all) {
    if (block.title === undefined) {
      if (requireTitles && !UNTITLED.includes(block.lang)) problems.push(`${page}:${block.line}: the ${block.lang || 'unlabelled'} block has no title — name its file with title="…".`);
      continue;
    }
    const where = `${page}:${block.line} (${block.title})`;
    const file = files.get(block.title);
    if (file !== undefined) {
      if (!file.includes(block.text)) problems.push(`${where}: the block is not part of ${label}/files/${block.title}.`);
      else if (block.text === file) shown.add(block.title);
      continue;
    }
    const edit = edits.find((candidate) => candidate.file === block.title && candidate.replace === block.text);
    if (edit) {
      shown.add(`edit:${edits.indexOf(edit)}`);
      continue;
    }
    if (reference !== undefined && !block.title.split('/').includes('..')) {
      const path = join(root, reference, block.title);
      if (existsSync(path)) {
        if (!readFileSync(path, 'utf8').includes(block.text)) problems.push(`${where}: the block is not part of ${reference}/${block.title}.`);
        continue;
      }
    }
    problems.push(
      `${where}: the block is neither a part of a file in ${label}/files, the text of an edit in edits.json${reference === undefined ? '' : `, nor a part of a file of ${reference}`}.`,
    );
  }
  for (const path of files.keys()) if (!shown.has(path)) problems.push(`${page}: ${label}/files/${path} is not shown in full.`);
  edits.forEach((edit, index) => {
    if (!shown.has(`edit:${index}`)) problems.push(`${page}: the edit of ${edit.file} that adds "${edit.replace.split('\n').at(-1)!.trim()}" is not shown.`);
  });

  const commands = readCommands(overlay);
  const lines = all.filter((block) => block.lang === 'sh').flatMap((block) => block.text.split('\n').map((text) => text.trim()));
  let last = -1;
  for (const command of [...commands.beforeCopy, ...commands.afterCopy]) {
    const at = lines.indexOf(`pnpm ${command}`, last + 1);
    if (at < 0) problems.push(`${page}: the command "pnpm ${command}" of commands.json is missing or out of order in the sh blocks.`);
    else last = at;
  }
  for (const block of all) {
    if (block.lang !== 'sh') continue;
    block.text.split('\n').forEach((text, offset) => {
      const name = /^pnpm marmeon ([\w:-]+)/.exec(text.trim())?.[1];
      if (name !== undefined && !known.has(name)) problems.push(`${page}:${block.line + 1 + offset}: "marmeon ${name}" is not a command of the framework.`);
    });
  }
  return problems;
}
