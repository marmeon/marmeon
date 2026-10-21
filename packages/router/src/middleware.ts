import { withCode } from '@marmeon/core/internal';
import type { AnyMiddleware, ClassResolver, EmptyObject, Middleware, MiddlewareClass, MiddlewareHandler } from './types.ts';

const RESERVED = ['request', 'params', 'route', 'query', 'input', 'inputRead', 'cookies', 'ip', 'nonce', 'expectsJson', 'body', 'pageQuery'] as const;

/**
 * The keys of the request context that belong to the framework: no middleware may pass one to `next()`. A package that
 * builds its own context can check against it. See docs/middleware.md#adding-to-the-context.
 */
export const RESERVED_CONTEXT_KEYS: ReadonlySet<string> = new Set<string>(RESERVED);

// The check reads this copy, so nothing done to the exported set (a `delete` from a package) lifts the lock.
const RESERVED_SET: ReadonlySet<string> = new Set<string>(RESERVED);

/** A key of {@link RESERVED_CONTEXT_KEYS}; `next()` refuses it at compile time and at run time. */
export type ReservedContextKey = (typeof RESERVED)[number];

/** What a middleware may add to the context: anything but a reserved key. */
export type NoReservedKeys = { readonly [K in ReservedContextKey]?: never };

/**
 * Declares a middleware as a name and a function. Type parameters are ordered by how often you need them: what it adds to the
 * context (`next({ user })`), then what it requires from an earlier middleware. See docs/middleware.md#middleware-objects.
 */
export function defineMiddleware<TAdds extends object & NoReservedKeys = EmptyObject, TRequires extends object = EmptyObject>(
  name: string,
  handle: Middleware<TRequires, TAdds>['handle'],
  options: DefineMiddlewareOptions<TAdds> = {},
): Middleware<TRequires, TAdds> {
  return options.adds ? { name, handle, adds: options.adds } : { name, handle };
}

/** Options of `defineMiddleware()`. See docs/middleware.md#adding-to-the-context. */
export interface DefineMiddlewareOptions<TAdds extends object = object> {
  /**
   * The keys the middleware adds to the context with `next()`, such as `['user']`. The router refuses a route at start when
   * two of its middleware declare the same key. See docs/middleware.md#listed-twice.
   */
  readonly adds?: readonly (keyof TAdds & string)[];
}

/**
 * The keys `middleware` declares in `adds` (`static adds` of a class, `adds` of an object). Only an array counts, and only
 * its strings.
 *
 * @internal
 */
export function addsOf(middleware: AnyMiddleware): readonly string[] {
  let declared: unknown;
  try {
    declared = (middleware as { adds?: unknown } | null | undefined)?.adds;
  } catch {
    return [];
  }
  return Array.isArray(declared) ? declared.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** A key two layers of one pipeline declare in `adds`. */
export interface AddsConflict {
  readonly key: string;
  readonly first: AnyMiddleware;
  readonly second: AnyMiddleware;
}

/** The keys that more than one layer of `pipeline` declares in `adds` (a layer listed twice counts once: the router runs it once). @internal */
export function addsConflicts(pipeline: readonly AnyMiddleware[]): AddsConflict[] {
  const owners = new Map<string, AnyMiddleware>();
  const conflicts: AddsConflict[] = [];
  for (const layer of new Set(pipeline)) {
    for (const key of new Set(addsOf(layer))) {
      const first = owners.get(key);
      if (first) conflicts.push({ key, first, second: layer });
      else owners.set(key, layer);
    }
  }
  return conflicts;
}

/** Why `next()` refuses `key`, or `undefined` when it may be added. */
function refusal(key: string | symbol, current: object): string | undefined {
  if (typeof key === 'string' && RESERVED_SET.has(key)) return 'it belongs to the framework';
  // `then` makes a context a thenable that `await` unwraps, `toJSON` changes how it serializes, `constructor` and the like are
  // what every object inherits.
  if (typeof key === 'string' && (key in Object.prototype || key === 'then' || key === 'toJSON')) return 'it is a name with a meaning of its own on every object';
  if (Object.hasOwn(current, key)) return 'an earlier middleware or the framework set it already';
  return undefined;
}

export interface PipelineOptions<TCtx> {
  /** Builds middleware classes, e.g. from the request's container scope. Defaults to `new Class()`. */
  resolve?: ClassResolver;
  /** Called with every layer that ran and has a `terminate` hook, and the context it saw. */
  onTerminable?: (handler: MiddlewareHandler<any, any>, ctx: TCtx) => void;
  /**
   * Turns an error into a response *at the layer where it was thrown*. Outer
   * middleware then sees a normal response — security headers, the session and cookies apply to error pages too.
   * Without it, errors propagate to the caller.
   */
  onError?: (error: unknown, ctx: TCtx) => Response | Promise<Response>;
}

/**
 * Runs `ctx` through the middleware onion. Each layer may
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
      // One snapshot is checked and merged, so an extension (a Proxy, a getter) cannot show other keys the second time.
      const added = extension ? { ...extension } : undefined;
      if (added) {
        for (const key of Reflect.ownKeys(added)) {
          const why = refusal(key, current);
          if (why === undefined) continue;
          const name = typeof key === 'symbol' ? key.toString() : `"${key}"`;
          return Promise.reject(
            new TypeError(
              withCode(
                'H8',
                `Middleware "${layer.name}" cannot set ${name} on the context: ${why}. ` +
                  'next() extends the context with new keys (next({ team })) but never replaces one; give the value a key of its own, or bind a container token for a service.',
              ),
            ),
          );
        }
      }
      nextCalled = true;
      return dispatch(index + 1, added ? Object.freeze({ ...current, ...added }) : current);
    };

    return guard(() => {
      const handler: MiddlewareHandler<any, any> = isMiddlewareClass(layer) ? resolve(layer) : layer;
      if (handler.terminate) onTerminable?.(handler, current);
      return handler.handle(current, next);
    }, current);
  };

  return dispatch(0, Object.isFrozen(ctx) ? ctx : Object.freeze({ ...ctx }));
}

/** Classes carry `handle` on their prototype; `defineMiddleware` objects carry it themselves. */
export function isMiddlewareClass(layer: AnyMiddleware): layer is MiddlewareClass {
  return typeof layer === 'function';
}
