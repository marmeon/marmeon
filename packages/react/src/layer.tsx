import type { Layer, LayerCloseOptions } from '@bespokecore/http/client';
import type { PageObject } from '@bespokecore/http/page';
import {
  createContext,
  Suspense,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { RegionOwnerContext, reloadsOf, RouterContext, type RouterValue } from './app.tsx';
import { RoutesContext } from './routes.ts';
import { ErrorBoundary, RenderErrorFallback } from './fallbacks.tsx';
import type { ResolvePage } from './pages.ts';
import { loadView, viewOf } from './views.ts';

export type { LayerCloseOptions } from '@bespokecore/http/client';

/** How a layer looks: a dialog in the middle (`modal`) or a panel from the side (`slideover`). */
export type LayerVariant = 'modal' | 'slideover';

/** What a layer's frame gets: the layer, how it should look (the view's `layer` static), and the view. */
export interface LayerFrameProps {
  readonly layer: LayerState;
  readonly variant: LayerVariant;
  readonly children: ReactNode;
}

/**
 * The chrome around a layer's view — the app's (`createBespokeApp({ layer })`) or a view's own (`View.layer = MyFrame`).
 * Default: {@link LayerDialog}. A frame is what makes a layer a dialog: focus, Escape, the backdrop, the close button.
 */
export type LayerFrame = ComponentType<LayerFrameProps>;

/** A view's look as a layer (E53): `Edit.layer = 'slideover'`, or a frame of its own. Default: the app's frame, a modal. */
export type PageLayer = LayerVariant | LayerFrame;

/** What `useLayer()` tells a view — the layer it is rendered in, or that it is none (`isLayer: false`, a page). */
export interface LayerState {
  /** Rendered as a layer — false for the same view rendered as a page (a link without `layer`, depth beyond the limit). */
  readonly isLayer: boolean;
  /** 1 for the first layer over the page, 2 for one over that … — 0 for a page. */
  readonly depth: number;
  /** The topmost layer: the one that takes the keyboard (the ones beneath are inert). */
  readonly isTop: boolean;
  /** Its key (default: its view's name) — an answer with the same key replaces it in place. */
  readonly key: string | undefined;
  /** The answer of an action, shown once (its content is gone when it closes). */
  readonly once: boolean;
  /**
   * Closes it (and the layers over it) — Back in the history, when it was opened right over what is beneath — then
   * `reload` reloads what is beneath: some props (`['profile']`) or `true` all of them. A page has nothing to close.
   */
  close(options?: LayerCloseOptions): Promise<void>;
  /** Runs `listener` once the layer left the screen (closed, Back, a page visit). Returns the function that stops it. */
  onClose(listener: () => void): () => void;
}

const OUTSIDE: LayerState = {
  isLayer: false,
  depth: 0,
  isTop: false,
  key: undefined,
  once: false,
  close: () => {
    if (process.env.NODE_ENV !== 'production') console.warn('[bespoke] useLayer().close() outside a layer does nothing — check useLayer().isLayer first.');
    return Promise.resolve();
  },
  onClose: () => () => {},
};

const LayerContext = createContext<LayerState | null>(null);

type LayerAction = { handle: (...args: never[]) => unknown };

/** Whether controller `C` answers a layer in some branch (`this.view(…).layer(…)`) — any controller when it is not known. */
type AnswersLayer<C> = C extends { handle: (...args: never[]) => infer R }
  ? unknown extends R
    ? true
    : [Extract<Awaited<R>, { readonly region: 'layer' }>] extends [never]
      ? false
      : true
  : false;

/** The constraint of `useLayer<C>()`: a layer's controller — a message for one that never answers a layer. */
type LayerController<C> = AnswersLayer<C> extends true
  ? LayerAction
  : { handle: 'this controller never answers a layer — useLayer<C>() is for the view of a layer: its controller returns this.view(…).layer({ base })' };

export interface UseLayerOptions {
  /** Runs once the layer leaves the screen — closed, Back, a page visit (not when its own answer replaces it in place). */
  onClose?: () => void;
}

/**
 * The layer around this view (E53) — `close()` it, react to it closing (`onClose`), know how deep it is, or whether the
 * view is a layer at all (`isLayer`: a view can be a page and a layer).
 *
 * ```tsx
 * export default function Edit({ profile }: PageProps<EditUserProfileController>) {
 *   const layer = useLayer<EditUserProfileController>();
 *   const form = useForm('user-profile.update', { user: profile.id }, { name: profile.name });   // submits as the layer
 *   return layer.isLayer ? <button onClick={() => layer.close()}>Cancel</button> : <Link route="user-profile.show" …>Cancel</Link>;
 * }
 * ```
 *
 * Given the view's controller, a controller that never answers a layer is a compile error.
 */
export function useLayer<C extends LayerController<C> = LayerAction>({ onClose }: UseLayerOptions = {}): LayerState {
  const state = useContext(LayerContext) ?? OUTSIDE;
  const listener = useRef(onClose);
  listener.current = onClose;
  const wanted = onClose !== undefined;
  useEffect(() => (wanted ? state.onClose(() => listener.current?.()) : undefined), [state, wanted]);
  return state;
}

/** One layer to render: the core's (in the browser), or only its page object (the server renders a deep link's). */
export interface LayerEntry {
  readonly id: string;
  readonly layer: Layer | null;
  readonly page: PageObject;
  readonly depth: number;
}

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
    <div data-bespoke-layers="">
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
      prefetch: (url, options) => base.navigator()?.prefetch(url, { ...options, layer: true }) ?? Promise.resolve(),
      // An action's patches and reloads from inside the layer are the layer's (E59).
      optimistic: (patch) => {
        if (!layer) throw new Error(process.env.NODE_ENV !== 'production' ? '[bespoke:R14] Actions run in the browser, not while rendering on the server.' : '[bespoke:R14]');
        return layer.optimistic(patch as never);
      },
      reloading: (options) => {
        if (!layer) throw new Error(process.env.NODE_ENV !== 'production' ? '[bespoke:R14] Actions run in the browser, not while rendering on the server.' : '[bespoke:R14]');
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

export interface LayerDialogProps extends LayerFrameProps {
  /** The close button's accessible name (default `Close` — pass the app's translation). */
  closeLabel?: string;
  className?: string;
  /** Merged over the default look (a few inline properties: a strict CSP blocks no inline style property). */
  style?: CSSProperties;
}

const LOOK: Record<LayerVariant, CSSProperties> = {
  modal: { padding: 0, border: 'none', borderRadius: 8, width: 'min(36rem, calc(100vw - 2rem))', maxHeight: 'calc(100dvh - 2rem)', boxShadow: '0 12px 32px rgba(0, 0, 0, 0.25)' },
  slideover: { padding: 0, border: 'none', margin: '0 0 0 auto', width: 'min(28rem, 100vw)', maxWidth: '100vw', height: '100dvh', maxHeight: '100dvh', boxShadow: '-8px 0 24px rgba(0, 0, 0, 0.2)' },
};

/**
 * The default frame of a layer: a native `<dialog>`, opened modally — the browser keeps focus inside it and makes the page
 * (and the layers beneath) inert; named by its first heading, described by an element with `data-layer-description`. Escape, the close button and a click on the
 * backdrop close it (Back in the history); focus returns to what opened it. Unstyled but for a few inline properties
 * (`data-bespoke-layer`, `data-variant` to style it). Wrap it for the app's labels:
 * `createBespokeApp({ layer: (props) => <LayerDialog {...props} closeLabel={t('close')} /> })`.
 */
export function LayerDialog({ layer, variant, children, closeLabel = 'Close', className, style }: LayerDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  // What had the focus — the link that opened it — gets it back when the layer goes. Read while rendering: by the time the
  // effects run, an `autoFocus` field inside has taken it.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement));
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    if (typeof element.showModal === 'function' && !isModal(element)) {
      // React focused an `autoFocus` field already (it never writes the attribute): showModal() would move the focus to
      // the first focusable element instead — the destructive button of a confirmation, say. It stays where the view put it.
      const chosen = element.contains(element.ownerDocument.activeElement) ? element.ownerDocument.activeElement : null;
      // Server-rendered (a deep link) it is open, but not modal yet.
      if (element.open) element.close();
      name(element, id);
      element.showModal();
      if (chosen instanceof HTMLElement && chosen !== element.ownerDocument.activeElement) chosen.focus();
    }
    // Modal now (not before: a server-rendered, not yet modal dialog must not hide the page from screen readers).
    element.setAttribute('aria-modal', 'true');
    return () => {
      // Out of the modal state first: while it is modal, everything outside is inert and refuses the focus. A task later:
      // when two layers close at once, the one over this is gone by then (its opener inside this one, disconnected).
      if (element.open) element.close();
      queueMicrotask(() => {
        if (opener instanceof HTMLElement && opener.isConnected && opener !== opener.ownerDocument.body) opener.focus({ preventScroll: true });
      });
    };
  }, []);
  // Its name (and description) on every commit: an answer that replaces the layer in place brings another heading.
  useLayoutEffect(() => {
    if (dialog.current) name(dialog.current, id);
  });
  /** Where a press on the dialog began — a click on the backdrop closes only when it began there too (not a text selection). */
  const pressed = useRef<EventTarget | null>(null);
  return (
    <dialog
      ref={dialog}
      open
      data-bespoke-layer={layer.key}
      data-variant={variant}
      data-depth={layer.depth}
      className={className}
      style={{ ...LOOK[variant], ...style }}
      onCancel={(event) => {
        // Escape: closed by the layer (Back), not by the browser — the dialog stays until the layer goes.
        event.preventDefault();
        void layer.close();
      }}
      onPointerDown={(event) => {
        pressed.current = event.target;
      }}
      onClick={(event) => {
        // The backdrop: a click on the dialog element itself, outside its content — pressed there as well.
        if (event.target === event.currentTarget && pressed.current === event.currentTarget) void layer.close();
      }}
    >
      <div style={{ padding: '1.5rem', paddingInlineEnd: '3rem' }}>{children}</div>
      <button
        type="button"
        data-bespoke-layer-close=""
        aria-label={closeLabel}
        onClick={() => void layer.close()}
        style={{ position: 'absolute', top: 8, insetInlineEnd: 8, font: 'inherit', fontSize: '1.25rem', lineHeight: 1, padding: '4px 8px', cursor: 'pointer', background: 'none', border: 'none' }}
      >
        ×
      </button>
    </dialog>
  );
}

/**
 * Names the dialog by its first heading (`aria-labelledby`) and describes it by `[data-layer-description]` — unless the app
 * named it itself. Development warns when there is no heading: a dialog without a name.
 */
function name(element: HTMLDialogElement, id: string): void {
  const own = (attribute: string) => element.hasAttribute(attribute) && element.getAttribute(`data-bespoke-${attribute}`) === null;
  if (!own('aria-labelledby') && !element.hasAttribute('aria-label')) {
    const heading = element.querySelector('h1, h2, h3');
    if (heading) {
      if (!heading.id) heading.id = `${id}-title`;
      element.setAttribute('aria-labelledby', heading.id);
      element.setAttribute('data-bespoke-aria-labelledby', '');
    } else if (process.env.NODE_ENV !== 'production') {
      console.warn(`[bespoke] The layer [${element.dataset.bespokeLayer}] has no heading (h1–h3) to name its dialog — add one, or wrap LayerDialog with an aria-label.`);
    }
  }
  if (!own('aria-describedby')) {
    const description = element.querySelector('[data-layer-description]');
    if (description) {
      if (!description.id) description.id = `${id}-description`;
      element.setAttribute('aria-describedby', description.id);
      element.setAttribute('data-bespoke-aria-describedby', '');
    } else if (element.hasAttribute('data-bespoke-aria-describedby')) {
      element.removeAttribute('aria-describedby');
    }
  }
}

function isModal(element: HTMLDialogElement): boolean {
  try {
    return element.matches(':modal');
  } catch {
    return false;
  }
}
