import * as v from 'valibot';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineRequest } from './request-definition.ts';
import { Router } from './router.ts';
import type { HttpContext, RouteBinder, RouteBindingContext, RouteBindingWith } from './types.ts';
import { checkedRoutes } from './test-helpers/open-routes.ts';

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

/** A binder that loads more with the record when the route asks: its `routeBindingWith` names what, and types the result. */
interface TeamWith extends RouteBindingWith {
  readonly with: readonly ('members' | 'captain')[];
  readonly value: Team & { [K in this['with'][number]]: K extends 'members' ? Member[] : Member };
}
class TeamsWith implements RouteBinder<Team> {
  declare readonly routeBindingWith?: TeamWith;
  resolveRouteBinding(value: string, binding: RouteBindingContext) {
    lookups.push(`team ${value} with ${(binding.with ?? []).join(', ') || 'nothing'}`);
    const team = teams.find((candidate) => String(candidate.id) === value);
    if (!team) return undefined;
    const loaded: Record<string, unknown> = { ...team };
    if (binding.with?.includes('members')) loaded.members = members.filter((member) => member.team_id === team.id);
    if (binding.with?.includes('captain')) loaded.captain = members.find((member) => member.team_id === team.id);
    return loaded as unknown as Team;
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
    checkedRoutes((Route) => {
      Route.bind('team', Teams).bind('member', Members, { scopedBy: 'team' }).get('/teams/:team/members/:member', ShowMemberController);
      Route.bind('team', Teams).get('/teams/:team', (ctx) => ({ name: ctx.params.team.name }));
      Route.bind('team', Teams).put('/teams/:team', UpdateTeamController);
      Route.bind('member', Members).get('/members/:member?', (ctx) => ({ member: ctx.params.member?.name ?? null }));
      Route.bind('team', TeamsWith, { with: ['members'] }).get('/rosters/:team', (ctx) => ({ team: ctx.params.team.name, members: ctx.params.team.members.map((m) => m.name) }));
      Route.bind('team', TeamsWith)
        .bind('member', MembersOfTeam, { scopedBy: 'team', with: [] })
        .get('/rosters/:team/members/:member', (ctx) => ({ member: ctx.params.member.name }));
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

  it('passes the relations a binding names on to its binder — and nothing when it names none', async () => {
    lookups.length = 0;
    expect(await (await call('/rosters/1')).json()).toEqual({ team: 'Red', members: ['Ada'] });
    expect(await (await call('/rosters/1/members/10')).json()).toEqual({ member: 'Ada' });
    expect((await call('/rosters/1/members/20')).status).toBe(404); // scoped as before: another team's member
    expect(lookups).toEqual(['team 1 with members', 'team 1 with nothing', 'member 10 in team (team_id)', 'team 1 with nothing', 'member 20 in team (team_id)']);
  });

  it('refuses a column without scopedBy — at boot, for untyped code: it would bind the record without its parent', () => {
    const untyped = checkedRoutes((Route) => (Route.bind('team', Teams) as any).bind('member', Members, { column: 'team_id' }));
    expect(() => new Router().load(untyped)).toThrow(
      "Route.bind('member') has a column (team_id) but no scopedBy — name the parent parameter, or the record is looked up without it.",
    );
  });

  it('refuses a binding for a parameter the path does not have — at boot, for untyped code', () => {
    const untyped = checkedRoutes((Route) => (Route.bind('team', Teams) as any).get('/teams/:id', () => 'x'));
    expect(() => new Router().load(untyped)).toThrow("Route.bind('team') needs a :team parameter in /teams/:id.");
  });
});

interface MemberWith extends RouteBindingWith {
  readonly with: readonly 'team'[];
  readonly value: Member & { [K in this['with'][number]]: Team };
}
class MembersOfTeam extends Members {
  declare readonly routeBindingWith?: MemberWith;
}

// Type guarantees — compiled, not run.
export function typeLevelTests() {
  checkedRoutes((Route) => {
    Route.bind('team', Teams).get('/teams/:team', (ctx) => {
      expectTypeOf(ctx.params.team).toEqualTypeOf<Team>();
      return null;
    });
    // @ts-expect-error — (1) the path has no :team parameter
    Route.bind('team', Teams).get('/teams/:id', (ctx) => ctx.params);
    // @ts-expect-error — (2) the controller expects the id string, the route hands it a Team
    Route.bind('team', Teams).get('/teams/:team', (ctx: HttpContext<{}, { team: string }>) => ctx.params.team);
    // Type '"team"' is not assignable to type '"scopedBy names a parameter bound before this one — bind the parent first:
    // Route.bind(parent, …).bind(child, …, { scopedBy: parent })"'.
    // @ts-expect-error — (3) scopedBy must name a parameter bound before
    Route.bind('member', Members, { scopedBy: 'team' }).get('/teams/:team/members/:member', ShowMemberController);
    // Type '"teem"' is not assignable to type '"team"'.
    // @ts-expect-error — (3b) nor one that is not bound at all
    Route.bind('team', Teams).bind('member', Members, { scopedBy: 'teem' });
    // Argument of type '{ column: string; }' is not assignable to parameter of type 'BindOptions<"team", …> | undefined'.
    //   Property 'scopedBy' is missing in type '{ column: string; }' but required in type '{ readonly scopedBy: "team"; readonly column?: string |
    //   undefined; … }'.
    // @ts-expect-error — (3c) a column scopes only together with its parent: alone it would bind the member unscoped
    Route.bind('team', Teams).bind('member', Members, { column: 'team_id' });
    // @ts-expect-error — (4) a controller that needs a bound member — the route binds none
    Route.bind('team', Teams).get('/teams/:team/members/:member', ShowMemberController);
    // @ts-expect-error — (5) not a binder (no resolveRouteBinding)
    Route.bind('team', class {}).get('/teams/:team', () => null);

    // With relations: the bound value has the ones named, and only those.
    Route.bind('team', TeamsWith, { with: ['members'] }).get('/teams/:team', (ctx) => {
      expectTypeOf(ctx.params.team.members).toEqualTypeOf<Member[]>();
      expectTypeOf(ctx.params.team.name).toEqualTypeOf<string>();
      // Property 'captain' does not exist on type 'Team & { members: Member[]; }'.
      // @ts-expect-error — (6) not named, not loaded
      void ctx.params.team.captain;
      return null;
    });
    Route.bind('team', TeamsWith, { with: ['members', 'captain'] }).get('/teams/:team', (ctx) => {
      expectTypeOf(ctx.params.team.captain).toEqualTypeOf<Member>();
      return null;
    });
    // Type '"coach"' is not assignable to type '"captain" | "members"'.
    // @ts-expect-error — (7) a name the binder does not load
    Route.bind('team', TeamsWith, { with: ['coach'] });
    // Type 'string[]' is not assignable to type '"this binder loads nothing with the record — only one with a routeBindingWith does, such as a
    // repository"'.
    // @ts-expect-error — (8) a binder without routeBindingWith takes no with
    Route.bind('team', Teams, { with: ['members'] });
    // Scoped and with relations at once.
    Route.bind('team', Teams)
      .bind('member', MembersOfTeam, { scopedBy: 'team', with: ['team'] })
      .get('/teams/:team/members/:member', (ctx) => {
        expectTypeOf(ctx.params.member.team).toEqualTypeOf<Team>();
        return null;
      });
  });
}
