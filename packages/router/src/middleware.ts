import type { AnyMiddleware, ClassResolver, EmptyObject, Middleware, MiddlewareClass, MiddlewareHandler } from './types.ts';

/**
 * Declares a middleware. Type parameters are ordered by how often you need them:
 *
 * ```ts
 * const authenticate = defineMiddleware<{ user: User }>('auth', async (ctx, next) => {
 *   const user = await findUser(ctx.request);
 *   return user ? next({ user }) : new Response('Unauthorized', { status: 401 });
 * });
 *
 * // Requires `user` from an earlier middleware, adds nothing:
 * const requireAdmin = defineMiddleware<EmptyObject, { user: User }>('admin', (ctx, next) =>
 *   ctx.user.isAdmin ? next() : new Response('Forbidden', { status: 403 }),
 * );
 * ```
 */
export function defineMiddleware<TAdds extends object = EmptyObject, TRequires extends object = EmptyObject>(
  name: string,
  handle: Middleware<TRequires, TAdds>['handle'],
): Middleware<TRequires, TAdds> {
  return { name, handle };
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
  resolve: ClassResolver = (Class) => new Class(),
): Promise<Response> {
  const dispatch = (index: number, current: TCtx): Promise<Response> => {
    const layer = middleware[index];
    if (layer === undefined) return destination(current);

    let nextCalled = false;
    const next = (extension?: object): Promise<Response> => {
      if (nextCalled) {
        return Promise.reject(new Error(`Middleware "${layer.name}" called next() more than once.`));
      }
      nextCalled = true;
      return dispatch(index + 1, extension ? { ...current, ...extension } : current);
    };

    // Wrapping in a promise turns synchronous throws into rejections (including from the constructor).
    return Promise.resolve().then(() => {
      const handler: MiddlewareHandler<any, any> = isMiddlewareClass(layer) ? resolve(layer) : layer;
      return handler.handle(current, next);
    });
  };

  return dispatch(0, ctx);
}

/** Classes carry `handle` on their prototype; `defineMiddleware` objects carry it themselves. */
export function isMiddlewareClass(layer: AnyMiddleware): layer is MiddlewareClass {
  return typeof layer === 'function';
}
