/**
 * Props that load in the background: deferred groups after a page is shown, and the groups the server streams with the
 * document. The loading itself (`prop-loader.ts`) is a chunk of its own, fetched when the first page that carries deferred
 * groups arrives — a page without them never loads it.
 */
import type { DeferredResult, PageObject } from '../page.ts';
import type { NavigatorCore } from './core.ts';
import type { PropLoader as Loader } from './prop-loader.ts';

type PropsCore = NavigatorCore;

/** The props one navigator loads in the background. */
export class PropLoader {
  readonly #core: PropsCore;
  /** The groups of the first page the server streams — until the loading code takes them over. */
  readonly #streamed: Set<string>;
  /** The history entry and page the document was loaded with. */
  #firstKey: string | undefined;
  #firstPage: PageObject;
  #loader: Promise<Loader | undefined> | undefined;
  #ready: Loader | undefined;

  constructor(core: PropsCore, firstPage: PageObject, streamed: readonly string[]) {
    this.#core = core;
    this.#firstPage = firstPage;
    this.#streamed = new Set(streamed);
    this.expect(firstPage);
  }

  /** A page arrived: when it carries deferred groups, their loading code is fetched now — beside the request that follows. */
  expect(page: PageObject): void {
    if (page.deferredProps || page.streamedProps) void this.#load();
  }

  /** The document's entry got its key: streamed groups land in it. */
  adopt(key: string, page: PageObject): void {
    this.#firstKey = key;
    this.#firstPage = page;
    this.#ready?.adopt(key, page);
  }

  /** The props in memory of entry `key`'s page — the server's (never a patch). */
  base(key: string): PageObject | undefined {
    return key === this.#core.key ? this.#core.page : this.#core.cache.peek(key)?.page;
  }

  /**
   * Loads the deferred props of the page on screen (`deferredProps`): one partial reload per group, in parallel, in
   * the background. Each one lands in the page it was loaded for — on screen, or in memory if it was left meanwhile.
   */
  load(): void {
    const { page, key } = this.#core;
    if (key === undefined || !page.deferredProps) return;
    this.#run((loader) => loader.loadPage(key, page));
  }

  /** Runs `load` for each deferred group of `page` (entry `key`) not under way already — nor on its way in the document's stream. */
  each(key: string, page: PageObject, load: (props: readonly string[]) => Promise<unknown>): void {
    if (!page.deferredProps) return;
    this.#run((loader) => loader.each(key, page, load));
  }

  /** A deferred group of the first page, as the server streamed it — see `Navigator.receiveStreamed`. */
  async receiveStreamed(group: string, streamed: DeferredResult | null): Promise<void> {
    // Not a streamed group, and the code not there: the first page streams none, nothing to fetch for it.
    const loader = this.#ready ?? (this.#streamed.has(group) ? await this.#load() : undefined);
    if (loader) return loader.receiveStreamed(group, streamed);
    // The code could not load: the group is asked for like any deferred group, by the loader that comes next.
    this.#streamed.delete(group);
  }

  /**
   * Right away once the code is there. A chunk that cannot load loads no group, and fires no `exception` event (a failed request
   * would): the groups stay unloaded and the next page that carries some tries the chunk again.
   */
  #run(run: (loader: Loader) => void): void {
    if (this.#ready) return run(this.#ready);
    void this.#load().then((loader) => {
      if (loader && !this.#core.left) run(loader);
    });
  }

  #load(): Promise<Loader | undefined> {
    return (this.#loader ??= import('./prop-loader.ts')
      .then(({ PropLoader }) => (this.#ready = new PropLoader(this.#core, this.#firstPage, [...this.#streamed], this.#firstKey)))
      .catch(() => (this.#loader = undefined)));
  }
}
