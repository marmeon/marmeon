/**
 * Features that load on first use (E74): those an app turns on with a prop or an option of a component it uses anyway (a
 * form's `validate`), so a static import would put them in every app. Here are their `import()`s — the code is in a chunk of
 * its own, fetched the first time a form (or link) needs it.
 */
import type { Feature } from './feature.ts';
import type { LiveValidationFeature } from './features/live-validation.ts';
import type { LiveValidation, LiveValidationOptions } from './live-validation.ts';
import type { Navigator } from './navigation.ts';

/** Live validation (E62) — `navigator.load(loadLiveValidation)`. */
export const loadLiveValidation = (): Promise<Feature<LiveValidationFeature>> => import('./features/live-validation.ts').then((module) => module.liveValidation);

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
