import type { CheckViewName, SharedProps } from './page.ts';
import type { ResolvedProps } from './props.ts';
import { toLayer, type LayerMethod } from './layer.ts';
import { addFlash, type FlashMethod } from './flash.ts';
import { addLive, type LiveMethod, type PagePropNames } from './live.ts';

const VIEW_RESULT = Symbol.for('marmeon.view-result');

/** The props a view takes: a record by prop name. See docs/pages.md#props. */
export type ViewProps = Record<string, unknown>;

/** What `view()` and `json()` take besides the data: the response's `status` (default 200) and extra `headers`. */
export interface ResultOptions {
  readonly status?: number;
  /** Extra response headers, e.g. `Retry-After` on an error page. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A number where the options belong is the old positional status — refused with the way out. */
export function assertResultOptions(name: string, options: unknown): void {
  if (typeof options !== 'object' || options === null) throw new TypeError(`${name}(): pass the status as { status: 422 }`);
}

/** What a controller returns to render a page. The server decides how (SSR HTML or JSON). */
export interface ViewResult<TProps extends ViewProps = ViewProps, TComponent extends string = string> {
  readonly [VIEW_RESULT]: true;
  readonly component: TComponent;
  readonly props: TProps;
  readonly status: number;
  /** Extra response headers, e.g. `Retry-After` on an error page. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * What `view()` returns: a page — or, with `.layer({ base })`, a layer over the page on screen:
 *
 * ```ts
 * return this.view('user-profile/Edit', { profile }).layer({ base: 'user-profile.show', params: { user: profile.id } });
 * ```
 */
export interface PageResult<TProps extends ViewProps = ViewProps, TComponent extends string = string> extends ViewResult<TProps, TComponent> {
  /**
   * Shows the view as a layer (a modal, a slide-over) over whatever is on screen, with a history entry of its own — Back
   * closes it. `base` (with its `params`) is the page a deep link or a reload of its URL shows under it — checked against the
   * app's routes, like a link's. `key` (default: the view's name): an answer with the same key replaces the layer in
   * place (a failed form, a wizard's next step), another key stacks on top.
   */
  readonly layer: LayerMethod<TProps, TComponent>;
  /**
   * A flash message delivered with this page — typed by the app's `FlashData`: `this.view('auth/Tokens', { tokens })
   * .flash('toast', { kind: 'info', message })`. It fires once in the browser, with this response (after a redirect, use
   * `redirect().flash()`).
   */
  readonly flash: FlashMethod<PageResult<TProps, TComponent>>;
  /**
   * Follows a live channel: when the server hints that it changed (`broadcast.refresh('users.7', { only })`),
   * the browser reloads `only` of this page — `this.view('user-profile/Show', { profile }).live(\`users.${id}\`, { only:
   * ['profile'] })`. Signed for the session: whoever may see the page may hear its hints. Needs @marmeon/live.
   */
  readonly live: LiveMethod<PageResult<TProps, TComponent>, PagePropNames<TProps>>;
}

/**
 * A page: the component's name — checked against the app's views (`modules/<module>/views/<Page>.tsx`,
 * see `marmeon route:types`) — and its props.
 */
export function view<const V extends string, const TProps extends ViewProps>(
  component: CheckViewName<V>,
  props: TProps,
  options: ResultOptions = {},
): PageResult<TProps, V> {
  assertResultOptions('view', options);
  const { status = 200, headers } = options;
  const result: PageResult<TProps, V> = {
    [VIEW_RESULT]: true,
    component: component as V,
    props,
    status,
    ...(headers ? { headers } : {}),
    layer: (options) => toLayer(result, options),
    flash: ((key: string, data: unknown) => addFlash(result, key, data)) as PageResult<TProps, V>['flash'],
    live: ((channel: string, options?: { only?: readonly string[] }) => addLive(result, channel, options)) as PageResult<TProps, V>['live'],
  };
  // Not enumerable: a result is data (spread, compared in tests) — the methods are no part of it.
  Object.defineProperty(result, 'layer', { enumerable: false });
  Object.defineProperty(result, 'flash', { enumerable: false });
  Object.defineProperty(result, 'live', { enumerable: false });
  return result;
}

export function isViewResult(value: unknown): value is ViewResult {
  return typeof value === 'object' && value !== null && VIEW_RESULT in value;
}

/** Flattens `A & B` into one object type — readable tooltips, exact type equality. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

type Unserializable = undefined | symbol | ((...args: never[]) => unknown);

/**
 * What a value becomes on its way to the browser — `JSON.parse(JSON.stringify(value))` as a type:
 * `Date` (anything with `toJSON`) → its JSON form (`string`), `undefined` properties → optional,
 * functions and symbols → gone (`null` inside arrays), `bigint` → `never` (JSON.stringify throws).
 * Page props are typed with it, so a view sees what actually arrives.
 */
export type Serialize<T> = 0 extends 1 & T
  ? T // any
  : unknown extends T
    ? unknown
    : SerializeKnown<T>;

type SerializeKnown<T> = T extends string | number | boolean | null
  ? T
  : T extends bigint
    ? never
    : T extends Unserializable
      ? never
      : T extends { toJSON(...args: never[]): infer R }
        ? Serialize<R>
        : T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>
          ? {}
          : T extends readonly unknown[]
            ? { -readonly [I in keyof T]: SerializeElement<T[I]> }
            : T extends object
              ? SerializeObject<T>
              : never;

/** Inside arrays, what JSON cannot hold becomes `null` (instead of disappearing). */
type SerializeElement<E> = E extends Unserializable ? null : Serialize<E>;

type SerializeObject<T> = Simplify<
  { [K in keyof T as K extends symbol ? never : undefined extends T[K] ? never : T[K] extends Unserializable ? never : K]: Serialize<T[K]> } & {
    [K in keyof T as K extends symbol ? never : undefined extends T[K] ? ([Exclude<T[K], undefined>] extends [never] ? never : K) : never]?: Serialize<
      Exclude<T[K], undefined>
    >;
  }
>;

/** A controller class instance (`handle(ctx)`) or a route closure. */
type PageAction = { handle: (...args: never[]) => unknown } | ((...args: never[]) => unknown);

type ActionResult<TAction extends PageAction> = TAction extends { handle: (...args: never[]) => infer R }
  ? R
  : TAction extends (...args: never[]) => infer R
    ? R
    : never;

/**
 * Infers a page's props from the controller that renders it (`PageProps<ShowUserProfileController>`): its view branches only,
 * plus the `SharedProps` (a controller's own prop of the same name wins), typed as they arrive — resolved (`optional()` and
 * `defer()` props are `T | undefined`) and serialized (`Serialize`: a `Date` prop is a `string`). See docs/responses.md#pages.
 */
export type PageProps<TAction extends PageAction> =
  Awaited<ActionResult<TAction>> extends infer TResult
    ? TResult extends ViewResult<infer TProps>
      ? Serialize<Omit<SharedProps, keyof TProps> & ResolvedProps<TProps>>
      : never
    : never;

/** The page name(s) a controller renders: `ViewOf<ShowUserProfileController>` is `'user-profile/Show'`. */
export type ViewOf<TAction extends PageAction> =
  Awaited<ActionResult<TAction>> extends infer TResult ? (TResult extends ViewResult<ViewProps, infer V> ? V : never) : never;
