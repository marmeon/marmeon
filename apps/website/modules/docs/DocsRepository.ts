import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { RouteBinder } from '@marmeon/http';
import docsConfig, { type DocsDefinition, type DocsPageEntry, type DocsSection } from '../../docs.config.ts';
import { createCodeHighlighter, type CodeHighlighter } from './highlight.ts';
import { renderMarkdown, type RenderedMarkdown } from './markdown.ts';
import { SearchIndex, type SearchResult } from './search.ts';
import type { DocNode, TocEntry } from './types.ts';

/** A page of the docs: `/docs/<slug>`. */
export interface DocPage {
  /** The page's slug. */
  readonly name: string;
  readonly path: string;
  /** The file's place in the repository: `docs/routing.md`, `UPGRADING.md`. */
  readonly file: string;
  readonly title: string;
  /** The section of the navigation the page is in: `The Basics`. */
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

/** The side navigation: the sections of `docs.config.ts`, each entry with its page. */
export interface Navigation {
  readonly groups: readonly NavigationGroup[];
}

/** The docs cannot start: a page without its place in `docs.config.ts`, or a place without its file. */
export class DocsError extends Error {
  override readonly name = 'DocsError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`The docs cannot start:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.problems = problems;
  }
}

export interface DocsRepositoryOptions {
  /** The repository: `docs/*.md` and the policies at the root (`UPGRADING.md`, …). */
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
  readonly navigation: Navigation;
  readonly index: SearchIndex;
}

/**
 * The docs' pages — read, rendered and indexed once when the app boots (in development again when one changes). An app singleton
 * that holds only the repository's content: nothing of a request, nothing a request could change. {@link DocBinding} binds
 * `/docs/:page` to its page.
 */
export class DocsRepository {
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

  /** A page of the docs. */
  doc(slug: string): DocPage | undefined {
    return this.#state().docs.get(slug);
  }

  /** Every page in the order of the navigation, section by section. */
  pages(): DocPage[] {
    return [...this.#state().docs.values()];
  }

  navigation(): Navigation {
    return this.#state().navigation;
  }

  /** The docs' sections, each with its pages — the navigation's groups (the start page lists them). */
  sections(): readonly NavigationGroup[] {
    return this.#state().navigation.groups;
  }

  /** The pages before and after `page`, in one line through every section: the last page of a section leads to the first of the next. */
  neighbours(page: DocPage): { previous: DocPage | null; next: DocPage | null } {
    const list = this.pages();
    const at = list.findIndex((other) => other.path === page.path);
    if (at === -1) return { previous: null, next: null };
    return { previous: list[at - 1] ?? null, next: list[at + 1] ?? null };
  }

  search(query: string, options?: { limit?: number }): SearchResult[] {
    return this.#state().index.search(query, options);
  }

  #state(): Loaded {
    if (!this.#loaded) throw new Error('DocsRepository: load() has not run — the DocsServiceProvider loads it while the app boots.');
    return this.#loaded;
  }

  #read(highlighter: CodeHighlighter): Loaded {
    const { source } = this.#options;
    const docs = this.#options.docs ?? docsConfig;
    const problems = checkPages(source, docs.sections);
    if (problems.length > 0) throw new DocsError(problems);

    const entries = docs.sections.flatMap((section) => section.pages.map((entry) => ({ entry, section: section.title })));
    const docOf = new Map(entries.map(({ entry }) => [fileOf(entry), `/docs/${entry.slug}`]));
    // Only the docs' files are pages: a link to the root README stays code text (the start page is the app's own).
    const pageOf = (file: string) => docOf.get(file);
    const page = (name: string, file: string, section: string): { page: DocPage; rendered: RenderedMarkdown } => {
      const rendered = renderMarkdown(readFileSync(join(source, file), 'utf8'), { file, pageOf, highlight: highlighter.highlight });
      return {
        rendered,
        page: {
          name,
          path: pageOf(file)!,
          file,
          title: rendered.title || name,
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
      const rendered = page(entry.slug, fileOf(entry), section);
      docPages.set(entry.slug, rendered.page);
      all.push(rendered);
    }
    const late = new Set(entries.filter(({ entry }) => entry.changes).map(({ entry }) => `/docs/${entry.slug}`));
    const index = new SearchIndex(
      all.flatMap(({ page: { path, title }, rendered }) =>
        rendered.sections.map((section) => ({ path, page: title, heading: section.heading, anchor: section.anchor, text: section.text, code: section.code, late: late.has(path) })),
      ),
    );
    const groups: NavigationGroup[] = docs.sections.map((section) => ({
      title: section.title,
      pages: section.pages.map((entry) => ({
        name: entry.slug,
        label: entry.label,
        path: `/docs/${entry.slug}`,
        ...(docPages.get(entry.slug)!.pending ? { pending: true as const } : {}),
      })),
    }));
    return { docs: docPages, navigation: { groups }, index };
  }

  /** Development: `docs/` and the root (for the policies that are pages) — for a changed, new or removed page (editors replace files). */
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
    for (const directory of [source, docsDir].filter((path) => existsSync(path))) {
      const watcher = watch(directory, (_event, file) => {
        if (file === null || directory === docsDir || rootFiles.has(file)) changed();
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
    if (entry.slug === 'search') {
      // The route /docs/search comes before /docs/:page: a page of this name could never be reached.
      problems.push("The page slug 'search' is reserved — /docs/search is the search.");
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
    if (file === 'README.md') {
      // A link to the root README stays code text (`pageOf` knows no README): as a page, its links and the start page would disagree.
      problems.push(`The page '${entry.slug}' names README.md — the root README is no page of the docs (the start page is the app's own).`);
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
