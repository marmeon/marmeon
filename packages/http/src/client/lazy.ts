/**
 * Features that load on first use (E74): those an app turns on with a prop or an option of a component it uses anyway (a
 * form's `validate`), so a static import would put them in every app. Here are their `import()`s — the code is in a chunk of
 * its own, fetched the first time a form (or link) needs it.
 */
import type { Feature } from './feature.ts';
import type { LiveValidationFeature } from './features/live-validation.ts';
import type { InstantVisits } from './features/instant.ts';
import type { LayerStack } from './features/layers.ts';
import type { Prefetches, PrefetchOptions } from './features/prefetch.ts';
import type { TabSync } from './features/tab-sync.ts';
import type { LiveValidation, LiveValidationOptions } from './live-validation.ts';
import type { Navigator } from './navigation.ts';

/**
 * Layers (E53, E71) — the core loads them itself the first time the server answers with a layer (or Back/Forward goes to a
 * layer's entry) and nothing attached them before; an adapter loads them where it opens one (`<Link layer>`) and before it
 * renders a deep link's document (`page.layers`): `navigator.load(loadLayers)`.
 */
export const loadLayers = (): Promise<Feature<LayerStack>> => import('./features/layers.ts').then((module) => module.layers);

/**
 * Tab sync (W8 step 8, E149) — a default feature of `createBespokeApp`, in a chunk of its own: the adapter loads it with the first
 * page's component and messages, before it hydrates, and attaches it from the start (`NavigatorOptions.features`).
 */
export const loadTabSync = (): Promise<Feature<TabSync>> => import('./features/tab-sync.ts').then((module) => module.tabSync);

/** Live validation (E62) — `navigator.load(loadLiveValidation)`. */
export const loadLiveValidation = (): Promise<Feature<LiveValidationFeature>> => import('./features/live-validation.ts').then((module) => module.liveValidation);

/** Prefetching (W5.6) — `navigator.load(loadPrefetch)`. */
export const loadPrefetch = (): Promise<Feature<Prefetches>> => import('./features/prefetch.ts').then((module) => module.prefetch);

/**
 * Fetches the page of `url` ahead (a hovered link, `router.prefetch`), loading the prefetch code first the first time (E74):
 * it is there while the pointer rests on the link, before the click. Once loaded, it prefetches at once — a press on the link
 * finds the page fetched while hovering before its click takes it. A chunk that cannot load fetches nothing: the visit asks
 * the server, as for any prefetch that fails.
 */
export function prefetchWith(navigator: Pick<Navigator, 'load' | 'loaded'>, url: string, options?: PrefetchOptions): Promise<void> {
  const loaded = navigator.loaded(loadPrefetch);
  if (loaded) return loaded.prefetch(url, options);
  return navigator.load(loadPrefetch).then((feature) => feature.prefetch(url, options), () => undefined);
}

/**
 * Instant visits (E64) — `navigator.load(loadInstant)`: an adapter loads it where a link with a placeholder renders, before
 * anyone clicks it. A visit with `instant` before the code is there goes without its placeholder (the page comes as always).
 */
export const loadInstant = (): Promise<Feature<InstantVisits>> => import('./features/instant.ts').then((module) => module.instant);

/** What a form uses of its live validation (E62). */
export type FormLiveValidation = Pick<LiveValidation, 'changed' | 'blurred' | 'validate' | 'cancel' | 'reset' | 'pending' | 'subscribe'>;

const NOTHING: readonly string[] = [];

/**
 * The live validation of one form at `url` that loads its code on first use (E74): the first field changed (or left, or a
 * `validate()`) fetches the feature's chunk, and what happened meanwhile happens again once it is there — the fields
 * touched, the field left. `cancel()` or `reset()` before then forget it all (a form sent or gone asks nothing). A chunk
 * that cannot load checks nothing — the server validates the form when it is sent — and is asked for again on the next
 * change.
 */
export function liveValidationOnFirstUse(navigator: Pick<Navigator, 'load'>, url: string, options: Omit<LiveValidationOptions, 'send'>): FormLiveValidation {
  let live: LiveValidation | undefined;
  type Waiting = (loaded: LiveValidation | undefined) => unknown;
  let waiting: Waiting[] | undefined;
  const listeners = new Set<() => void>();
  const call = (run: (loaded: LiveValidation | undefined) => unknown): void => {
    if (live) return void run(live);
    if (!waiting) {
      const ran: Waiting[] = (waiting = []);
      const replay = (loaded: LiveValidation | undefined) => {
        waiting = undefined;
        for (const next of ran.splice(0)) next(loaded);
      };
      navigator.load(loadLiveValidation).then((feature) => {
        live = feature.form(url, options);
        live.subscribe(() => listeners.forEach((listener) => listener()));
        replay(live);
      }, () => replay(undefined));
    }
    waiting.push(run);
  };
  // Before the code is there: what waits for it is dropped (a `validate()` ends cancelled).
  const forget = () => {
    for (const run of waiting?.splice(0) ?? []) run(undefined);
  };
  return {
    changed: (field) => call((loaded) => loaded?.changed(field)),
    blurred: (field) => call((loaded) => loaded?.blurred(field)),
    validate: (...fields) => new Promise((done) => call((loaded) => (loaded ? loaded.validate(...fields).then(done) : done({ kind: 'cancelled' })))),
    cancel: () => (live ? live.cancel() : forget()),
    reset: () => (live ? live.reset() : forget()),
    get pending() {
      return live?.pending ?? NOTHING;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
