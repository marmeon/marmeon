/**
 * The History fallback (E184): where the browser has no Navigation API (Safari before 26.2, older browsers), the navigator
 * writes its entries with `pushState`/`replaceState` and follows Back/Forward by `popstate` — this feature, a chunk of its own,
 * attached before the navigator writes its first entry (`loadHistoryFallback`: createMarmeonApp loads it beside the first page's
 * component, only when `window.navigation` is missing). Every entry it writes is counted (`index`, a position like the scroll):
 * the browser moved already when `popstate` fires, so the navigation guard (E64) goes back (`history.go`), asks, and goes again.
 */
import { isPageObject } from '../../page.ts';
import { DEFAULT_LEAVE_MESSAGE } from '../confirm.ts';
import { defineFeature } from '../feature.ts';
import { isHistoryState, newKey, type HistoryState } from '../history.ts';
import { TOP } from '../scroll.ts';

/**
 * A history state to follow — the navigator's, or a whole page an older client kept in the history (before E36): never shown
 * from it, only its URL (a key of its own: the server is asked). Anything else (a fragment's, another script's) is none.
 */
function stateOf(value: unknown): HistoryState | undefined {
  if (isHistoryState(value)) return value;
  if (isPageObject(value)) return { component: value.component, url: value.url, key: newKey(), scroll: TOP.scroll };
  return undefined;
}

/** Where an entry is in the tab's history, as this fallback counted it — undefined for an entry it did not write. */
const indexOf = (state: unknown): number | undefined => {
  const index = isHistoryState(state) ? (state as { index?: unknown }).index : undefined;
  return typeof index === 'number' ? index : undefined;
};

export const historyFallback = defineFeature(
  'history',
  (host) => {
    const { window: win, history } = host;
    // Where the entry is: kept by a reload or a session restore, else the last (a fresh load pushes its entry at the end).
    let index = indexOf(win.history.state) ?? Math.max(0, (win.history.length ?? 1) - 1);
    /** The guard went back (E64): the popstate that brings the entry on screen back is no navigation. */
    let undoing: string | undefined;
    /** The user chose to leave: the popstate that goes again passes the guards. */
    let redoing = false;
    history.field('index', Number.isInteger);
    // The writer's own commit uses the History API without `window.navigation` — with the entry's place added.
    const write = history.commit;
    history.commit = (state, url, how) => {
      if (how === 'push') index += 1;
      write({ ...state, index } as HistoryState, url, how);
    };

    const onPopState = (event: Event): void => {
      // Nothing to follow: an entry of a fragment link (`#section`) on the same page (`null`), another script's.
      const state = stateOf((event as PopStateEvent).state);
      if (!state) return;
      if (undoing === state.key) return void (undoing = undefined);
      // A popstate a feature caused itself (a layer closing by going back): its close asked already.
      const own = host.own();
      const at = indexOf(state);
      if (!own && !redoing && at !== undefined && at !== index) {
        const target = new Set<string>([state.key, ...(state.layer?.below ?? [])]);
        const blocking = host.blocking((level) => !target.has(level === 0 ? host.key! : host.layers[level - 1]!.entry));
        const delta = at - index;
        if (blocking.length > 0 && win.history.go) {
          undoing = host.top();
          win.history.go(-delta);
          void host.ask({ kind: 'leave', message: blocking[0]!.message ?? DEFAULT_LEAVE_MESSAGE }).then((leave) => {
            if (!leave || host.left) return;
            redoing = true;
            win.history.go!(delta);
          });
          return;
        }
      }
      redoing = false;
      if (at !== undefined) index = at;
      void host.traverse(state, own);
    };
    host.on('started', () => win.addEventListener('popstate', onPopState));
    host.on('stopped', () => win.removeEventListener('popstate', onPopState));
  },
  0,
);
