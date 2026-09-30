import { RedirectResult, type RedirectStatus } from './redirect.ts';
import { view, type ViewProps, type ViewResult } from './view.ts';

/**
 * Base class for invokable controllers (REPR): one class per endpoint.
 *
 * Subclasses implement `handle(ctx)`, which receives a typed `HttpContext` and
 * returns a `ViewResult` (a page), a `RedirectResult`, a `Response`, or plain data. `handle` is not
 * declared here as abstract, so implementations need no `override` keyword; the
 * router enforces its presence when the route is registered.
 */
export abstract class Controller {
  protected view<const TProps extends ViewProps>(component: string, props: TProps, status = 200): ViewResult<TProps> {
    return view(component, props, status);
  }

  protected json(data: unknown, status = 200): Response {
    return Response.json(data, { status });
  }

  /** `redirect('/login')`, or `redirect().route('user-profile.show', { id })` for a named route. */
  protected redirect(url?: string, status?: RedirectStatus): RedirectResult {
    return new RedirectResult(url, status);
  }

  /** Back to the previous page of this site (`Referer`), or to `fallback`. */
  protected back(fallback?: string): RedirectResult {
    return new RedirectResult().back(fallback);
  }
}
