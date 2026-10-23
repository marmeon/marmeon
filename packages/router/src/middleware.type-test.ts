import { defineMiddleware, type AnyMiddleware, type EmptyObject, type MiddlewareClass, type Next, type RequestContext, type ReservedContextKey } from './index.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertEqual = <_ extends true>() => {};

// The list stays equal to the context's keys plus the two the router and validation add.
assertEqual<Equal<ReservedContextKey, keyof RequestContext | 'body' | 'pageQuery'>>();

// @ts-expect-error — `params` belongs to the framework.
defineMiddleware<{ params: { id: string } }>('params', (_ctx, next) => next({ params: { id: '1' } }));

class TakesCookies {
  handle(_ctx: unknown, next: Next<{ cookies: string }>) {
    return next({ cookies: 'x' });
  }
}

// @ts-expect-error — a class that adds `cookies` is no middleware class.
export const taken: MiddlewareClass<EmptyObject, { cookies: string }> = TakesCookies;

defineMiddleware<{ team: string }>('team', (_ctx, next) => next({ team: 'core' }));

defineMiddleware<{ team: string }>('team', (_ctx, next) => next({ team: 'core' }), { adds: ['team'] });
// @ts-expect-error — `tema` is no key the middleware adds.
defineMiddleware<{ team: string }>('team', (_ctx, next) => next({ team: 'core' }), { adds: ['tema'] });

// A middleware that declares nothing may be handed to a pipeline that takes any middleware.
export const untyped: AnyMiddleware = defineMiddleware('untyped', (_ctx, next) => next());

// @ts-expect-error — a middleware that declares `user` still has to extend the context.
defineMiddleware<{ user: { id: string } }>('user', (_ctx, next) => next());

// A union is extended whenever one of its members adds keys, shared or not.
defineMiddleware<{ a: string } | { b: string }>('either', (_ctx, next) => next({ a: 'x' }));
defineMiddleware<{ a: string } | {}>('maybe', (_ctx, next) => next({ a: 'x' }));
// @ts-expect-error — the extension is mandatory when a member of the union adds keys.
defineMiddleware<{ a: string } | { b: string }>('either', (_ctx, next) => next());
// @ts-expect-error — the extension is mandatory when a member of the union adds keys.
defineMiddleware<{ a: string } | {}>('maybe', (_ctx, next) => next());

// Nothing declared still lets `next()` through.
defineMiddleware<{}>('empty', (_ctx, next) => next());
defineMiddleware<object>('object', (_ctx, next) => next());
defineMiddleware<EmptyObject>('empty-object', (_ctx, next) => next());
defineMiddleware<any>('any', (_ctx, next) => next());
