import { RedirectResult } from './redirect.ts';
import type { CheckViewName } from './page.ts';
import { island, type IslandResult } from './island.ts';
import { view, type PageResult, type ResultOptions, type ViewProps } from './view.ts';
import { CloseLayerResult, type CloseLayerOptions } from './layer.ts';
import { json, type JsonResult } from './json.ts';

/**
 * Base class for invokable controllers: one class per endpoint, whose `handle(ctx)` returns a page, a redirect, a `Response`
 * or plain data. `handle` is not declared abstract here, so implementations need no `override`; the router requires it when
 * the route is registered. See docs/controllers.md#writing-controllers.
 */
export abstract class Controller {
  /**
   * A page: `this.view('user-profile/Show', { profile })` — the name is checked against `modules/*\/views/**`. Or a layer
   * over the page on screen: `this.view('user-profile/Edit', { profile }).layer({ base: 'user-profile.show', params: { user } })`.
   */
  protected view<const V extends string, const TProps extends ViewProps>(component: CheckViewName<V>, props: TProps, options?: ResultOptions): PageResult<TProps, V> {
    return view<V, TProps>(component, props, options);
  }

  /**
   * Closes the layer the request came from — after a form in it was saved, say — and reloads what
   * is beneath: `this.closeLayer({ reload: ['profile'] })`. Without a layer (no JavaScript) it is a redirect: back, or where
   * `.route(…)` says. A flash message (`.flash('toast', …)`) fires with the close — or, as a redirect, on the page it leads to.
   */
  protected closeLayer(options?: CloseLayerOptions): CloseLayerResult {
    return new CloseLayerResult(options);
  }

  /**
   * An island — a part of a page that loads by itself: `this.island('dashboard/RecentSignIns', { entries })`, embedded
   * with `<Island route="dashboard.sign-ins">`. GET routes only (a type error on others): an island reads, it never
   * writes — its request cannot change the session, cookies or flash data. Not a page: visited directly, it is a 404.
   */
  protected island<const V extends string, const TProps extends ViewProps>(component: CheckViewName<V>, props: TProps): IslandResult<TProps, V> {
    return island<V, TProps>(component, props);
  }

  /**
   * Data as JSON — typed: an action (`useAction('user-profile.links.destroy')`) gets `Serialize<T>` back as `result.data`,
   * an API client the same JSON. `return this.json({ deleted: link.id })`.
   */
  protected json<T>(data: T, options?: ResultOptions): JsonResult<T> {
    return json(data, options);
  }

  /** `redirect('/login')`, or `redirect().route('user-profile.show', { user: id })` for a named route. */
  protected redirect(url?: string): RedirectResult {
    return new RedirectResult(url);
  }

  /** Back to the previous page of this site (`Referer`), or to `fallback`. */
  protected back(fallback?: string): RedirectResult {
    return new RedirectResult().back(fallback);
  }
}
