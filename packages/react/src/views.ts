import { use } from 'react';
import type { PageComponent, ResolvePage } from './pages.ts';

/** A view being loaded or loaded — marked the way React reads a settled promise (`use()` returns at once, no suspending). */
type ViewPromise = Promise<PageComponent> & { status?: 'pending' | 'fulfilled' | 'rejected'; value?: PageComponent; reason?: unknown };

/**
 * Views of regions (islands, layers) by `resolve` and name — one promise each (loaded once per app, like a module): a view
 * shown before renders at once (Back/Forward), a new one suspends its boundary until it is there.
 */
const views = new WeakMap<ResolvePage, Map<string, ViewPromise>>();

/** The view `name`, loading — or loaded already (then `use()` reads it without suspending). */
export function loadView(resolve: ResolvePage, name: string): Promise<PageComponent> {
  let known = views.get(resolve);
  if (!known) views.set(resolve, (known = new Map()));
  let view = known.get(name);
  if (!view) {
    const loading: ViewPromise = resolve(name);
    loading.status = 'pending';
    const cache = known;
    loading.then(
      (Component) => {
        loading.status = 'fulfilled';
        loading.value = Component;
      },
      (error: unknown) => {
        loading.status = 'rejected';
        loading.reason = error;
        cache.delete(name); // asked again next time (offline, a chunk gone)
      },
    );
    known.set(name, (view = loading));
  }
  return view;
}

/** The view `name` while rendering — always through `use()`: the same call whether it suspends or not. */
export function viewOf(resolve: ResolvePage, name: string): PageComponent {
  return use(loadView(resolve, name));
}
