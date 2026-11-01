import { describeAccess, everyone } from './access.ts';
import { defineMiddleware } from './middleware.ts';
import { defineRoutes } from './router.ts';
import type { HttpContext, RouteBinder } from './types.ts';

interface Event {
  id: number;
  open: boolean;
}
const authenticate = defineMiddleware<{ user: { id: number } }>('authenticate', (_ctx, next) => next({ user: { id: 1 } }));

declare class Events implements RouteBinder<Event> {
  resolveRouteBinding(value: string): Event | undefined;
}

// A standalone check sees `HttpContext`, not `any`.
// @ts-expect-error — `evnt` is no bound parameter, and no parameter is bound here.
export const typo = describeAccess((ctx) => ctx.params.evnt.nonsense !== undefined, 'typo');
// @ts-expect-error — a user is added by middleware, which a standalone check does not know.
export const user = describeAccess((ctx) => ctx.user !== undefined, 'user');
export const plain = describeAccess((ctx, resolve) => {
  void resolve;
  return ctx.request.url.length > 0;
}, 'plain');

// An explicit type argument names the context.
export const explicit = describeAccess<HttpContext<object, { event: Event }>>((ctx) => ctx.params.event.open, 'explicit');

// A check that does not answer with a boolean is no check.
// @ts-expect-error — `1` is no boolean.
export const notBoolean = describeAccess(() => 1, 'x');

export default defineRoutes((Route) => {
  Route.bind('event', Events)
    .authorize(
      describeAccess((ctx) => {
        const open: boolean = ctx.params.event.open;
        return open;
      }, 'inline'),
    )
    .get('/a/:event', () => 'x');

  Route.bind('event', Events)
    // @ts-expect-error — `opn` is no property of the bound row.
    .authorize(describeAccess((ctx) => ctx.params.event.opn, 'typo'))
    .get('/b/:event', () => 'x');

  Route.bind('event', Events)
    .authorize(describeAccess(async (ctx) => ctx.params.event.open, 'async'))
    .get('/c/:event', () => 'x');

  // A check annotated apart from its route fits a route that binds what it reads, and no other.
  const annotated = describeAccess((ctx: HttpContext<object, { event: Event }>) => ctx.params.event.open, 'annotated');
  Route.bind('event', Events).authorize(annotated).get('/d/:event', () => 'x');
  // @ts-expect-error — no `event` is bound on this route.
  Route.authorize(annotated).get('/e', () => 'x');

  // An inline check sees the state the registrar's middleware adds.
  Route.middleware(authenticate)
    .bind('event', Events)
    .authorize(describeAccess((ctx) => ctx.user.id > 0 && ctx.params.event.open, 'signed in'))
    .get('/g/:event', () => 'x');

  Route.middleware(authenticate)
    // @ts-expect-error — `usr` is no state the middleware adds.
    .authorize(describeAccess((ctx) => ctx.usr.id > 0, 'typo'))
    .get('/h', () => 'x');

  Route.authorize(describeAccess(everyone, 'everyone')).get('/f', () => 'x');
});
