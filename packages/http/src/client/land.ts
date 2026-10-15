import type { PageObject } from '../page.ts';
import { updatePage } from './cache.ts';
import type { NavigatorCore } from './core.ts';
import { keepDeferred, mergePage, type ResetProps } from './merge.ts';

/** What landing props needs of the navigator. */
export type LandCore = Pick<NavigatorCore, 'cache' | 'page' | 'key' | 'left' | 'transitioning' | 'props' | 'setPage' | 'draw' | 'paint'>;

/**
 * Merges loaded props into the page of history entry `key` — and shows it, if that is the page on screen. `replace`: the
 * loaded page is the whole page now (a full reload) — its deferred props keep their values until they load again. `reset`:
 * the merged props the loaded ones replace (a revalidation's: all). `landed`: what the landing props take the place of goes
 * (an action's optimistic patches) — in the same render.
 */
export async function land(
  core: LandCore,
  key: string,
  page: PageObject,
  loaded: PageObject,
  { replace = false, reset, landed }: { replace?: boolean; reset?: ResetProps; landed?: () => void } = {},
): Promise<PageObject | undefined> {
  // Left for a full page load (signed out, say): nothing lands in what this document shows any more.
  if (core.left) return undefined;
  const onScreen = core.key === key && !core.transitioning;
  const target = onScreen ? core.page : core.cache.peek(key)?.page;
  // The entry shows another URL now (a replacing visit): these props are not for it.
  if (!target || target.url !== page.url || target.component !== page.component) return undefined;
  const merged = replace ? keepDeferred(target, loaded) : mergePage(target, loaded, reset);
  updatePage(core.cache, key, merged);
  landed?.();
  if (onScreen) {
    core.setPage(merged);
    await core.draw(core.paint(key, merged), { preserveState: true });
    if (replace) core.props.load();
  }
  return merged;
}
