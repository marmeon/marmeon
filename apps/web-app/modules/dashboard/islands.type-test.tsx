/**
 * Type guarantees of islands against this app's dashboard — checked by `tsc` (`pnpm typecheck`,
 * `marmeon build`), never run. Each `@ts-expect-error` is a mistake an app developer makes; the comment above it is the
 * message they get (read with the directive removed).
 */
import { authenticate } from '@marmeon/auth';
import { defineRoutes, type IslandProps } from '@marmeon/http';
import { Island, Link, useIsland } from '@marmeon/react';
import { expectTypeOf } from 'vitest';
import { ShowMyActivityController } from './controllers/ShowMyActivityController.ts';
import type { ShowRecentSignInsController } from './controllers/ShowRecentSignInsController.ts';

export function TheDashboard() {
  return (
    <>
      <Island route="dashboard.sign-ins" query={{ limit: 5, range: '7d' }} fallback={<p>…</p>} />
      <Island route="dashboard.members" unauthorized={<p>Administrators only.</p>} />
      <Island route="dashboard.activity" load="visible" poll={15_000} />
      {/* A link to a page is fine — to an island it is not:
          Type '"dashboard.sign-ins"' is not assignable to type '"'dashboard.sign-ins' is an island, not a page — embed it with
          <Island route=\"dashboard.sign-ins\">; links and visits go to pages"'. */}
      {/* @ts-expect-error */}
      <Link route="dashboard.sign-ins">Sign-ins</Link>
      {/* Type '"user-profile.show"' is not assignable to type '"'user-profile.show' renders a page, not an island — its controller
          returns this.view(…); an island's returns this.island(…)"'. */}
      {/* @ts-expect-error */}
      <Island route="user-profile.show" params={{ user: 1 }} />
      {/* Type '"1y"' is not assignable to type '"30d" | "7d" | "all" | undefined'. */}
      {/* @ts-expect-error */}
      <Island route="dashboard.sign-ins" query={{ range: '1y' }} />
      {/* Type '"dashbaord.sign-ins"' is not assignable to type '"'dashbaord.sign-ins' is not a route name"'. */}
      {/* @ts-expect-error */}
      <Island route="dashbaord.sign-ins" />
    </>
  );
}

export function TheIsland(props: IslandProps<ShowRecentSignInsController>) {
  // The controller's own props, as they arrive (a Date is a string) — without the shared ones (the page has them).
  expectTypeOf(props).toEqualTypeOf<{ readonly entries: { publicId: string; name: string; at: string; can: { update: boolean } }[]; readonly now: string }>();
  const island = useIsland<ShowRecentSignInsController>();
  // Its query, defaults filled in — what the controller's ctx.query is.
  expectTypeOf(island.query).toEqualTypeOf<{ range: '7d' | '30d' | 'all'; limit: number }>();
  void island.reload({ query: { range: '7d' } });
  void island.reload({ query: { limit: undefined } });
  // Type '"1y"' is not assignable to type '"30d" | "7d" | "all" | undefined'.
  // @ts-expect-error
  void island.reload({ query: { range: '1y' } });
  // Object literal may only specify known properties, but 'rnage' does not exist in type 'QueryFields<{ range: "30d" | "7d" | "all";
  // limit: number; }>'. Did you mean to write 'range'?
  // @ts-expect-error
  void island.reload({ query: { rnage: '7d' } });
  // Type '"entires"' is not assignable to type '"entries" | "now"'. Did you mean '"entries"'?
  // @ts-expect-error
  void island.reload({ only: ['entires'] });
  return null;
}

export const routes = defineRoutes((Route) => {
  const signedIn = Route.middleware(authenticate());
  signedIn.get('/islands/activity', ShowMyActivityController);
  // An island reads:
  // Argument of type 'typeof ShowMyActivityController' is not assignable to parameter of type '"this.island(…) answers GET requests
  // only — an island reads, it never changes anything: register it with Route.get"'.
  // @ts-expect-error
  signedIn.post('/islands/activity', ShowMyActivityController);
});
