/**
 * The dev hook: `globalThis.__MARMEON_DEVTOOLS_HOOK__`, set before the app starts. The client core calls it when a
 * navigator is made — the bar attaches its data feature (`devtools` of `@marmeon/http/client`) there — and with what only it
 * sees: optimistic patches, and hydration errors from the React adapter. Those calls exist in development builds only.
 */
import { devtools, devtoolsReports, type DevtoolsFeature, type DevtoolsGlobal, type DevtoolsHook, type Navigator } from '@marmeon/http/client';

/** A navigator the bar attached to, with what it records of it. */
export interface Attached {
  readonly navigator: Navigator;
  readonly api: DevtoolsFeature;
}

/** Sets the dev hook on `target`: `onAttach` runs for each navigator made (an app makes one). Returns the function that takes it away. */
export function installDevtoolsHook(target: DevtoolsGlobal, onAttach: (attached: Attached) => void): () => void {
  let current: DevtoolsFeature | undefined;
  // Every navigator made records from the start (an island loads before the app's navigator starts); the one that takes over the
  // history is the app's — the others (React renders the tree again after a hydration error, with a new one) stop.
  const made = new Set<DevtoolsFeature>();
  const { flush, ...reports } = devtoolsReports(() => current);
  const hook: DevtoolsHook = {
    navigator(navigator) {
      const api = navigator.use(devtools);
      made.add(api);
      api.onStarted(() => {
        for (const other of made) if (other !== api) other.stop();
        made.clear();
        current = api;
        // What came before it started (a hydration error while the first page hydrated) goes to it now.
        flush();
        onAttach({ navigator, api });
      });
    },
    ...reports,
  };
  target.__MARMEON_DEVTOOLS_HOOK__ = hook;
  return () => {
    if (target.__MARMEON_DEVTOOLS_HOOK__ === hook) delete target.__MARMEON_DEVTOOLS_HOOK__;
  };
}
