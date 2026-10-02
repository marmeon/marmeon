/**
 * Optimistic patches on the pages of history entries (E59): over the props in memory, never in them — gone when their action
 * fails, folded into the props when it succeeded and nothing reloads them, replaced by the server's props when a reload lands.
 * (A layer keeps its own patches, `Layer`.) And a form's patches while its visit is under way (`visit({ optimistic })`).
 */
import type { PageObject } from '../../page.ts';
import { updatePage } from '../cache.ts';
import type { FeatureHost } from '../core.ts';
import { defineFeature, slot } from '../feature.ts';
import { applyPatches, listOf, PatchQueue, Revalidations, rollBack, type PatchTarget } from '../optimistic.ts';

/** The optimistic patches of one history entry's page, and the reloads actions start for it. */
interface EntryPatches {
  readonly queue: PatchQueue;
  readonly revalidations: Revalidations;
  readonly target: PatchTarget;
}

/**
 * The patches of the history entries' pages, by key — a slot of the document: nothing optimistic stays, and no reload lands,
 * when it is left. (Per document, not per entry: an action under way still settles its patches on an entry that left memory.)
 */
export const PATCHES = slot(
  'patches',
  () => new Map<string, EntryPatches>(),
  (entries) => {
    for (const { queue, revalidations } of entries.values()) {
      queue.clear();
      revalidations.abort();
    }
    entries.clear();
  },
);

type PatchesCore = Pick<FeatureHost, 'cache' | 'page' | 'key' | 'left' | 'transitioning' | 'draw' | 'setPage' | 'props' | 'document'>;

/** The patches of one navigator's history entries, by key. */
export class PagePatches {
  readonly #core: PatchesCore;

  constructor(core: PatchesCore) {
    this.#core = core;
  }

  get #entries(): Map<string, EntryPatches> {
    return this.#core.document(PATCHES);
  }

  /** The page of entry `key` as it is shown: the props in memory with the optimistic patches under way over them. */
  paint(key: string, page: PageObject): PageObject {
    return this.#entries.get(key)?.queue.apply(page) ?? page;
  }

  /** The patches the landing props of entry `key` take the place of (`drop`): gone in the same render. */
  drop(key: string, ids: ReadonlySet<number>): void {
    this.#entries.get(key)?.queue.remove(ids);
  }

  /** The optimistic patches of the page on screen — what an adapter's `router.optimistic` patches. */
  get page(): PatchTarget {
    return this.target(this.#core.key!);
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
          (united, all, signal) => this.#core.props.revalidate(key, united, signal, () => this.drop(key, all)),
          (all) => target.settle(all, true),
        ),
    };
    this.#entries.set(key, { queue, revalidations, target });
    return target;
  }

  /** The patches of entry `key` changed: shown again, if it is the page on screen. */
  #repaint(key: string): void {
    if (key !== this.#core.key || this.#core.transitioning || this.#core.left) return;
    void this.#core.draw(this.paint(key, this.#core.page), { preserveState: true });
  }
}

/**
 * Optimistic patches (E59) on the pages of history entries, as a feature: painted over the props in memory, never into them —
 * `navigator.use(optimistic).target(key)`. A form's visit shows its patches (of the page, a layer or an island) until its answer
 * lands, and rolls them back when it fails.
 */
export const optimistic = defineFeature('optimistic', (host) => {
  const patches = new PagePatches(host);
  host.on('paint', (key, page) => patches.paint(key, page));
  host.on('start', ({ options }) => {
    if (!options.optimistic) return undefined;
    const applied = applyPatches(listOf(options.optimistic));
    return {
      // The answer replaces what the patches showed — in the same render (the server's props then, or its errors).
      landed: () => {
        for (const [target, ids] of applied) target.settle(ids, false, { quiet: true });
      },
      // Failed, cancelled, or the browser took over: nothing of the patches stays.
      end: () => rollBack(applied),
    };
  });
  return patches;
});
