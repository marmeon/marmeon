import type { AnyMiddleware, ClassResolver, EmptyObject, Middleware, MiddlewareClass, MiddlewareHandler } from './types.ts';

/**
 * Declares a middleware as a name and a function. Type parameters are ordered by how often you need them: what it adds to the
 * context (`next({ user })`), then what it requires from an earlier middleware. See docs/middleware.md#middleware-objects.
 */
export function defineMiddleware<TAdds extends object = EmptyObject, TRequires extends object = EmptyObject>(
  name: string,
  handle: Middleware<TRequires, TAdds>['handle'],
): Middleware<TRequires, TAdds> {
  return { name, handle };
}

export interface PipelineOptions<TCtx> {
  /** Builds middleware classes, e.g. from the request's container scope. Defaults to `new Class()`. */
  resolve?: ClassResolver;
  /** Called with every layer that ran and has a `terminate` hook, and the context it saw. */
  onTerminable?: (handler: MiddlewareHandler<any, any>, ctx: TCtx) => void;
  /**
   * Turns an error into a response *at the layer where it was thrown* (Laravel's
   * routing pipeline does the same). Outer middleware then sees a normal
   * response — security headers, the session and cookies apply to error pages too.
   * Without it, errors propagate to the caller.
   */
  onError?: (error: unknown, ctx: TCtx) => Response | Promise<Response>;
}

/**
 * Runs `ctx` through the middleware onion (Laravel's `Pipeline`). Each layer may
 * short-circuit by returning a Response, or extend the context via `next({...})`.
 * Contexts are copied, never mutated, so a layer only sees what came before it.
 */
export function runPipeline<TCtx extends object>(
  ctx: TCtx,
  middleware: readonly AnyMiddleware[],
  destination: (ctx: TCtx) => Promise<Response>,
  { resolve = (Class) => new Class(), onTerminable, onError }: PipelineOptions<TCtx> = {},
): Promise<Response> {
  const guard = (run: () => Response | Promise<Response>, current: TCtx): Promise<Response> => {
    // Wrapping in a promise turns synchronous throws into rejections (including from constructors).
    const response = Promise.resolve().then(run);
    return onError ? response.catch((error: unknown) => onError(error, current)) : response;
  };

  const dispatch = (index: number, current: TCtx): Promise<Response> => {
    const layer = middleware[index];
    if (layer === undefined) return guard(() => destination(current), current);

    let nextCalled = false;
    const next = (extension?: object): Promise<Response> => {
      if (nextCalled) {
        return Promise.reject(new Error(`Middleware "${layer.name}" called next() more than once.`));
      }
      nextCalled = true;
      return dispatch(index + 1, extension ? { ...current, ...extension } : current);
    };

    return guard(() => {
      const handler: MiddlewareHandler<any, any> = isMiddlewareClass(layer) ? resolve(layer) : layer;
      if (handler.terminate) onTerminable?.(handler, current);
      return handler.handle(current, next);
    }, current);
  };

  return dispatch(0, ctx);
}

/** Classes carry `handle` on their prototype; `defineMiddleware` objects carry it themselves. */
export function isMiddlewareClass(layer: AnyMiddleware): layer is MiddlewareClass {
  return typeof layer === 'function';
}
