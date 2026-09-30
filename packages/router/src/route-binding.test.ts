import * as v from 'valibot';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineRequest } from './request-definition.ts';
import { defineRoutes, Router } from './router.ts';
import type { HttpContext, RouteBinder, RouteBindingContext } from './types.ts';

interface Team {
  id: number;
  name: string;
}
interface Member {
  id: number;
  team_id: number;
  name: string;
}
const teams: Team[] = [
  { id: 1, name: 'Red' },
  { id: 2, name: 'Blue' },
];
const members: Member[] = [
  { id: 10, team_id: 1, name: 'Ada' },
  { id: 20, team_id: 2, name: 'Alan' },
];

const lookups: string[] = [];
class Teams implements RouteBinder<Team> {
  resolveRouteBinding(value: string) {
    lookups.push(`team ${value}`);
    return teams.find((team) => String(team.id) === value);
  }
}
class Members implements RouteBinder<Member> {
  resolveRouteBinding(value: string, { scope }: RouteBindingContext) {
    lookups.push(`member ${value}${scope ? ` in ${scope.param} (${scope.column})` : ''}`);
    return members.find(
      (member) => String(member.id) === value && (!scope || member[scope.column as keyof Member] === (scope.parent as Team).id),
    );
  }
}

class ShowMemberController {
  handle(ctx: HttpContext<{}, { team: Team; member: Member }>) {
    return { team: ctx.params.team.name, member: ctx.params.member.name };
  }
}

const UpdateTeamRequest = defineRequest({
  schema: v.object({ name: v.string() }),
  // Sees the bound record: authorization about *this* team.
  authorize: (ctx: HttpContext<{}, { team: Team }>) => ctx.params.team.id === 1,
});
class UpdateTeamController {
  static request = UpdateTeamRequest;
  handle(ctx: HttpContext<{}, { team: Team }> & { body: { name: string } }) {
    return { renamed: ctx.params.team.id, to: ctx.body.name };
  }
}

function router() {
  return new Router().load(
    defineRoutes((Route) => {
      Route.bind('team', Teams).bind('member', Members, { scopedBy: 'team' }).get('/teams/:team/members/:member', ShowMemberController);
      Route.bind('team', Teams).get('/teams/:team', (ctx) => ({ name: ctx.params.team.name }));
      Route.bind('team', Teams).put('/teams/:team', UpdateTeamController);
      Route.bind('member', Members).get('/members/:member?', (ctx) => ({ member: ctx.params.member?.name ?? null }));
    }),
  );
}

async function call(path: string, method = 'GET', body?: unknown) {
  const r = router();
  const url = new URL(path, 'http://localhost');
  for (const route of r.routes) {
    if (!route.methods.includes(method as never)) continue;
    const pattern = new RegExp(`^${route.path.replace(/\/:(\w+)\?/g, '(?:/(?<$1>[^/]+))?').replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
    const match = pattern.exec(url.pathname);
    if (!match) continue;
    const params = Object.fromEntries(Object.entries(match.groups ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>;
    const request = new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json' } } : {}) });
    return r.dispatch(route, { request, params }, { onError: (error) => Response.json({ error: String(error) }, { status: (error as { status?: number }).status ?? 500 }) });
  }
  throw new Error(`no route for ${method} ${path}`);
}

describe('Route.bind', () => {
  it('hands the action the resolved record instead of the string', async () => {
    const response = await call('/teams/2');
    expect(await response.json()).toEqual({ name: 'Blue' });
  });

  it('answers 404 when there is no record', async () => {
    expect((await call('/teams/99')).status).toBe(404);
  });

  it('resolves a scoped binding within its parent — another team’s member is a 404 (no IDOR)', async () => {
    lookups.length = 0;
    expect(await (await call('/teams/1/members/10')).json()).toEqual({ team: 'Red', member: 'Ada' });
    expect(lookups).toEqual(['team 1', 'member 10 in team (team_id)']);
    expect((await call('/teams/1/members/20')).status).toBe(404); // Alan exists — but not in team 1
  });

  it('binds before authorize, so authorization sees the record; validation comes after', async () => {
    expect(await (await call('/teams/1', 'PUT', { name: 'Crimson' })).json()).toEqual({ renamed: 1, to: 'Crimson' });
    expect((await call('/teams/2', 'PUT', { name: 'Navy' })).status).toBe(403);
    expect((await call('/teams/99', 'PUT', { name: 'Ghost' })).status).toBe(404);
  });

  it('leaves an absent optional parameter absent', async () => {
    expect(await (await call('/members')).json()).toEqual({ member: null });
    expect(await (await call('/members/20')).json()).toEqual({ member: 'Alan' });
  });

  it('refuses a binding for a parameter the path does not have — at boot, for untyped code', () => {
    const untyped = defineRoutes((Route) => (Route.bind('team', Teams) as any).get('/teams/:id', () => 'x'));
    expect(() => new Router().load(untyped)).toThrow("Route.bind('team') needs a :team parameter in /teams/:id.");
  });
});

// Type guarantees — compiled, not run.
export function typeLevelTests() {
  defineRoutes((Route) => {
    Route.bind('team', Teams).get('/teams/:team', (ctx) => {
      expectTypeOf(ctx.params.team).toEqualTypeOf<Team>();
      return null;
    });
    // @ts-expect-error — (1) the path has no :team parameter
    Route.bind('team', Teams).get('/teams/:id', (ctx) => ctx.params);
    // @ts-expect-error — (2) the controller expects the id string, the route hands it a Team
    Route.bind('team', Teams).get('/teams/:team', (ctx: HttpContext<{}, { team: string }>) => ctx.params.team);
    // @ts-expect-error — (3) scopedBy must name a parameter bound before
    Route.bind('member', Members, { scopedBy: 'team' }).get('/teams/:team/members/:member', ShowMemberController);
    // @ts-expect-error — (4) a controller that needs a bound member — the route binds none
    Route.bind('team', Teams).get('/teams/:team/members/:member', ShowMemberController);
    // @ts-expect-error — (5) not a binder (no resolveRouteBinding)
    Route.bind('team', class {}).get('/teams/:team', () => null);
  });
}
