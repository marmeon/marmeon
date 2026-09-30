import { view, type ViewProps, type ViewResult } from './view.ts';

/**
 * Base class for all controllers. Actions receive a typed `HttpContext` from the
 * router and return either a `ViewResult` (a page), a `Response`, or plain data.
 */
export abstract class BaseController {
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
