import { view, type ViewProps, type ViewResult } from './view.ts';

/**
 * Base class for invokable controllers (REPR): one class per endpoint.
 *
 * Subclasses implement `handle(ctx)`, which receives a typed `HttpContext` and
 * returns a `ViewResult` (a page), a `Response`, or plain data. `handle` is not
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

  protected redirect(location: string, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
    return new Response(null, { status, headers: { location } });
  }
}
