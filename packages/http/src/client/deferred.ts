/**
 * Props that load in the background: deferred groups after a page is shown, the groups the server streams
 * with the document, and reloads of an entry's page (an action's, Back's) — each landing in the page it was loaded for, on
 * screen or in memory.
 */
import type { DeferredResult, PageObject } from '../page.ts';
import { updatePage } from './cache.ts';
import type { NavigatorCore } from './core.ts';
import type { Visit } from './events.ts';
import { keepDeferred, mergePage, pick, resetOf, type ResetProps } from './merge.ts';
import type { ReloadSpec } from './optimistic.ts';
import { partialReloadHeaders } from './request.ts';

type PropsCore = Pick<
  NavigatorCore,
  'window' | 'cache' | 'page' | 'key' | 'left' | 'transitioning' | 'request' | 'send' | 'read' | 'fetchPage' | 'flushFlash' | 'draw' | 'paint' | 'setPage'
>;

/** The props one navigator loads in the background. */
export class PropLoader {
  readonly #core: PropsCore;
  /** Deferred props being loaded — `<history key> <group>`, so no group is asked for twice at once. */
  readonly #loading = new Set<string>();
  /**
   * Deferred groups of the first page that the server streams with the document (`streamedProps`): not asked for —
   * the adapter hands them over as they arrive (`receiveStreamed`).
   */
  readonly #streaming: Set<string>;
  /** The history entry and page the document was loaded with — what streamed deferred groups land in. */
  #firstKey: string | undefined;
  #firstPage: PageObject;

  constructor(core: PropsCore, firstPage: PageObject, streamed: readonly string[]) {
    this.#core = core;
    this.#firstPage = firstPage;
    this.#streaming = new Set(streamed);
  }

  /** The document's entry got its key: streamed groups land in it. */
  adopt(key: string, page: PageObject): void {
    this.#firstKey = key;
    this.#firstPage = page;
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
    if (key === undefined) return;
    this.each(key, page, (props) => this.#loadGroup(key, page, props));
  }

  /** Runs `load` for each deferred group of `page` (entry `key`) not under way already — nor on its way in the document's stream. */
  each(key: string, page: PageObject, load: (props: readonly string[]) => Promise<unknown>): void {
    if (!page.deferredProps) return;
    for (const [group, props] of Object.entries(page.deferredProps)) {
      const id = `${key} ${group}`;
      if (props.length === 0 || this.#loading.has(id)) continue;
      // On its way in the document's stream: not asked for.
      if (key === this.#firstKey && this.#streaming.has(group)) continue;
      this.#loading.add(id);
      void load(props).finally(() => this.#loading.delete(id));
    }
  }

  /** A deferred group of the first page, as the server streamed it — see `Navigator.receiveStreamed`. */
  async receiveStreamed(group: string, streamed: DeferredResult | null): Promise<void> {
    if (!this.#streaming.delete(group) || this.#core.left) return;
    const key = this.#firstKey;
    const page = this.#firstPage;
    if (streamed === null) {
      // Not streamed after all: loaded like any deferred group — for the first page when it is on screen (else when it is shown again).
      if (this.#core.key === key) this.load();
      return;
    }
    const doc = this.#core.window.document;
    if (doc?.readyState === 'loading' && doc.addEventListener) await new Promise<void>((done) => doc.addEventListener!('DOMContentLoaded', done, { once: true }));
    if (key === undefined) return;
    await this.land(key, page, { ...page, ...streamed, deferredProps: undefined } as PageObject);
  }

  /**
   * Merges loaded props into the page of history entry `key` — and shows it, if that is the page on screen. `replace`: the
   * loaded page is the whole page now (a full reload) — its deferred props keep their values until they load again. `reset`:
   * the merged props the loaded ones replace (a revalidation's: all). `landed`: what the landing props take the place of goes
   * (an action's optimistic patches) — in the same render.
   */
  async land(
    key: string,
    page: PageObject,
    loaded: PageObject,
    { replace = false, reset, landed }: { replace?: boolean; reset?: ResetProps; landed?: () => void } = {},
  ): Promise<PageObject | undefined> {
    // Left for a full page load (signed out, say): nothing lands in what this document shows any more.
    if (this.#core.left) return undefined;
    const onScreen = this.#core.key === key && !this.#core.transitioning;
    const target = onScreen ? this.#core.page : this.#core.cache.peek(key)?.page;
    // The entry shows another URL now (a replacing visit): these props are not for it.
    if (!target || target.url !== page.url || target.component !== page.component) return undefined;
    const merged = replace ? keepDeferred(target, loaded) : mergePage(target, loaded, reset);
    updatePage(this.#core.cache, key, merged);
    landed?.();
    if (onScreen) {
      this.#core.setPage(merged);
      await this.#core.draw(this.#core.paint(key, merged), { preserveState: true });
      if (replace) this.load();
    }
    return merged;
  }

  /**
   * Reloads the page of entry `key` in the background — some props, or all — and lands them there (on screen or in memory),
   * `landed` running in the same render (an action's patches go). A revalidation: what it brings replaces merged props
   * (`ReloadSpec.reset`). No events, no progress bar, no failure notice: what is shown stays when it fails. Resolves with whether
   * it landed.
   */
  async revalidate(key: string, spec: ReloadSpec, signal: AbortSignal, landed?: () => void): Promise<boolean> {
    const base = this.base(key);
    if (!base || this.#core.left) return false;
    const partial = spec.only !== undefined || (spec.except?.length ?? 0) > 0;
    const loaded = await this.#core.fetchPage(base.url, partial ? partialReloadHeaders(base.component, spec.only, spec.except) : {}, signal);
    // Another page (signed out meanwhile: the login page) is not what was asked for.
    if (!loaded || signal.aborted || loaded.component !== base.component) {
      this.#core.flushFlash();
      return false;
    }
    const props = partial && spec.only ? pick(loaded.props, spec.only) : loaded.props;
    const merged = await this.land(key, base, { ...loaded, props }, { replace: !partial, reset: resetOf(spec), landed });
    this.#core.flushFlash();
    return merged !== undefined;
  }

  async #loadGroup(key: string, page: PageObject, props: readonly string[]): Promise<void> {
    const visit: Visit = { url: page.url, method: 'get', async: true };
    await this.#core.request(visit, {}, async (signal) => {
      const response = await this.#core.send(page.url, { method: 'get', headers: partialReloadHeaders(page.component, props, undefined), signal });
      const loaded = await this.#core.read(response, { replace: true, failed: true }, visit, {});
      // Another page (signed out meanwhile: the login page) is not what was asked for — the fallback stays.
      if (!loaded || loaded.component !== page.component) return undefined;
      // Only the group's props: what comes `always` (the shared errors) belongs to the request that showed the page.
      return this.land(key, page, { ...loaded, props: pick(loaded.props, props) });
    });
  }
}
