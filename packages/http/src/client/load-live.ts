/**
 * Live props — server-driven like the layers: the core loads the feature when an answer follows a channel
 * (`PageObject.live`: a page, a layer, an island), so no first download carries it. A module of its own (not `lazy.ts`).
 */
import type { Feature } from './feature.ts';
import type { LiveFeature } from './features/live.ts';
import type { Navigator } from './navigation.ts';

export const loadLive = (): Promise<Feature<LiveFeature>> => import('./features/live.ts').then((module) => module.live);

/**
 * Follows what `object` (a page, a layer's page, a region object) says it follows — the first one loads the feature; each
 * makes it look at the screen again. A chunk that cannot load follows nothing (the page still works, without hints).
 */
export function follow(navigator: Pick<Navigator, 'load'>, object: { readonly live?: unknown } | undefined): void {
  if (object?.live) navigator.load(loadLive).then((feature) => feature.sync(), () => {});
}
