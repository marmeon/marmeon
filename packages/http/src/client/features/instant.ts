/**
 * Instant visits: the target view's placeholder shows at once, the page when its answer lands. The page on screen
 * stays the navigator's (and its entry the current one) until then — a visit that ends without its page shows it again. Its
 * code loads where an instant link renders (`loadInstant` in `lazy.ts`): a visit before then shows no placeholder.
 */
import type { PageObject } from '../../protocol.ts';
import type { FeatureHost } from '../core.ts';
import { defineFeature, type PendingVisit, type VisitPart } from '../feature.ts';
import type { Scroll } from '../scroll.ts';

/** The placeholder an instant visit shows: the target's view and what the link hands its placeholder. */
export interface InstantVisit {
  readonly component: string;
  readonly props?: Readonly<Record<string, unknown>>;
}

/** An instant visit's placeholder on screen: where the page under it was scrolled to. */
export interface InstantShown {
  readonly leaving: Scroll;
}

type InstantCore = Pick<FeatureHost, 'window' | 'scroll' | 'cache' | 'page' | 'key' | 'owner' | 'left' | 'transitioning' | 'render' | 'draw' | 'paint' | 'setPage'>;

/** The instant visits of one navigator — the placeholder on screen, if any. */
export class InstantVisits {
  readonly #core: InstantCore;
  /** The placeholder of an instant visit on screen — until its page lands, or the visit ends without one. */
  #shown: InstantShown | undefined;

  /** @internal */
  constructor(core: InstantCore) {
    this.#core = core;
  }

  /**
   * What an instant visit adds to a visit that starts (the `start` hook): its placeholder once the request goes, gone when it
   * ends without its page. Only for a plain GET visit of a page that is not here already (fetched ahead) — nothing it keeps.
   * @internal
   */
  start({ options, method, keeps, layer, takes, ready, url }: PendingVisit): VisitPart | undefined {
    const instant = options.instant;
    if (!instant || method !== 'get' || keeps || layer || (takes && ready)) return undefined;
    let shown: InstantShown | undefined;
    return {
      // Its newer visit took over the screen (the older one's placeholder ends when it ends — after this one shows its own).
      sending: (signal) => void (signal.aborted || (shown = this.show(instant, url))),
      // Ended without its page (failed, cancelled, a 409 postponed): the page on screen comes back, where it was scrolled to.
      end: () => shown && this.end(shown),
    };
  }

  /** Where the page under the placeholder on screen was scrolled to — undefined without one. */
  get leaving(): Scroll | undefined {
    return this.#shown?.leaving;
  }

  /** Shows an instant visit's placeholder over the page on screen — the page stays the navigator's, its entry the current one. */
  show(instant: InstantVisit, url: string): InstantShown {
    const shown: InstantShown = { leaving: this.#core.scroll.current() };
    this.#shown = shown;
    this.#core.scroll.cancelSave();
    // Swapping in: what lands for the page on screen meanwhile (a deferred prop, a poll) goes to memory, scroll events to nobody.
    this.#core.transitioning = true;
    const page: PageObject = { component: instant.component, props: { ...instant.props }, url };
    void this.#core.render(page, { preserveState: false, owner: this.#core.owner, layers: [], placeholder: true }).then(
      () => {
        if (this.#shown === shown) this.#core.window.scrollTo(0, 0);
      },
      () => undefined,
    );
    return shown;
  }

  /** The instant visit ended without its page: the page on screen again (as memory has it now), scrolled to where it was. */
  end(shown: InstantShown): void {
    if (this.#shown !== shown || this.#core.left) return;
    this.#shown = undefined;
    this.#core.transitioning = false;
    const key = this.#core.key!;
    const page = this.#core.cache.peek(key)?.page ?? this.#core.page;
    this.#core.setPage(page);
    void this.#core.draw(this.#core.paint(key, page), { preserveState: false }).then(() => this.#core.scroll.apply(shown.leaving));
  }

  /** A page takes the place of the placeholder. */
  replaced(): void {
    this.#shown = undefined;
  }

  /** Back/Forward during an instant visit: the visit is cancelled, and what the entry shows takes the placeholder's place. */
  cancel(): void {
    if (!this.#shown) return;
    this.#shown = undefined;
    this.#core.transitioning = false;
  }
}

/** Instant visits as a feature: the placeholder while the page loads. Keeps no data — only where the page under it was scrolled. */
export const instant = /* @__PURE__ */ defineFeature('instant', (host) => {
  const visits = new InstantVisits(host);
  host.on('start', (visit) => visits.start(visit));
  host.on('position', () => visits.leaving);
  host.on('draw', () => visits.replaced());
  host.on('popState', () => visits.cancel());
  return visits;
}, 3);
