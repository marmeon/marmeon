/**
 * Optimistic patches on the pages of history entries (E59): over the props in memory, never in them — gone when their action
 * fails, folded into the props when it succeeded and nothing reloads them, replaced by the server's props when a reload lands.
 * (A layer keeps its own patches, `Layer`.)
 */
import type { PageObject } from '../../page.ts';
import { updatePage } from '../cache.ts';
import type { NavigatorCore } from '../core.ts';
import { PatchQueue, Revalidations, type PatchTarget } from '../optimistic.ts';

/** The optimistic patches of one history entry's page, and the reloads actions start for it. */
interface EntryPatches {
  readonly queue: PatchQueue;
  readonly revalidations: Revalidations;
  readonly target: PatchTarget;
}

type PatchesCore = Pick<NavigatorCore, 'cache' | 'page' | 'key' | 'owner' | 'layers' | 'left' | 'transitioning' | 'draw' | 'setPage' | 'props'>;

/** The patches of one navigator's history entries, by key. */
export class PagePatches {
  readonly #core: PatchesCore;
  readonly #entries = new Map<string, EntryPatches>();

  constructor(core: PatchesCore) {
    this.#core = core;
  }

  /** The page of entry `key` as it is shown: the props in memory with the optimistic patches under way over them. */
  paint(key: string, page: PageObject): PageObject {
    return this.#entries.get(key)?.queue.apply(page) ?? page;
  }

  /** The patches the landing props of entry `key` take the place of (`drop`): gone in the same render. */
  drop(key: string, ids: ReadonlySet<number>): void {
    this.#entries.get(key)?.queue.remove(ids);
  }

  /** Nothing optimistic stays, and no reload lands any more — the document is left. */
  clear(): void {
    for (const { queue, revalidations } of this.#entries.values()) {
      queue.clear();
      revalidations.abort();
    }
    this.#entries.clear();
  }

  /** The optimistic patches of entry `key` — a target for actions, kept apart from the page in memory. */
  target(key: string): PatchTarget {
    const existing = this.#entries.get(key);
    if (existing) return existing.target;
    const queue = new PatchQueue();
    const revalidations = new Revalidations();
    const target: PatchTarget = {
      add: (patch) => {
        const id = queue.add(patch);
        this.#repaint(key);
        return id;
      },
      settle: (ids, commit, { quiet = false } = {}) => {
        if (!ids.some((id) => queue.has(id))) return;
        const base = commit ? this.#core.props.base(key) : undefined;
        // Its action succeeded and nothing reloads it: what the patches show is the state now — in memory, like a reload's props.
        if (base) {
          const folded = queue.fold(base, ids);
          updatePage(this.#core.cache, key, folded);
          if (key === this.#core.key) this.#core.setPage(folded);
        }
        queue.remove(ids);
        if (!quiet) this.#repaint(key);
      },
      revalidate: (spec, ids) =>
        revalidations.run(
          spec,
          ids,
          (united, all, signal) => this.#core.props.revalidate(key, united, all, signal),
          (all) => target.settle(all, true),
        ),
    };
    this.#entries.set(key, { queue, revalidations, target });
    return target;
  }

  /** The patches of entry `key` changed: shown again, if it is the page on screen. */
  #repaint(key: string): void {
    if (key !== this.#core.key || this.#core.transitioning || this.#core.left) return;
    void this.#core.draw(this.paint(key, this.#core.page), { preserveState: true, owner: this.#core.owner, layers: this.#core.layers });
  }
}
