import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { RouteBinder } from '@marmeon/http';
import docsConfig, { PACKAGES, type DocsDefinition, type DocsPageEntry, type DocsSection } from '../../docs.config.ts';
import { createCodeHighlighter, type CodeHighlighter } from './highlight.ts';
import { renderMarkdown, type RenderedMarkdown } from './markdown.ts';
import { SearchIndex, type SearchResult } from './search.ts';
import type { DocNode, TocEntry } from './types.ts';

/** A page: one of the docs (`/docs/<slug>`) or a package's README (`/packages/<name>`). */
export interface DocPage {
  readonly kind: 'doc' | 'package';
  /** The page's slug or the package's name. */
  readonly name: string;
  readonly path: string;
  /** The file's place in the repository: `docs/routing.md`, `UPGRADING.md`, `packages/core/README.md`. */
  readonly file: string;
  readonly title: string;
  /** The section of the navigation the page is in: `The Basics`, `Package READMEs · Core`. */
  readonly section: string;
  /** The file carries the pending marker: a page still to be written. */
  readonly pending: boolean;
  readonly body: DocNode[];
  readonly toc: TocEntry[];
  /** Every heading id — what a link's `#anchor` may name. */
  readonly anchors: readonly string[];
  readonly fileLinks: readonly string[];
}

/** An entry of the navigation: a page, and whether it is still to be written (the layout marks it "draft"). */
export interface NavigationPage {
  readonly name: string;
  readonly label: string;
  readonly path: string;
  readonly pending?: true;
}

export interface NavigationGroup {
  readonly title: string;
  readonly pages: readonly NavigationPage[];
}

/** The side navigation: the sections of `docs.config.ts`, then its groups of packages — each entry with its page. */
export interface Navigation {
  readonly groups: readonly NavigationGroup[];
}

/** The title of a group of package READMEs in the navigation, after the sections: `Package READMEs · Core`. */
export const packageGroupTitle = (group: string): string => `Package READMEs · ${group}`;

/** The docs cannot start: a page or README without its place in `docs.config.ts`, or a place without its file. */
export class DocsError extends Error {
  override readonly name = 'DocsError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`The docs cannot start:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.problems = problems;
  }
}

export interface DocsRepositoryOptions {
  /** The repository: `docs/*.md`, the policies at the root (`UPGRADING.md`, …) and `packages/<name>/README.md`. */
  readonly source: string;
  /** Re-read when a page changes (development). */
  readonly watch?: boolean;
  readonly docs?: DocsDefinition;
  /** Told when a re-read after a change fails (the pages stay as they were). */
  readonly onReloadError?: (error: unknown) => void;
}

interface Loaded {
  /** The docs' pages by slug, in the order of the sections. */
  readonly docs: ReadonlyMap<string, DocPage>;
  readonly packages: ReadonlyMap<string, DocPage>;
  readonly sections: readonly NavigationGroup[];
  readonly navigation: Navigation;
  readonly index: SearchIndex;
}

/**
 * The docs' pages and the packages' READMEs — read, rendered and indexed once when the app boots (in development again when one
 * changes). An app singleton that holds only the repository's content: nothing of a request, nothing a request could change.
 * Also the route binder of `/packages/:name` — an unknown package is a 404 ({@link DocBinding} binds `/docs/:page`).
 */
export class DocsRepository implements RouteBinder<DocPage> {
  readonly #options: DocsRepositoryOptions;
  #highlighter: CodeHighlighter | undefined;
  #loaded: Loaded | undefined;
  #watchers: FSWatcher[] = [];
  #reload: ReturnType<typeof setTimeout> | undefined;

  constructor(options: DocsRepositoryOptions) {
    this.#options = options;
  }

  /** Reads and renders every page; throws {@link DocsError} when the repository and `docs.config.ts` disagree. */
  async load(): Promise<this> {
    this.#highlighter ??= await createCodeHighlighter();
    this.#loaded = this.#read(this.#highlighter);
    if (this.#options.watch && this.#watchers.length === 0) this.#watch();
    return this;
  }

  /** Stops watching (the provider's shutdown). */
  close(): void {
    clearTimeout(this.#reload);
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers = [];
  }

  /** A package's README. */
  page(name: string): DocPage | undefined {
    return this.#state().packages.get(name);
  }

  /** A page of the docs. */
  doc(slug: string): DocPage | undefined {
    return this.#state().docs.get(slug);
  }

  /** Every page in the order of the navigation: the docs' pages section by section, then the packages. */
  pages(): DocPage[] {
    const { docs, packages } = this.#state();
    return [...docs.values(), ...packages.values()];
  }

  navigation(): Navigation {
    return this.#state().navigation;
  }

  /** The docs' sections of the navigation — without the package READMEs (the start page lists them). */
  sections(): readonly NavigationGroup[] {
    return this.#state().sections;
  }

  /**
   * The pages before and after `page`: for a page of the docs in one line through every section (the last page of a section
   * leads to the first of the next), for a package among the packages.
   */
  neighbours(page: DocPage): { previous: DocPage | null; next: DocPage | null } {
    const { docs, packages } = this.#state();
    const list = [...(page.kind === 'doc' ? docs : packages).values()];
    const at = list.findIndex((other) => other.path === page.path);
    if (at === -1) return { previous: null, next: null };
    return { previous: list[at - 1] ?? null, next: list[at + 1] ?? null };
  }

  search(query: string, options?: { limit?: number }): SearchResult[] {
    return this.#state().index.search(query, options);
  }

  /** `/packages/:name` → its page, or a 404. */
  resolveRouteBinding(value: string): DocPage | undefined {
    return this.page(value);
  }

  #state(): Loaded {
    if (!this.#loaded) throw new Error('DocsRepository: load() has not run — the DocsServiceProvider loads it while the app boots.');
    return this.#loaded;
  }

  #read(highlighter: CodeHighlighter): Loaded {
    const { source } = this.#options;
    const docs = this.#options.docs ?? docsConfig;
    const problems: string[] = [];

    const listed = new Map<string, string>();
    for (const group of docs.groups) {
      for (const name of group.packages) {
        if (listed.has(name)) problems.push(`'${name}' is listed twice in docs.config.ts (in "${listed.get(name)}" and "${group.title}").`);
        listed.set(name, group.title);
      }
    }
    const packagesDir = join(source, 'packages');
    const found = existsSync(packagesDir)
      ? readdirSync(packagesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'package.json'))).map((entry) => entry.name)
      : [];
    for (const name of found) {
      const readme = existsSync(join(packagesDir, name, 'README.md'));
      if (!(PACKAGES as readonly string[]).includes(name)) {
        problems.push(`packages/${name}${readme ? '/README.md' : ''} has no entry in docs.config.ts — add '${name}' to PACKAGES and to a group.`);
      } else if (!listed.has(name)) {
        problems.push(`'${name}' is in no group of docs.config.ts.`);
      }
      if (!readme) problems.push(`packages/${name} has no README.md — every package documents itself.`);
    }
    for (const name of PACKAGES) {
      if (!found.includes(name)) problems.push(`docs.config.ts lists '${name}', but packages/${name} does not exist in ${source}.`);
    }
    problems.push(...checkPages(source, docs.sections));
    if (problems.length > 0) throw new DocsError(problems);

    const names = new Set<string>(PACKAGES);
    const entries = docs.sections.flatMap((section) => section.pages.map((entry) => ({ entry, section: section.title })));
    const docOf = new Map(entries.map(({ entry }) => [fileOf(entry), `/docs/${entry.slug}`]));
    // The root README is no page: a link to it stays code text (the start page is the app's own).
    const pageOf = (file: string) => {
      const doc = docOf.get(file);
      if (doc) return doc;
      const name = /^packages\/([^/]+)\/README\.md$/.exec(file)?.[1];
      return name && names.has(name) ? `/packages/${name}` : undefined;
    };
    const page = (kind: DocPage['kind'], name: string, file: string, section: string): { page: DocPage; rendered: RenderedMarkdown } => {
      const rendered = renderMarkdown(readFileSync(join(source, file), 'utf8'), { file, pageOf, highlight: highlighter.highlight });
      return {
        rendered,
        page: {
          kind,
          name,
          path: pageOf(file)!,
          file,
          title: rendered.title || (kind === 'package' ? `@marmeon/${name}` : name),
          section,
          pending: rendered.pending,
          body: rendered.body,
          toc: rendered.toc,
          anchors: rendered.anchors,
          fileLinks: rendered.fileLinks,
        },
      };
    };

    const all: { page: DocPage; rendered: RenderedMarkdown }[] = [];
    const docPages = new Map<string, DocPage>();
    for (const { entry, section } of entries) {
      const rendered = page('doc', entry.slug, fileOf(entry), section);
      docPages.set(entry.slug, rendered.page);
      all.push(rendered);
    }
    const packages = new Map<string, DocPage>();
    for (const group of docs.groups) {
      for (const name of group.packages) {
        const rendered = page('package', name, `packages/${name}/README.md`, packageGroupTitle(group.title));
        packages.set(name, rendered.page);
        all.push(rendered);
      }
    }
    const late = new Set(entries.filter(({ entry }) => entry.changes).map(({ entry }) => `/docs/${entry.slug}`));
    const index = new SearchIndex(
      all.flatMap(({ page: { path, title }, rendered }) =>
        rendered.sections.map((section) => ({ path, page: title, heading: section.heading, anchor: section.anchor, text: section.text, late: late.has(path) })),
      ),
    );
    const sections: NavigationGroup[] = docs.sections.map((section) => ({
      title: section.title,
      pages: section.pages.map((entry) => ({
        name: entry.slug,
        label: entry.label,
        path: `/docs/${entry.slug}`,
        ...(docPages.get(entry.slug)!.pending ? { pending: true as const } : {}),
      })),
    }));
    const navigation: Navigation = {
      groups: [
        ...sections,
        ...docs.groups.map((group) => ({ title: packageGroupTitle(group.title), pages: group.packages.map((name) => ({ name, label: name, path: `/packages/${name}` })) })),
      ],
    };
    return { docs: docPages, packages, sections, navigation, index };
  }

  /** Development: `docs/`, the root (for the policies that are pages) and every package directory — for a changed, new or removed page (editors replace files). */
  #watch(): void {
    const { source } = this.#options;
    const docs = this.#options.docs ?? docsConfig;
    const rootFiles = new Set(docs.sections.flatMap((section) => section.pages.flatMap((entry) => (entry.file ? [entry.file] : []))));
    const changed = () => {
      clearTimeout(this.#reload);
      this.#reload = setTimeout(() => {
        try {
          this.#loaded = this.#read(this.#highlighter!);
        } catch (error) {
          this.#options.onReloadError?.(error);
        }
      }, 50);
    };
    const docsDir = join(source, 'docs');
    const packagesDir = join(source, 'packages');
    const directories = [source, packagesDir, docsDir, ...PACKAGES.map((name) => join(packagesDir, name))];
    for (const directory of directories.filter((path) => existsSync(path))) {
      const watcher = watch(directory, (_event, file) => {
        const relevant = directory === docsDir || directory === packagesDir || (directory === source ? file !== null && rootFiles.has(file) : file === 'README.md');
        if (file === null || relevant) changed();
      });
      watcher.unref();
      this.#watchers.push(watcher);
    }
  }
}

/** The file of a page: `docs/<slug>.md`, or the policy at the root it names. */
const fileOf = (entry: DocsPageEntry): string => entry.file ?? `docs/${entry.slug}.md`;

/** What the sections and the repository must agree on: slugs of words with dashes, slugs and files once, every file there, every `docs/*.md` listed. */
function checkPages(source: string, sections: readonly DocsSection[]): string[] {
  const problems: string[] = [];
  const slugs = new Set<string>();
  const files = new Set<string>();
  for (const entry of sections.flatMap((section) => section.pages)) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.slug)) {
      problems.push(`The page slug '${entry.slug}' in docs.config.ts is not lower-case words with dashes.`);
      continue;
    }
    if (slugs.has(entry.slug)) {
      problems.push(`The page slug '${entry.slug}' is listed twice in docs.config.ts.`);
      continue;
    }
    slugs.add(entry.slug);
    const file = fileOf(entry);
    if (file !== `docs/${entry.slug}.md` && !/^[^/\\]+\.md$/.test(file)) {
      problems.push(`The page '${entry.slug}' names ${file} — a page's file is docs/<slug>.md or a Markdown file at the root.`);
      continue;
    }
    if (files.has(file)) {
      problems.push(`${file} is listed twice in docs.config.ts.`);
      continue;
    }
    files.add(file);
    if (!existsSync(join(source, file))) problems.push(`docs.config.ts lists ${file}, but it does not exist in ${source}.`);
  }
  const docsDir = join(source, 'docs');
  if (existsSync(docsDir)) {
    for (const name of readdirSync(docsDir).filter((file) => file.endsWith('.md')).sort()) {
      if (!files.has(`docs/${name}`)) problems.push(`docs/${name} has no entry in docs.config.ts — add it to a section.`);
    }
  }
  return problems;
}

/** `/docs/:page` → its page, or a 404. */
export class DocBinding implements RouteBinder<DocPage> {
  readonly #docs: DocsRepository;

  constructor(docs: DocsRepository) {
    this.#docs = docs;
  }

  resolveRouteBinding(value: string): DocPage | undefined {
    return this.#docs.doc(value);
  }
}
