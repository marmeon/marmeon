/**
 * Instant visits (E64): the target view's placeholder shows at once, the page when its answer lands. The page on screen
 * stays the navigator's (and its entry the current one) until then — a visit that ends without its page shows it again.
 */
import type { PageObject } from '../../page.ts';
import type { NavigatorCore } from '../core.ts';
import type { Scroll } from '../scroll.ts';

/** The placeholder an instant visit shows (E64): the target's view and what the link hands its placeholder. */
export interface InstantVisit {
  readonly component: string;
  readonly props?: Readonly<Record<string, unknown>>;
}

/** An instant visit's placeholder on screen (E64): where the page under it was scrolled to. */
export interface InstantShown {
  readonly leaving: Scroll;
}

type InstantCore = Pick<
  NavigatorCore,
  'window' | 'scroll' | 'cache' | 'page' | 'key' | 'owner' | 'layers' | 'left' | 'transitioning' | 'render' | 'draw' | 'paint' | 'setPage'
>;

/** The instant visits of one navigator — the placeholder on screen, if any. */
export class InstantVisits {
  readonly #core: InstantCore;
  /** The placeholder of an instant visit on screen (E64) — until its page lands, or the visit ends without one. */
  #shown: InstantShown | undefined;

  constructor(core: InstantCore) {
    this.#core = core;
  }

  /** Where the page under the placeholder on screen was scrolled to — undefined without one. */
  get leaving(): Scroll | undefined {
    return this.#shown?.leaving;
  }

  /** Shows an instant visit's placeholder (E64) over the page on screen — the page stays the navigator's, its entry the current one. */
  show(instant: InstantVisit, url: string): InstantShown {
    const shown: InstantShown = { leaving: this.#core.scroll.current() };
    this.#shown = shown;
    this.#core.scroll.cancelSave();
    // Swapping in: what lands for the page on screen meanwhile (a deferred prop, a poll) goes to memory, scroll events to nobody.
    this.#core.transitioning = true;
    const page: PageObject = { component: instant.component, props: { ...(instant.props ?? {}) }, url };
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
    void this.#core.draw(this.#core.paint(key, page), { preserveState: false, owner: this.#core.owner, layers: this.#core.layers }).then(() => this.#core.scroll.apply(shown.leaving));
  }

  /** A page takes the place of the placeholder. */
  replaced(): void {
    this.#shown = undefined;
  }

  /** Back/Forward during an instant visit (E64): the visit is cancelled, and what the entry shows takes the placeholder's place. */
  cancel(): void {
    if (!this.#shown) return;
    this.#shown = undefined;
    this.#core.transitioning = false;
  }
}
