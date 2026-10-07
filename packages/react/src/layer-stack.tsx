import { layers } from '@marmeon/http/client';
import type { PageObject } from '@marmeon/http/page';
import { Suspense, useContext, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { RegionOwnerContext, reloadsOf, RouterContext, type RouterValue } from './app.tsx';
import { ErrorBoundary, RenderErrorFallback } from './fallbacks.tsx';
import { LayerDialog } from './layer-dialog.tsx';
import { LayerContext, type LayerEntry, type LayerFrame, type LayerState, type LayerVariant } from './layer.tsx';
import type { ResolvePage } from './pages.ts';
import { RoutesContext } from './routes.ts';
import { loadView, viewOf } from './views.ts';

/*
 * The layer stack (E53) — loaded with the first layer (E71): the core loads it when the server answers with one (the app's
 * navigator is given it as `loadLayers`: one chunk with the core's layers), `<Link layer>` when it renders, `createMarmeonApp`
 * and the SSR entry before they render a deep link's document.
 */

/** @internal The core's layers feature, loaded with the stack that renders them. */
export { layers };

const noSubscription = () => () => {};

/**
 * The layers over the page (E53), bottom first — each in its frame, with a router of its own (`usePage`, `useRouter`,
 * `useForm` and links inside act as the layer), its islands in its own memory. The page beneath does not scroll while any
 * is open.
 * @internal
 */
export function LayerStack({ entries, resolve, frame, base }: { entries: readonly LayerEntry[]; resolve: ResolvePage; frame: LayerFrame | undefined; base: RouterValue }) {
  const open = entries.length > 0;
  useLayoutEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    // The page keeps its scroll position under the layers, and does not move.
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = previous;
    };
  }, [open]);
  if (!open) return null;
  // In an element: a Suspense boundary at the top of the tree would hold the server's whole shell back.
  return (
    <div data-marmeon-layers="">
      {entries.map((entry, index) => (
        <LayerScope key={entry.id} entry={entry} isTop={index === entries.length - 1} resolve={resolve} frame={frame} base={base} />
      ))}
    </div>
  );
}

function LayerScope({ entry, isTop, resolve, frame, base }: { entry: LayerEntry; isTop: boolean; resolve: ResolvePage; frame: LayerFrame | undefined; base: RouterValue }) {
  const { layer } = entry;
  // What its view renders: its props with the optimistic patches under way over them (E59).
  const live = useSyncExternalStore(layer?.subscribe ?? noSubscription, () => layer?.view ?? entry.page, () => entry.page);
  const manifest = useContext(RoutesContext);
  // An answer with another view (a wizard's next step, the new token replacing its form): shown once its view is loaded —
  // until then the layer keeps what it shows. Suspending would hide the dialog (out of the modal state, focus on the page).
  const [shown, setShown] = useState(live);
  const view = loadView(resolve, live.component) as Promise<unknown> & { status?: string };
  const ready = view.status === 'fulfilled';
  useEffect(() => {
    if (ready || live === shown) return undefined;
    let current = true;
    void view.then(
      () => current && setShown(live),
      () => current && setShown(live), // its error boundary shows the failure
    );
    return () => {
      current = false;
    };
  }, [live, ready, shown, view]);
  const page = ready ? live : shown;
  const router = useMemo<RouterValue>(
    () => ({
      ...base,
      page,
      layer,
      // A visit or a form inside the layer is the layer's (E53): its answer replaces it, opens another or closes it.
      visit: (url, options) => (layer ? layer.visit(url, options) : Promise.resolve(undefined)),
      reload: (options) => (layer ? layer.reload(options) : Promise.resolve(undefined)),
      prefetch: (url, options) => base.prefetch(url, { ...options, layer: true }),
      // An action's patches and reloads from inside the layer are the layer's (E59).
      optimistic: (patch) => {
        if (!layer) throw new Error(process.env.NODE_ENV !== 'production' ? '[marmeon:R14] Actions run in the browser, not while rendering on the server.' : '[marmeon:R14]');
        return layer.optimistic(patch as never);
      },
      reloading: (options) => {
        if (!layer) throw new Error(process.env.NODE_ENV !== 'production' ? '[marmeon:R14] Actions run in the browser, not while rendering on the server.' : '[marmeon:R14]');
        return reloadsOf((spec) => layer.reloading(spec), layer.owner, manifest, options as { islands?: readonly string[] });
      },
    }),
    [base, page, layer, manifest],
  );
  const state = useMemo<LayerState>(
    () => ({
      isLayer: true,
      depth: entry.depth,
      isTop,
      key: page.layer?.key ?? page.component,
      once: page.layer?.once === true,
      close: (options) => (layer ? layer.close(options) : Promise.resolve()),
      onClose: (listener) => (layer ? layer.onClose(listener) : () => {}),
    }),
    [entry.depth, isTop, page, layer],
  );
  return (
    <RouterContext.Provider value={router}>
      <RegionOwnerContext.Provider value={layer?.owner ?? null}>
        <LayerContext.Provider value={state}>
          <Suspense fallback={null}>
            <LayerContent resolve={resolve} page={page} frame={frame} state={state} />
          </Suspense>
        </LayerContext.Provider>
      </RegionOwnerContext.Provider>
    </RouterContext.Provider>
  );
}

function LayerContent({ resolve, page, frame, state }: { resolve: ResolvePage; page: PageObject; frame: LayerFrame | undefined; state: LayerState }) {
  const View = viewOf(resolve, page.component);
  const own = View.layer;
  const Frame = typeof own === 'function' ? own : (frame ?? LayerDialog);
  const variant: LayerVariant = typeof own === 'string' ? own : 'modal';
  return (
    <Frame layer={state} variant={variant}>
      <ErrorBoundary resetKey={page} fallback={(error) => <RenderErrorFallback resolve={resolve} error={error} />}>
        <View {...page.props} />
      </ErrorBoundary>
    </Frame>
  );
}
