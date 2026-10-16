import type { Layer, LayerCloseOptions } from '@marmeon/http/client';
import type { PageObject } from '@marmeon/http/protocol';
import { createContext, useContext, useEffect, useRef, type ComponentType, type ReactNode } from 'react';

/*
 * Layers as views see them: `useLayer()` and the types of a layer's frame. Small and static — a view that may be a layer
 * imports it. The layer stack that renders them (`layer-stack.tsx`) loads with the first layer, the default frame
 * (`LayerDialog`, `layer-dialog.tsx`) with it unless the app imports it for a frame of its own.
 */

export type { LayerCloseOptions } from '@marmeon/http/client';

/** How a layer looks: a dialog in the middle (`modal`) or a panel from the side (`slideover`). */
export type LayerVariant = 'modal' | 'slideover';

/** What a layer's frame gets: the layer, how it should look (the view's `layer` static), and the view. */
export interface LayerFrameProps {
  readonly layer: LayerState;
  readonly variant: LayerVariant;
  readonly children: ReactNode;
}

/**
 * The chrome around a layer's view — the app's (`createMarmeonApp({ layer })`) or a view's own (`View.layer = MyFrame`).
 * Default: {@link LayerDialog}. A frame is what makes a layer a dialog: focus, Escape, the backdrop, the close button.
 */
export type LayerFrame = ComponentType<LayerFrameProps>;

/** A view's look as a layer: `Edit.layer = 'slideover'`, or a frame of its own. Default: the app's frame, a modal. */
export type PageLayer = LayerVariant | LayerFrame;

/** What `useLayer()` tells a view — the layer it is rendered in, or that it is none (`isLayer: false`, a page). */
export interface LayerState {
  /**
   * Rendered as a layer — false for the same view rendered as a page: its controller answered without `.layer()`, or the
   * answer would have opened a layer beyond the tenth (`MAX_LAYER_DEPTH` of `@marmeon/http/protocol`). A link without `layer` opens a layer all the same.
   */
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
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') console.warn('[marmeon] useLayer().close() outside a layer does nothing — check useLayer().isLayer first.');
    return Promise.resolve();
  },
  onClose: () => () => {},
};

/** @internal The layer around a view — provided by the layer stack (`layer-stack.tsx`, loaded with the first layer). */
export const LayerContext = createContext<LayerState | null>(null);

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
 * The layer around this view — `close()` it, react to it closing (`onClose`), know how deep it is, or whether the view is a
 * layer at all (`isLayer`: a view can be a page and a layer). Given the view's controller, a controller that never answers a
 * layer is a compile error. See docs/dialogs.md#inside-a-layer.
 */
// oxlint-disable-next-line no-unused-vars -- C is checked where useLayer<C>() is called, never used inside
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
