import { everyone } from './access.ts';
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
