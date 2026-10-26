import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteBinder, RouteBindingContext } from '@marmeon/http';
import type { DocsDefinition } from '../../docs.config.ts';
import { DocsError, DocsRepository, type DocPage } from './DocsRepository.ts';
import { createCodeHighlighter } from './highlight.ts';
import { compareVersions, isLine, lineOf } from './release-line.ts';

/** A release line: the docs of one version, read from its snapshot (`content/lines/<line>/`). */
export interface DocsLine {
  /** `0.3.x`, `1.x`. */
  readonly name: string;
  /** The version the snapshot was taken at: `0.3.0`. */
  readonly version: string;
  /** The commit of the version's tag — what a link to a file that is no page points at. */
  readonly commit: string;
  readonly repository: DocsRepository;
}

export interface DocsLinesOptions {
  /** The directory with one snapshot per line. */
  readonly dir: string;
  /** The file that pins each line to the commit of its tag. */
  readonly pins: string;
}

const ROOT_FILES: readonly string[] = ['UPGRADING.md', 'SECURITY.md', 'CONTRIBUTING.md'];

/**
 * The release lines — read from the pins and the snapshots when the app boots; without both, there are none. A line is found
 * by the name the boot read, never by joining a part of the request into a path: what is not here is a 404. An app singleton
 * that holds only content.
 */
export class DocsLines {
  readonly #options: DocsLinesOptions;
  #lines: ReadonlyMap<string, DocsLine> = new Map();
  #sorted: readonly DocsLine[] = [];

  constructor(options: DocsLinesOptions) {
    this.#options = options;
  }

  /** Reads and renders every line; throws {@link DocsError} (listing all problems) when pins and snapshots disagree. */
  async load(): Promise<this> {
    const { dir, pins } = this.#options;
    if (!existsSync(pins) && !existsSync(dir)) return this;
    const problems: string[] = [];
    const pinned = readPins(pins, problems);
    const folders = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
    for (const folder of folders) {
      if (!pinned.has(folder.name)) problems.push(`content/lines/${folder.name} has no pin in docs-lines.json — a snapshot is made by \`pnpm website:lines add\` together with its pin.`);
      else if (!folder.isDirectory()) problems.push(`content/lines/${folder.name} is not a directory.`);
    }
    const present = new Set(folders.filter((folder) => folder.isDirectory()).map((folder) => folder.name));
    const highlighter = await createCodeHighlighter();
    const lines = new Map<string, DocsLine>();
    for (const [name, pin] of pinned) {
      if (!present.has(name)) {
        problems.push(`docs-lines.json pins ${name}, but content/lines/${name} does not exist.`);
        continue;
      }
      const source = join(dir, name);
      const definition = readIndex(source, name, pin.version, problems);
      if (definition === undefined) continue;
      const repository = new DocsRepository({ source, docs: definition, base: `/docs/${name}`, githubRef: pin.commit, highlighter });
      try {
        await repository.load();
      } catch (error) {
        if (!(error instanceof DocsError)) throw error;
        problems.push(...error.problems.map((problem) => `${name}: ${problem}`));
        continue;
      }
      lines.set(name, { name, version: pin.version, commit: pin.commit, repository });
    }
    if (problems.length > 0) throw new DocsError(problems);
    this.#lines = lines;
    this.#sorted = [...lines.values()].sort((a, b) => compareVersions(b.version, a.version));
    return this;
  }

  /** The line with this name, or none — the only way a request reaches a snapshot. */
  line(name: string): DocsLine | undefined {
    return this.#lines.get(name);
  }

  /** Every line, the newest first. */
  all(): readonly DocsLine[] {
    return this.#sorted;
  }

  close(): void {
    for (const line of this.#lines.values()) line.repository.close();
  }
}

interface Pin {
  readonly version: string;
  readonly commit: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const hasKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(value).sort();
  return own.length === keys.length && [...keys].sort().every((key, index) => key === own[index]);
};

/** `docs-lines.json`, strictly: anything else than `{ format: 1, lines: { <line>: { version, tag, commit } } }` is a problem. */
function readPins(file: string, problems: string[]): Map<string, Pin> {
  const pins = new Map<string, Pin>();
  if (!existsSync(file)) return pins;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    problems.push(`docs-lines.json is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    return pins;
  }
  if (!isRecord(data) || !hasKeys(data, ['format', 'lines']) || data.format !== 1 || !isRecord(data.lines)) {
    problems.push('docs-lines.json has to be { "format": 1, "lines": {…} } and nothing else.');
    return pins;
  }
  for (const [name, pin] of Object.entries(data.lines)) {
    const { version, tag, commit } = isRecord(pin) ? pin : ({} as Record<string, unknown>);
    if (!isLine(name)) problems.push(`docs-lines.json: ${JSON.stringify(name)} is no release line (0.<minor>.x before 1.0, <major>.x after).`);
    else if (!isRecord(pin) || !hasKeys(pin, ['version', 'tag', 'commit'])) problems.push(`docs-lines.json: the pin of ${name} has to hold version, tag and commit and nothing else.`);
    else if (typeof version !== 'string' || lineOf(version) !== name) problems.push(`docs-lines.json: the version of ${name} is not one of that line.`);
    else if (tag !== `v${version}`) problems.push(`docs-lines.json: the tag of ${name} is not v${version}.`);
    else if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) problems.push(`docs-lines.json: the commit of ${name} is not 40 hexadecimal digits.`);
    else pins.set(name, { version, commit });
  }
  return pins;
}

const isRegularFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The snapshot's `docs/index.json` (format 1) as a navigation. Only `docs/<slug>.md` and the policies at the root are files of a
 * line, and only regular ones: nothing the index names can lead out of the snapshot.
 */
function readIndex(source: string, name: string, version: string, problems: string[]): DocsDefinition | undefined {
  const where = `content/lines/${name}`;
  const before = problems.length;
  const indexFile = join(source, 'docs/index.json');
  let data: unknown;
  try {
    if (!lstatSync(join(source, 'docs')).isDirectory() || !isRegularFile(indexFile)) throw new Error('not a regular file');
    data = JSON.parse(readFileSync(indexFile, 'utf8'));
  } catch {
    problems.push(`${where}/docs/index.json is missing or not JSON.`);
    return undefined;
  }
  if (!isRecord(data) || data.format !== 1) {
    problems.push(`${where}/docs/index.json is not format 1.`);
    return undefined;
  }
  if (data.version !== version) {
    problems.push(`${where}/docs/index.json is the version ${JSON.stringify(data.version)}, but ${name} is pinned at ${version}.`);
    return undefined;
  }
  if (!Array.isArray(data.sections)) {
    problems.push(`${where}/docs/index.json has no sections.`);
    return undefined;
  }
  const sections = data.sections.map((section: unknown) => {
    const title = isRecord(section) && typeof section.title === 'string' ? section.title : undefined;
    if (title === undefined) problems.push(`${where}/docs/index.json: a section without a title.`);
    const pages = isRecord(section) && Array.isArray(section.pages) ? section.pages : [];
    return {
      title: title ?? '',
      pages: pages.flatMap((page: unknown) => {
        if (!isRecord(page) || typeof page.slug !== 'string' || typeof page.label !== 'string' || typeof page.file !== 'string') {
          problems.push(`${where}/docs/index.json: a page without slug, label and file.`);
          return [];
        }
        const { slug, label, file } = page;
        if (file !== `docs/${slug}.md` && !ROOT_FILES.includes(file)) {
          problems.push(`${where}/docs/index.json: ${file} is no file of a line.`);
          return [];
        }
        if (existsSync(join(source, file)) && !isRegularFile(join(source, file))) {
          problems.push(`${where}/${file} is not a regular file.`);
          return [];
        }
        return [{ slug, label, ...(file === `docs/${slug}.md` ? {} : { file }) }];
      }),
    };
  });
  return problems.length > before ? undefined : { sections };
}

/** `/docs/:line` → the line, or a 404. */
export class LineBinding implements RouteBinder<DocsLine> {
  readonly #lines: DocsLines;

  constructor(lines: DocsLines) {
    this.#lines = lines;
  }

  resolveRouteBinding(value: string): DocsLine | undefined {
    return this.#lines.line(value);
  }
}

/** `/docs/:line/:page` → the line's page, or a 404: asked within the line the route bound before (`scopedBy`). */
export class LinePageBinding implements RouteBinder<DocPage> {
  static readonly routeBindingScoped = true;

  resolveRouteBinding(value: string, binding: RouteBindingContext): DocPage | undefined {
    return (binding.scope?.parent as DocsLine | undefined)?.repository.doc(value);
  }
}

/** `/docs/:line/:file` (`routing.md`) → the line's page, or a 404. */
export class LineSourceBinding implements RouteBinder<DocPage> {
  static readonly routeBindingScoped = true;

  resolveRouteBinding(value: string, binding: RouteBindingContext): DocPage | undefined {
    return value.endsWith('.md') ? (binding.scope?.parent as DocsLine | undefined)?.repository.doc(value.slice(0, -3)) : undefined;
  }
}

/**
 * The line a reader of a page's Markdown learns first: agents read the body only, so the version and the way to the newest docs
 * go in front of it. `newestUrl` is absolute; `page` is whether the newest docs still have the page (else it names the docs).
 */
export function lineNote(line: Pick<DocsLine, 'name' | 'version'>, newestUrl: string, page: boolean): string {
  return `> Marmeon ${line.version}, the ${line.name} line. The newest ${page ? 'version of this page' : 'documentation'}: ${newestUrl}\n\n`;
}

/** Where the newest docs have the page of a release line: `/docs/<slug>`, or `/docs` when the page is gone. */
export function newestPath(newest: Pick<DocsRepository, 'doc'>, page: DocPage): string {
  return newest.doc(page.name)?.path ?? '/docs';
}
