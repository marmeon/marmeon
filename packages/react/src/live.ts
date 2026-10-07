import { loadLive, type LiveUpdates } from '@marmeon/http/client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useRouterContext } from './app.tsx';

/** Live updates that wait (W6.10) — what `useLiveUpdates()` returns. */
export interface LiveUpdatesState {
  /** Hints came while a form on screen had unsaved changes: their reloads wait (no reload overwrote what was typed). */
  readonly pending: boolean;
  /** Reloads what waits now — the unsaved changes on screen may be overwritten. */
  apply(): void;
}

const noSubscription = () => () => {};

/**
 * Live props that wait for unsaved changes (W6.10, E104): a page (island, layer) follows a channel — the core reloads it on
 * each hint by itself; only while a guard holds (a dirty form: `useForm(…, { guard })`, `useBlocker`) the reloads wait, and
 * this says so:
 *
 * ```tsx
 * const updates = useLiveUpdates();
 * {updates.pending && <p role="status">Updates available <button onClick={updates.apply}>Show</button></p>}
 * ```
 *
 * Loads the live feature if nothing did yet (a chunk of its own).
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
