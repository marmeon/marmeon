import { loadLive, type LiveUpdates } from '@marmeon/http/client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useRouterContext } from './app.tsx';

/** Live updates that wait — what `useLiveUpdates()` returns. */
export interface LiveUpdatesState {
  /** Hints came while a form on screen had unsaved changes: their reloads wait (no reload overwrote what was typed). */
  readonly pending: boolean;
  /** Reloads what waits now — the unsaved changes on screen may be overwritten. */
  apply(): void;
}

const noSubscription = () => () => {};

/**
 * Live props that wait for unsaved changes: the core reloads a page, an island or a layer on each hint by itself, but while a
 * guard holds (a dirty form: `useForm(…, { guard })`, `useBlocker`) the reloads wait — `pending` says so, `apply()` loads them.
 * Loads the live feature if nothing did yet (a chunk of its own). See docs/realtime.md#unsaved-changes.
 */
export function useLiveUpdates(): LiveUpdatesState {
  const navigator = useRouterContext().navigator();
  const [updates, setUpdates] = useState<LiveUpdates | undefined>(() => navigator?.loaded(loadLive)?.updates);
  useEffect(() => {
    if (!updates) navigator?.load(loadLive).then((feature) => setUpdates(feature.updates), () => {});
  }, [navigator, updates]);
  const pending = useSyncExternalStore(updates?.subscribe ?? noSubscription, () => updates?.pending === true, () => false);
  return { pending, apply: () => updates?.apply() };
}
