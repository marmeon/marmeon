import { Router } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { column, defineTable, exportCsv, type DataTable } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { parseState, queryKeys } from './state.ts';
import { endpointOf, tablesOn } from './tables.ts';

const rows = (name: string, prefix?: string): DataTable =>
  defineTable({
    name,
    query: ((db: { selectFrom(table: string): unknown }) => db.selectFrom('members')) as never,
    key: 'members.id',
    export: { csv: exportCsv().authorize(() => true) },
    columns: { name: column('members.name').sortable(), team: column('members.team').sortable() },
    ...(prefix === undefined ? {} : { prefix }),
  } as never);

/** A router with one page, `GET /x`, the tables attached in order. */
const page = (...tables: DataTable[]) =>
  new Router().load(
    openRoutes((Route) => {
      const route = Route.get('/x', () => 'page');
      tables.reduce<any>((chain, table) => chain.attach(table.endpoints()), route);
    }),
  );

describe('tables on one page', () => {
  it('refuses the same table attached twice, naming the page', () => {
    const events = rows('events');
    expect(() => page(events, events)).toThrow('Table "events" is attached to GET /x twice');
  });

  it('refuses two tables of one name', () => {
    expect(() => page(rows('rows', 'a'), rows('rows', 'b'))).toThrow('GET /x has two tables named "rows"');
  });

  it('refuses two tables without a prefix, naming both and the fix', () => {
    expect(() => page(rows('events'), rows('teams'))).toThrow(/GET \/x shows tables "events" and "teams" with no prefix.*defineTable\(\{ prefix: 'teams' \}\).*#more-than-one-table-on-a-page/);
  });

  it('refuses two tables of one prefix', () => {
    expect(() => page(rows('events', 'x'), rows('teams', 'x'))).toThrow('shows tables "events" and "teams" with the prefix "x"');
  });

  it('refuses an unprefixed table next to one whose prefix makes a key of the other (per_page)', () => {
    expect(() => page(rows('events'), rows('teams', 'per'))).toThrow(/with the prefixes .* — they would share the URL's key per_page/);
    expect(() => page(rows('teams', 'per'), rows('events'))).toThrow(/with the prefixes .* — they would share the URL's key per_page/);
  });

  it('leaves nothing of the refused table in the router: no route, no record on the page', () => {
    const router = new Router();
    const events = rows('events');
    let route: ReturnType<Router['routes']['at']>;
    expect(() =>
      router.load(
        openRoutes((Route) => {
          route = Route.get('/x', () => 'page').attach(events.endpoints() as never);
          route.attach(rows('teams').endpoints() as never);
        }),
      ),
    ).toThrow();
    expect(router.routes.filter((r) => r.path.includes('/_tables/teams'))).toEqual([]);
    expect(tablesOn(route!)).toEqual([events.definition]);
  });

  it('loads a table without a prefix next to one with a prefix, and each keeps its own state', () => {
    const events = rows('events');
    const teams = rows('teams', 'teams');
    const router = page(events, teams);
    expect(tablesOn(router.routes.find((route) => route.path === '/x')!)).toEqual([events.definition, teams.definition]);
    const exports = router.routes.filter((route) => route.path.includes('/_tables/'));
    expect(exports.map((route) => [route.path, endpointOf(route).definition.name])).toEqual([
      ['/x/_tables/events/export/:tableExport', 'events'],
      ['/x/_tables/teams/export/:tableExport', 'teams'],
    ]);
    const query = new URLSearchParams('sort=-name&teams_page=2&teams_sort=team');
    expect(parseState(events.definition, query)).toMatchObject({ sort: { column: 'name', direction: 'desc' }, page: 1 });
    expect(parseState(teams.definition, query)).toMatchObject({ sort: { column: 'team', direction: 'asc' }, page: 2 });
    expect(queryKeys(teams.definition).sort).toBe('teams_sort');
  });

  it('loads two tables with distinct prefixes', () => {
    expect(() => page(rows('events', 'a'), rows('teams', 'b'))).not.toThrow();
  });

  it('loads one table on two pages', () => {
    const events = rows('events');
    expect(() =>
      new Router().load(
        openRoutes((Route) => {
          Route.get('/x', () => 'page').attach(events.endpoints() as never);
          Route.get('/y', () => 'page').attach(events.endpoints() as never);
        }),
      ),
    ).not.toThrow();
  });
});
