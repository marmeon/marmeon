/**
 * The loading of deferred props, in a chunk of its own: loaded when a page that carries deferred groups arrives
 * (`deferredProps`, `streamedProps`) — see `deferred.ts`. Each group lands in the page it was loaded for, on screen or in memory.
 */
import type { DeferredResult, PageObject } from '../page.ts';
import type { NavigatorCore } from './core.ts';
import type { Visit } from './events.ts';
import { land } from './land.ts';
import { MERGE_MARKS, pick } from './merge.ts';
import { partialReloadHeaders } from './request.ts';

type PropsCore = Pick<NavigatorCore, 'window' | 'cache' | 'page' | 'key' | 'left' | 'transitioning' | 'request' | 'send' | 'read' | 'draw' | 'paint' | 'setPage' | 'props'>;

/** The deferred props one navigator loads in the background. */
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

  constructor(core: PropsCore, firstPage: PageObject, streamed: readonly string[], firstKey: string | undefined) {
    this.#core = core;
    this.#firstPage = firstPage;
    this.#firstKey = firstKey;
    this.#streaming = new Set(streamed);
  }

  /** The document's entry got its key: streamed groups land in it. */
  adopt(key: string, page: PageObject): void {
    this.#firstKey = key;
    this.#firstPage = page;
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

  /** One partial reload per deferred group of `page` (entry `key`), in parallel, in the background. */
  loadPage(key: string, page: PageObject): void {
    this.each(key, page, (props) => this.#loadGroup(key, page, props));
  }

  /** A deferred group of the first page, as the server streamed it — see `Navigator.receiveStreamed`. */
  async receiveStreamed(group: string, streamed: DeferredResult | null): Promise<void> {
    if (!this.#streaming.delete(group) || this.#core.left) return;
    const key = this.#firstKey;
    const page = this.#firstPage;
    if (streamed === null) {
      // Not streamed after all: loaded like any deferred group — for the first page when it is on screen (else when it is shown again).
      if (this.#core.key === key) this.#core.props.load();
      return;
    }
    const doc = this.#core.window.document;
    if (doc?.readyState === 'loading' && doc.addEventListener) await new Promise<void>((done) => doc.addEventListener!('DOMContentLoaded', done, { once: true }));
    if (key === undefined) return;
    // Only the props of this group are taken: the block is data from the document, never the page's component, URL or other props.
    await land(this.#core, key, page, { ...page, ...pick(streamed, MERGE_MARKS), props: pick(streamed.props, page.deferredProps?.[group] ?? []), deferredProps: undefined });
  }

  async #loadGroup(key: string, page: PageObject, props: readonly string[]): Promise<void> {
    const visit: Visit = { url: page.url, method: 'get', async: true };
    await this.#core.request(visit, {}, async (signal) => {
      const response = await this.#core.send(page.url, { method: 'get', headers: partialReloadHeaders(page.component, props, undefined), signal });
      const loaded = await this.#core.read(response, { replace: true, failed: true }, visit, {});
      // Another page (signed out meanwhile: the login page) is not what was asked for — the fallback stays.
      if (!loaded || loaded.component !== page.component) return undefined;
      // Only the group's props: what comes `always` (the shared errors) belongs to the request that showed the page.
      return land(this.#core, key, page, { ...loaded, props: pick(loaded.props, props) });
    });
  }
}
