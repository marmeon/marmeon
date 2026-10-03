import type { CheckLayerBase, Param, ParamsOf, Query, QueryParams, RouteLookup, RouteNameInput } from '@bespokecore/router';
import { LAYER_CLOSE_HEADER, regionOf, type LayerClose } from './page.ts';
import { RedirectResult, type Flasher } from './redirect.ts';
import { carryFlash, serializedFlash, withFlashMethod, type FlashMethod } from './flash.ts';
import { carryLive, withLiveMethod, type LiveMethod, type PagePropNames } from './live.ts';
import type { ViewProps, ViewResult } from './view.ts';

const LAYER_RESULT = Symbol.for('bespokecore.layer-result');

/** The path parameters of the base: required when its path has required ones (like `<Link route params>`). */
type BaseParams<N extends string> = {} extends ParamsOf<N> ? { params?: ParamsOf<N> } : { params: ParamsOf<N> };

/**
 * Where a layer sits (E53): its `base` — the route a deep link (or a reload) of the layer's URL shows under it, a page or
 * another layer (then that one's base under it) — named like a link's: `{ base: 'user-profile.show', params: { user: 7 } }`.
 * Checked against the app's routes: a GET route that is not an island, its parameters typed.
 */
export type LayerOptions<N extends string> = {
  base: CheckLayerBase<N>;
  /** The base's query, typed by its query schema. */
  query?: QueryParams<N>;
  /**
   * The layer's identity in a stack (default: the view's name). An answer with the same key replaces the layer in place —
   * a form that failed validation, the next step of a wizard; another key opens on top.
   */
  key?: string;
} & BaseParams<N>;

/** Where a layer's base is, as the controller named it — resolved to a URL by the response factory (it knows the router). */
export interface LayerBaseRoute {
  readonly name: string;
  readonly params?: Readonly<Record<string, Param>> | undefined;
  readonly query?: Query | undefined;
}

/**
 * What a layer's controller returns (E53): a view shown over the page (or the layers) on screen instead of replacing it —
 * a modal, a slide-over. Opening it pushes a history entry, Back closes it. A deep link (or a reload) of its URL shows its
 * declared `base` under it, resolved on the server in-process — or, when the user may not see the base, the layer alone
 * over a neutral surface (E54). Still a view: `PageProps<Controller>` types its props.
 */
export interface LayerResult<TProps extends ViewProps = ViewProps, TComponent extends string = string> extends ViewResult<TProps, TComponent> {
  readonly [LAYER_RESULT]: true;
  /** The marker the router's types read (`LayerResultMarker`): `<Link layer>` takes only routes that answer a layer. */
  readonly region: 'layer';
  readonly layer: { readonly base: LayerBaseRoute; readonly key: string | undefined };
  /** A flash message delivered with the layer (E60) — see `PageResult.flash`. */
  readonly flash: FlashMethod<LayerResult<TProps, TComponent>>;
  /** Follows a live channel (W6.10) — see `PageResult.live`: a hint reloads `only` of the layer. */
  readonly live: LiveMethod<LayerResult<TProps, TComponent>, PagePropNames<TProps>, 'this layer'>;
}

export function isLayerResult(value: unknown): value is LayerResult {
  return typeof value === 'object' && value !== null && LAYER_RESULT in value;
}

/** `view` as a layer over `base` — what `this.view(…).layer({ base, params })` returns. */
export function toLayer<TProps extends ViewProps, V extends string>(
  view: ViewResult<TProps, V>,
  { base, params, query, key }: { base: string; params?: Readonly<Record<string, Param>> | undefined; query?: unknown; key?: string | undefined },
): LayerResult<TProps, V> {
  if (typeof base !== 'string') throw new Error(`A layer's base is a route name: got ${JSON.stringify(base)} for [${view.component}].`);
  const { layer: _layer, ...data } = view as ViewResult<TProps, V> & { layer?: unknown };
  const result = { ...data, [LAYER_RESULT]: true, region: 'layer', layer: { base: { name: base, params, query: query as Query | undefined }, key } } as LayerResult<TProps, V>;
  // What the view was flashed with, and the channels it follows, go with the layer.
  carryFlash(view, result);
  carryLive(view, result);
  return withLiveMethod(withFlashMethod(result));
}

/** The view's `.layer()` — on every result of `view()` (see `PageResult`). */
export type LayerMethod<TProps extends ViewProps, V extends string> = <const N extends RouteNameInput>(options: LayerOptions<N>) => LayerResult<TProps, V>;

export interface CloseLayerOptions {
  /** How many layers close, from the one that sent the request down (default 1 — just that one). */
  layers?: number;
  /**
   * Then reload what is beneath them — the page and every layer that stays, from the bottom up: some props (`['profile']`,
   * a partial reload of each; props one does not have are ignored) or `true` all of them. Default: nothing (they show what
   * they showed).
   */
  reload?: readonly string[] | true;
}

/**
 * What `closeLayer()` returns (E53, Inertia's `close()`): to a layer's request, "close" — the client closes the layer (and
 * `layers - 1` beneath it), then reloads what is under them (`reload`). To any other request — a form without JavaScript, a
 * layer's view opened as a page — it is the redirect it also is: `closeLayer().route('user-profile.show', { user })`,
 * by default back (to the `Referer`). A flash message (`.flash()`, E60) goes with the close to the layer's client — it fires
 * at once; as a redirect, with the page it leads to. Flash data (`.with()`) is kept for the next request either way.
 */
export class CloseLayerResult extends RedirectResult {
  readonly close: LayerClose;

  constructor({ layers = 1, reload }: CloseLayerOptions = {}) {
    super();
    if (!Number.isInteger(layers) || layers < 1) throw new Error(`closeLayer({ layers }) closes at least one layer, got ${layers}.`);
    this.close = { layers, ...(reload === undefined ? {} : { reload }) };
    // Without a layer (no JavaScript), back to where the form was — unless a target is set.
    this.back();
  }

  override toResponse(request: Request, routes: RouteLookup, flasher?: Flasher): Response {
    // Flash data and the target as for the redirect — `with()` data goes with the request that follows (the reload).
    const redirect = super.toResponse(request, routes, flasher);
    if (regionOf(request) !== 'layer') return redirect;
    // The client is shown the close: it takes the flash messages (E60) — they fire with it, not with whatever loads next.
    const flash = serializedFlash(flasher?.takeFlash() ?? []);
    return new Response(JSON.stringify({ close: this.close, ...(flash.length > 0 ? { flash } : {}) }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', [LAYER_CLOSE_HEADER]: 'true', vary: 'x-bespoke, x-bespoke-region' },
    });
  }
}

export function isCloseLayerResult(value: unknown): value is CloseLayerResult {
  return value instanceof CloseLayerResult;
}
