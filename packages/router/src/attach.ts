import type { Route } from './route.ts';
import type { RouteDefinition } from './route-definition.ts';

/**
 * What a package hangs on a page with {@link RouteDefinition.attach}: routes under the page's path that carry all of its access.
 * See docs/routing.md#routes-under-a-page.
 */
export interface RouteAttachment<TNeeds extends object = {}> {
  /** Registers the attachment's routes through `routes`, synchronously, once. */
  readonly attachTo: (routes: Route<any, any, any>, page: RouteDefinition) => void;
  /** Type only, never set: the context the attachment's routes need of the page. */
  readonly '~needs'?: TNeeds;
}

/** What `attach()` says to an attachment whose needs the page's route does not meet — the message the compiler shows. */
type LacksNeeds = {
  "this page's route lacks what the routes attached to it need — add the middleware they read (authenticate(), …) to the page's registrar, before the page": never;
};

/**
 * The attachment itself when the page's context has what it needs, otherwise an object that carries the message. A page typed as a
 * plain `RouteDefinition` (or made by `post()`) knows no context, so it refuses an attachment with needs: fail closed.
 */
export type CheckAttachment<A, TContext> = A extends { readonly '~needs'?: infer TNeeds }
  ? [TContext] extends [Exclude<TNeeds, undefined>]
    ? A
    : LacksNeeds
  : A;
