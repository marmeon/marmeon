import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandInput } from '../command.ts';
import { style } from '../output.ts';

/** Where the documentation of the installed `marmeon` lies: `docs/` in the package, the same depth from `src/commands/` and `dist/commands/`. */
export class DocsLocation {
  get directory(): string {
    return fileURLToPath(new URL('../../docs', import.meta.url));
  }
}

/** One page of `docs/index.json`; `file` is relative to the package (a file below `docs/`, or `UPGRADING.md`). */
interface Page {
  readonly slug: string;
  readonly title: string;
  readonly file: string;
}

interface Section {
  readonly title: string;
  readonly pages: readonly Page[];
}

interface DocsIndex {
  readonly version: string;
  readonly sections: readonly Section[];
}

/** A file the package ships: a name below `docs/` or at the package root, never a path that leaves it. */
const SHIPPED_FILE = /^(?:docs\/)?[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

/**
 * Lists the pages of the documentation that came with the installed `marmeon`, or prints one to stdout. A page is found by its
 * slug in `docs/index.json` and never by a path built from what was typed. Runs without booting the app. See docs/console.md#reading-the-documentation.
 */
export class DocsCommand {
  static command = 'docs';
  static description = 'List the pages of the documentation of the installed version, or print one';
  static usage = '[<page>] [--path] [--json]';
  static options = { path: { type: 'boolean' }, json: { type: 'boolean' } } as const;
  static boots = false;

  readonly #location: DocsLocation;

  constructor(location: DocsLocation) {
    this.#location = location;
  }

  handle({ args, options, output, root }: CommandInput): number {
    const wanted = args[0];
    if (args.length > 1) return usage(output, 'marmeon docs takes one page at most.');
    if (wanted !== undefined && options.json === true) return usage(output, '--json lists every page and takes no page name.');
    if (wanted === undefined && options.path === true) return usage(output, '--path needs a page: marmeon docs <page> --path.');

    const packageRoot = dirname(this.#location.directory);
    const shown = displayRoot(packageRoot, root);
    const index = readIndex(this.#location.directory);
    if (typeof index === 'string') {
      output.error(index);
      return 1;
    }

    if (wanted === undefined) {
      if (options.json === true) {
        output.json({
          format: 1,
          version: index.version,
          root: shown,
          sections: index.sections.map((section) => ({ title: section.title, pages: section.pages.map(({ slug, title, file }) => ({ slug, title, file })) })),
          warnings: [],
        });
      } else {
        list(output, index, shown, root);
      }
      return 0;
    }

    const slug = slugOf(wanted);
    const page = index.sections.flatMap((section) => section.pages).find((entry) => entry.slug === slug);
    if (!page) {
      const similar = suggest(index, slug);
      output.error(`There is no page "${wanted}" in the documentation of marmeon ${index.version}.${similar.length > 0 ? ` Did you mean ${similar.join(', ')}?` : ''} Run marmeon docs to list the pages.`);
      return 2;
    }
    const text = readRegular(join(packageRoot, page.file));
    if (text === undefined) {
      output.error(`The page "${page.slug}" is in docs/index.json, but ${page.file} is not a file of this installation of marmeon.`);
      return 1;
    }
    if (options.path === true) {
      output.line(join(shown, page.file));
      return 0;
    }
    // The file as it is: `line` adds the newline a page ends with already.
    output.line(text.endsWith('\n') ? text.slice(0, -1) : text);
    return 0;
  }
}

function usage(output: CommandInput['output'], message: string): number {
  output.error(`${message}\nUsage: marmeon docs ${DocsCommand.usage}`);
  return 2;
}

/** `routing`, `routing.md` and `routing#anchor` name the same page. */
function slugOf(wanted: string): string {
  const name = wanted.split('#')[0]!;
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

/**
 * The text of a regular file, or undefined. The file is opened without following a symlink (ELOOP) and judged by the descriptor it
 * opened, so nothing can be swapped in between the check and the read.
 */
function readRegular(path: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return fstatSync(descriptor).isFile() ? readFileSync(descriptor, 'utf8') : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Where the package is shown to be: `<app>/node_modules/marmeon` when that is this package (pnpm resolves it to a path with the version in it), else its own path. */
function displayRoot(packageRoot: string, cwd: string): string {
  const link = join(cwd, 'node_modules', 'marmeon');
  try {
    return realpathSync(link) === realpathSync(packageRoot) ? link : packageRoot;
  } catch {
    return packageRoot;
  }
}

/** The index, or what is wrong with it. */
function readIndex(directory: string): DocsIndex | string {
  const text = readRegular(join(directory, 'index.json'));
  if (text === undefined) return 'The docs are not in this installation of marmeon — in the repository, run pnpm build.';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'docs/index.json of marmeon is not valid JSON — reinstall marmeon, or in the repository run pnpm build.';
  }
  const document = parsed as { format?: unknown; version?: unknown; sections?: unknown };
  if (document === null || typeof document !== 'object' || document.format !== 1) {
    return `docs/index.json has format ${JSON.stringify((document as { format?: unknown } | null)?.format ?? null)}, which this marmeon does not read — update marmeon, or in the repository run pnpm build.`;
  }
  const sections = document.sections;
  if (typeof document.version !== 'string' || !Array.isArray(sections) || !sections.every(isSection)) {
    return 'docs/index.json of marmeon is malformed — reinstall marmeon, or in the repository run pnpm build.';
  }
  return { version: document.version, sections };
}

function isSection(value: unknown): value is Section {
  const section = value as Section | null;
  return typeof section === 'object' && section !== null && typeof section.title === 'string' && Array.isArray(section.pages) && section.pages.every(isPage);
}

function isPage(value: unknown): value is Page {
  const page = value as Page | null;
  return typeof page === 'object' && page !== null && typeof page.slug === 'string' && typeof page.title === 'string' && typeof page.file === 'string' && SHIPPED_FILE.test(page.file);
}

function list(output: CommandInput['output'], index: DocsIndex, packageRoot: string, cwd: string): void {
  const pages = index.sections.flatMap((section) => section.pages);
  const slugWidth = Math.max(0, ...pages.map((page) => page.slug.length));
  const titleWidth = Math.max(0, ...pages.map((page) => page.title.length));
  output.line(`${style('bold', 'Marmeon')}  ${style('dim', `documentation of the installed version ${index.version}`)}`);
  for (const section of index.sections) {
    output.line();
    output.line(style('yellow', section.title));
    for (const page of section.pages) {
      output.line(`  ${style('green', page.slug.padEnd(slugWidth))}  ${page.title.padEnd(titleWidth)}  ${style('dim', relative(cwd, join(packageRoot, page.file)))}`);
    }
  }
  output.line();
  output.line('The newest version online: https://marmeon.com/docs');
}

/** Up to five slugs that contain what was typed or are a few edits away from it. */
function suggest(index: DocsIndex, slug: string): string[] {
  const typed = slug.toLowerCase();
  if (typed === '') return [];
  return index.sections
    .flatMap((section) => section.pages)
    .map((page) => ({ slug: page.slug, distance: page.slug.includes(typed) || typed.includes(page.slug) ? 0 : editDistance(page.slug, typed) }))
    .filter((candidate) => candidate.distance <= Math.min(3, Math.floor(typed.length / 2)))
    .sort((a, b) => a.distance - b.distance || a.slug.localeCompare(b.slug))
    .slice(0, 5)
    .map((candidate) => candidate.slug);
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length]!;
}
