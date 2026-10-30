import { everyone } from './access.ts';
import type { RouteAttachment } from './attach.ts';
import { defineMiddleware } from './middleware.ts';
import { RouteDefinition } from './route-definition.ts';
import { defineRoutes } from './router.ts';

interface User {
  id: number;
}

const authenticate = defineMiddleware<{ user: User }>('authenticate', (_ctx, next) => next({ user: { id: 1 } }));

/** An attachment whose routes read `ctx.user`. */
declare const needsUser: RouteAttachment<{ user: User }>;
declare const needsNothing: RouteAttachment;

export default defineRoutes((Route) => {
  const open = Route.authorize(everyone);

  // @ts-expect-error — the page's registrar has no authenticate(), and the attached routes read the user.
  open.get('/a', () => 'a').attach(needsUser);
  open.middleware(authenticate).get('/b', () => 'b').attach(needsUser);
  open.get('/c', () => 'c').attach(needsNothing);

  // Existing annotations keep compiling: a typed route is a RouteDefinition, and a list may mix methods.
  const page: RouteDefinition = open.get('/d/:id', () => 'd');
  const list: readonly RouteDefinition[] = [open.get('/e', () => 'e'), open.post('/e', () => 'e')];
  void [page, list];

  // @ts-expect-error — a page typed as a plain RouteDefinition knows no context, so it takes no attachment with needs.
  page.attach(needsUser);
  page.attach(needsNothing);
});
