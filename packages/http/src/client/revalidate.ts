/**
 * Reloads the page of a history entry in the background — some props, or all — for the features that revalidate (an action's
 * optimistic patches, Back/Forward showing a page from memory): kept out of the loader every app carries.
 */
import type { FeatureHost } from './core.ts';
import { land, type LandCore } from './land.ts';
import { pick, resetOf } from './merge.ts';
import type { ReloadSpec } from './optimistic.ts';
import { partialReloadHeaders } from './request.ts';

/** What a revalidation needs of the navigator. */
export type RevalidateCore = LandCore & Pick<FeatureHost, 'fetchPage' | 'flushFlash'>;

/**
 * Reloads the page of entry `key` in the background and lands it there (on screen or in memory), `landed` running in the same
 * render (an action's patches go). A revalidation: what it brings replaces merged props (`ReloadSpec.reset`). No events, no
 * progress bar, no failure notice: what is shown stays when it fails. Resolves with whether it landed.
 */
export async function revalidate(
  core: RevalidateCore,
  key: string,
  spec: ReloadSpec,
  signal: AbortSignal,
  landed?: () => void,
): Promise<boolean> {
  const base = core.props.base(key);
  if (!base || core.left) return false;
  const partial = spec.only !== undefined || (spec.except?.length ?? 0) > 0;
  const loaded = await core.fetchPage(base.url, partial ? partialReloadHeaders(base.component, spec.only, spec.except) : {}, signal);
  // Another page (signed out meanwhile: the login page) is not what was asked for.
  if (!loaded || signal.aborted || loaded.component !== base.component) {
    core.flushFlash();
    return false;
  }
  const props = partial && spec.only ? pick(loaded.props, spec.only) : loaded.props;
  const merged = await land(core, key, base,{ ...loaded, props }, { replace: !partial, reset: resetOf(spec), landed });
  core.flushFlash();
  return merged !== undefined;
}
