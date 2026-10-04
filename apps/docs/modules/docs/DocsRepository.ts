import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { RouteBinder } from '@bespokecore/http';
import docsConfig, { PACKAGES, type DocsDefinition, type PackageName } from '../../docs.config.ts';
import { createCodeHighlighter, type CodeHighlighter } from './highlight.ts';
import { renderMarkdown, type RenderedMarkdown } from './markdown.ts';
import { SearchIndex, type SearchResult } from './search.ts';
import type { DocNode, TocEntry } from './types.ts';

/** A page: the root README (`/`) or a package's (`/packages/<name>`). */
export interface DocPage {
  /** The package's name — `null` for the start page. */
  readonly name: PackageName | null;
  readonly path: string;
  /** The README's place in the repository: `packages/core/README.md`. */
  readonly file: string;
  readonly title: string;
  readonly group: string | null;
  readonly body: DocNode[];
  readonly toc: TocEntry[];
  /** Every heading id — what a link's `#anchor` may name. */
  readonly anchors: readonly string[];
  readonly fileLinks: readonly string[];
}

/** The side navigation: the groups of `docs.config.ts`, each package with its page. */
export interface Navigation {
  readonly groups: readonly { readonly title: string; readonly packages: readonly { readonly name: string; readonly path: string }[] }[];
}

/** The docs cannot start: a README without its place in `docs.config.ts`, or a place without its README. */
export class DocsError extends Error {
  override readonly name = 'DocsError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`The docs cannot start:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.problems = problems;
  }
}

export interface DocsRepositoryOptions {
  /** The repository: `README.md` and `packages/<name>/README.md`. */
  readonly source: string;
  /** Re-read when a README changes (development). */
  readonly watch?: boolean;
  readonly docs?: DocsDefinition;
  /** Told when a re-read after a change fails (the pages stay as they were). */
  readonly onReloadError?: (error: unknown) => void;
}

interface Loaded {
  readonly home: DocPage;
  readonly pages: ReadonlyMap<string, DocPage>;
  readonly navigation: Navigation;
  readonly index: SearchIndex;
}

/**
 * The READMEs as pages — read, rendered and indexed once when the app boots (in development again when one changes). An
 * app singleton that holds only the repository's content: nothing of a request, nothing a request could change. Also the
 * route binder of `/packages/:name` — an unknown package is a 404.
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

  /** Reads and renders every README; throws {@link DocsError} when the repository and `docs.config.ts` disagree. */
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

  home(): DocPage {
    return this.#state().home;
  }

  page(name: string): DocPage | undefined {
    return this.#state().pages.get(name);
  }

  /** Every page, the start page first, then in the order of the navigation. */
  pages(): DocPage[] {
    const { home, pages } = this.#state();
    return [home, ...pages.values()];
  }

  navigation(): Navigation {
    return this.#state().navigation;
  }

  /** The pages before and after `name` in the navigation. */
  neighbours(name: string): { previous: DocPage | null; next: DocPage | null } {
    const pages = [...this.#state().pages.values()];
    const at = pages.findIndex((page) => page.name === name);
    return { previous: pages[at - 1] ?? null, next: pages[at + 1] ?? null };
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
    if (!existsSync(join(source, 'README.md'))) problems.push(`${join(source, 'README.md')} is missing — the start page.`);
    if (problems.length > 0) throw new DocsError(problems);

    const names = new Set<string>(PACKAGES);
    const pageOf = (file: string) => {
      if (file === 'README.md') return '/';
      const name = /^packages\/([^/]+)\/README\.md$/.exec(file)?.[1];
      return name && names.has(name) ? `/packages/${name}` : undefined;
    };
    const render = (file: string): RenderedMarkdown =>
      renderMarkdown(readFileSync(join(source, file), 'utf8'), { file, pageOf, highlight: highlighter.highlight });
    const page = (name: PackageName | null, file: string, group: string | null): { page: DocPage; rendered: RenderedMarkdown } => {
      const rendered = render(file);
      return {
        rendered,
        page: {
          name,
          path: pageOf(file)!,
          file,
          title: rendered.title || (name ? `@bespokecore/${name}` : 'BespokeCore'),
          group,
          body: rendered.body,
          toc: rendered.toc,
          anchors: rendered.anchors,
          fileLinks: rendered.fileLinks,
        },
      };
    };

    const home = page(null, 'README.md', null);
    const all = [home];
    const pages = new Map<string, DocPage>();
    for (const group of docs.groups) {
      for (const name of group.packages) {
        const entry = page(name, `packages/${name}/README.md`, group.title);
        pages.set(name, entry.page);
        all.push(entry);
      }
    }
    const index = new SearchIndex(
      all.flatMap(({ page: { path, title }, rendered }) =>
        rendered.sections.map((section) => ({ path, page: title, heading: section.heading, anchor: section.anchor, text: section.text })),
      ),
    );
    const navigation: Navigation = {
      groups: docs.groups.map((group) => ({ title: group.title, packages: group.packages.map((name) => ({ name, path: `/packages/${name}` })) })),
    };
    return { home: home.page, pages, navigation, index };
  }

  /** Development: the root and every package directory, for a changed, new or removed README (editors replace files). */
  #watch(): void {
    const { source } = this.#options;
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
    const directories = [source, join(source, 'packages'), ...PACKAGES.map((name) => join(source, 'packages', name))];
    for (const directory of directories.filter((path) => existsSync(path))) {
      const watcher = watch(directory, (_event, file) => {
        if (file === null || file === 'README.md' || directory.endsWith('packages')) changed();
      });
      watcher.unref();
      this.#watchers.push(watcher);
    }
  }
}
