import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { RouteBinder } from '@marmeon/http';
import docsConfig, { GUIDES_GROUP, PACKAGES, type DocsDefinition, type DocsGuide } from '../../docs.config.ts';
import { createCodeHighlighter, type CodeHighlighter } from './highlight.ts';
import { renderMarkdown, type RenderedMarkdown } from './markdown.ts';
import { SearchIndex, type SearchResult } from './search.ts';
import type { DocNode, TocEntry } from './types.ts';

/** A page: the root README (`/`), a package's (`/packages/<name>`) or a guide (`/guides/<slug>`). */
export interface DocPage {
  readonly kind: 'home' | 'package' | 'guide';
  /** The package's name or the guide's slug — `null` for the start page. */
  readonly name: string | null;
  readonly path: string;
  /** The file's place in the repository: `packages/core/README.md`, `docs/deployment.md`. */
  readonly file: string;
  readonly title: string;
  readonly group: string | null;
  readonly body: DocNode[];
  readonly toc: TocEntry[];
  /** Every heading id — what a link's `#anchor` may name. */
  readonly anchors: readonly string[];
  readonly fileLinks: readonly string[];
}

/** The side navigation: the guides, then the groups of `docs.config.ts` — each entry with its page. */
export interface Navigation {
  readonly groups: readonly { readonly title: string; readonly pages: readonly { readonly name: string; readonly label: string; readonly path: string }[] }[];
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
  /** The repository: `README.md`, `packages/<name>/README.md`, `docs/*.md` and the guides at the root. */
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
  readonly guides: ReadonlyMap<string, DocPage>;
  readonly navigation: Navigation;
  readonly index: SearchIndex;
}

/**
 * The READMEs and guides as pages — read, rendered and indexed once when the app boots (in development again when one
 * changes). An app singleton that holds only the repository's content: nothing of a request, nothing a request could change.
 * Also the route binder of `/packages/:name` — an unknown package is a 404 ({@link GuideBinding} binds `/guides/:guide`).
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

  guide(slug: string): DocPage | undefined {
    return this.#state().guides.get(slug);
  }

  /** Every page, the start page first, then in the order of the navigation (the guides, the packages). */
  pages(): DocPage[] {
    const { home, guides, pages } = this.#state();
    return [home, ...guides.values(), ...pages.values()];
  }

  navigation(): Navigation {
    return this.#state().navigation;
  }

  /** The pages before and after `page` in the navigation — among the guides for a guide, among the packages for a package. */
  neighbours(page: DocPage): { previous: DocPage | null; next: DocPage | null } {
    const { guides, pages } = this.#state();
    const list = [...(page.kind === 'guide' ? guides : pages).values()];
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
    const guides = docs.guides ?? [];
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
    problems.push(...checkGuides(source, guides));
    if (problems.length > 0) throw new DocsError(problems);

    const names = new Set<string>(PACKAGES);
    const guideOf = new Map(guides.map((guide) => [guide.file, `/guides/${guide.slug}`]));
    const pageOf = (file: string) => {
      if (file === 'README.md') return '/';
      const guide = guideOf.get(file);
      if (guide) return guide;
      const name = /^packages\/([^/]+)\/README\.md$/.exec(file)?.[1];
      return name && names.has(name) ? `/packages/${name}` : undefined;
    };
    const render = (file: string): RenderedMarkdown =>
      renderMarkdown(readFileSync(join(source, file), 'utf8'), { file, pageOf, highlight: highlighter.highlight });
    const page = (kind: DocPage['kind'], name: string | null, file: string, group: string | null): { page: DocPage; rendered: RenderedMarkdown } => {
      const rendered = render(file);
      return {
        rendered,
        page: {
          kind,
          name,
          path: pageOf(file)!,
          file,
          title: rendered.title || (kind === 'package' ? `@marmeon/${name}` : kind === 'guide' ? name! : 'Marmeon'),
          group,
          body: rendered.body,
          toc: rendered.toc,
          anchors: rendered.anchors,
          fileLinks: rendered.fileLinks,
        },
      };
    };

    const home = page('home', null, 'README.md', null);
    const all = [home];
    const guidePages = new Map<string, DocPage>();
    for (const guide of guides) {
      const entry = page('guide', guide.slug, guide.file, GUIDES_GROUP);
      guidePages.set(guide.slug, entry.page);
      all.push(entry);
    }
    const pages = new Map<string, DocPage>();
    for (const group of docs.groups) {
      for (const name of group.packages) {
        const entry = page('package', name, `packages/${name}/README.md`, group.title);
        pages.set(name, entry.page);
        all.push(entry);
      }
    }
    const late = new Set(guides.filter((guide) => guide.changes).map((guide) => `/guides/${guide.slug}`));
    const index = new SearchIndex(
      all.flatMap(({ page: { path, title }, rendered }) =>
        rendered.sections.map((section) => ({ path, page: title, heading: section.heading, anchor: section.anchor, text: section.text, late: late.has(path) })),
      ),
    );
    const navigation: Navigation = {
      groups: [
        ...(guides.length > 0 ? [{ title: GUIDES_GROUP, pages: guides.map((guide) => ({ name: guide.slug, label: guide.label, path: `/guides/${guide.slug}` })) }] : []),
        ...docs.groups.map((group) => ({ title: group.title, pages: group.packages.map((name) => ({ name, label: name, path: `/packages/${name}` })) })),
      ],
    };
    return { home: home.page, pages, guides: guidePages, navigation, index };
  }

  /** Development: the root, `docs/` and every package directory, for a changed, new or removed README or guide (editors replace files). */
  #watch(): void {
    const { source } = this.#options;
    const guides = new Set((this.#options.docs ?? docsConfig).guides?.map((guide) => guide.file) ?? []);
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
    const directories = [source, join(source, 'packages'), join(source, 'docs'), ...PACKAGES.map((name) => join(source, 'packages', name))];
    for (const directory of directories.filter((path) => existsSync(path))) {
      const watcher = watch(directory, (_event, file) => {
        if (file === null || file === 'README.md' || directory.endsWith('packages') || directory.endsWith('docs') || (directory === source && guides.has(file))) changed();
      });
      watcher.unref();
      this.#watchers.push(watcher);
    }
  }
}

/** What a guide list and the repository must agree on: unique slugs and files, every listed file there, every `docs/*.md` listed. */
function checkGuides(source: string, guides: readonly DocsGuide[]): string[] {
  const problems: string[] = [];
  const slugs = new Set<string>();
  const files = new Set<string>();
  for (const guide of guides) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(guide.slug)) problems.push(`The guide slug '${guide.slug}' in docs.config.ts is not lower-case words with dashes.`);
    if (slugs.has(guide.slug)) problems.push(`The guide slug '${guide.slug}' is listed twice in docs.config.ts.`);
    if (files.has(guide.file)) problems.push(`${guide.file} is listed twice in docs.config.ts.`);
    slugs.add(guide.slug);
    files.add(guide.file);
    if (!/^[^/]+\.md$|^docs\/[^/]+\.md$/.test(guide.file)) problems.push(`The guide ${guide.file} is neither a Markdown file at the root nor in docs/.`);
    else if (!existsSync(join(source, guide.file))) problems.push(`docs.config.ts lists the guide ${guide.file}, but it does not exist in ${source}.`);
  }
  const docsDir = join(source, 'docs');
  if (existsSync(docsDir)) {
    for (const name of readdirSync(docsDir).filter((file) => file.endsWith('.md')).sort()) {
      if (!files.has(`docs/${name}`)) problems.push(`docs/${name} has no entry in docs.config.ts — add it to the guides.`);
    }
  }
  return problems;
}

/** `/guides/:guide` → its page, or a 404. */
export class GuideBinding implements RouteBinder<DocPage> {
  readonly #docs: DocsRepository;

  constructor(docs: DocsRepository) {
    this.#docs = docs;
  }

  resolveRouteBinding(value: string): DocPage | undefined {
    return this.#docs.guide(value);
  }
}
