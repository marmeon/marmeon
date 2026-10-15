/**
 * `revalidateOnBack`: what a view declares to reload when Back/Forward shows it from memory — the page, a layer or an
 * island shows at once, then those props load in the background, without a progress bar.
 */
import type { PageObject } from '../../page.ts';
import type { FeatureHost } from '../core.ts';
import { defineFeature } from '../feature.ts';
import type { Layer } from '../layer.ts';
import type { ReloadSpec } from '../optimistic.ts';
import type { RevalidateCore } from '../revalidate.ts';

/** What a view reloads when Back/Forward shows it from memory: all its props (`true`), some, or none (`false`). */
export type RevalidateOnBack = boolean | readonly string[];

/** What the adapter reads from a view (`Show.revalidateOnBack`) — see `NavigatorOptions.revalidateOnBack`. */
export type DeclaredRevalidation = (component: string) => RevalidateOnBack | undefined | Promise<RevalidateOnBack | undefined>;

type BackCore = Pick<FeatureHost, 'key' | 'left' | 'props'> & RevalidateCore;

/** The reloads of one navigator when Back/Forward shows a page, a layer or an island from memory. */
export class BackRevalidation {
  readonly #core: BackCore;
  readonly #declare: DeclaredRevalidation | undefined;

  constructor(core: BackCore, declare: DeclaredRevalidation | undefined) {
    this.#core = core;
    this.#declare = declare;
  }

  /** Back/Forward showed entry `key`'s page from memory: what its view declares reloads in the background. */
  async page(key: string, page: PageObject): Promise<void> {
    const spec = await this.#declared(page.component);
    if (!spec || this.#core.key !== key || this.#core.left) return;
    // In a chunk of its own, loaded by the first reload; a chunk that cannot load reloads nothing (what is shown stays).
    const module = await import('../revalidate.ts').catch(() => undefined);
    await module?.revalidate(this.#core, key, spec, new AbortController().signal);
  }

  /** Back/Forward showed a layer from memory: what its view declares reloads in the background. */
  async layer(layer: Layer): Promise<void> {
    const spec = await this.#declared(layer.page.component);
    if (!spec || layer.closed || this.#core.left) return;
    await layer.revalidate(spec);
  }

  /** What an island shown from memory by Back/Forward declares to reload — for the regions of entries brought back. */
  readonly region = (component: string): Promise<ReloadSpec | undefined> => this.#declared(component);

  /** What the view `component` reloads when Back/Forward shows it from memory — none when it says nothing (or not something valid). */
  async #declared(component: string): Promise<ReloadSpec | undefined> {
    if (!this.#declare) return undefined;
    let declared: RevalidateOnBack | undefined;
    try {
      declared = await this.#declare(component);
    } catch {
      return undefined;
    }
    if (declared === true) return {};
    if (Array.isArray(declared) && declared.length > 0 && declared.every((prop) => typeof prop === 'string')) return { only: [...declared] };
    return undefined;
  }
}

/**
 * `revalidateOnBack` as a feature: what a view declares (`NavigatorOptions.revalidateOnBack`) reloads when Back/Forward
 * shows its page, layer or island from memory. Keeps nothing. Attached by the adapter where views can declare it (React: the
 * pages of `resolveModulePages`).
 */
export const revalidateOnBack = defineFeature('revalidateOnBack', (host) => {
  const back = new BackRevalidation(host, host.options.revalidateOnBack);
  host.on('declared', back.region);
  host.on('restored', (page, key, layer) => {
    if (layer) return void back.layer(layer);
    void back.page(key, page);
    // The layers it brought back with the page, too.
    for (const over of host.layers) void back.layer(over);
  });
  return back;
}, 8);
