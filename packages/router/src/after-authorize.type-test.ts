import { Clock, token } from '@marmeon/core';
import { describeAccess, everyone } from './access.ts';
import { defineRoutes } from './router.ts';
import type { RouteBinder } from './types.ts';

interface Team {
  id: number;
  name: string;
}
declare class Teams implements RouteBinder<Team> {
  resolveRouteBinding(value: string): Team | undefined;
}

export default defineRoutes((Route) => {
  Route.bind('team', Teams)
    .authorize(everyone)
    .afterAuthorize((ctx) => {
      const name: string = ctx.params.team.name;
      // @ts-expect-error — `nam` is no property of the bound row.
      const typo = ctx.params.team.nam;
      // @ts-expect-error — `teem` is no bound parameter.
      const wrong = ctx.params.teem;
      void [name, typo, wrong];
    })
    .get('/teams/:team', () => 'x');

  // @ts-expect-error — a hook takes a function.
  Route.authorize(everyone).afterAuthorize('hook');
});

// A token is resolved in every place that takes `resolve`, and comes out as what it is bound to.
const Label = token<{ text: string }>('Label');
export const resolvesTokens = defineRoutes((Route) => {
  Route.authorize((_ctx, resolve) => resolve(Clock).now() > 0 && resolve(Label).text.length > 0)
    .afterAuthorize((_ctx, resolve) => {
      const now: number = resolve(Clock).now();
      const text: string = resolve(Label).text;
      // @ts-expect-error — the token gives a `{ text }`, not a number.
      const wrong: number = resolve(Label);
      // @ts-expect-error — a token is an object, not a name: `'Clock'` is no key.
      const byName = resolve('Clock');
      void [now, text, wrong, byName];
    })
    .get('/tokens', () => 'x');
});
export const checkOfAStandaloneDescription = describeAccess((_ctx, resolve) => resolve(Clock).now() > 0, 'clock');
