import { Gate } from '@marmeon/auth';
import { Database } from '@marmeon/database';
import { defineRoutes, everyone, Router, type Route } from '@marmeon/router';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditedTable, ByEmailTable, drivers, endpoint, MembersTable, tableApp, USERS, WithTeamTable, type TableTestApp } from './__fixtures__/app.ts';
import { createApplication, defineModule, Logger } from '@marmeon/core';
import { DatabaseServiceProvider } from '@marmeon/database';
import { Encrypter, EncryptionServiceProvider } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { ServerServiceProvider } from '@marmeon/server';
import { DataTables, TableServiceProvider, type DataTable } from './index.ts';
import { distinctRegistrations } from './tables.ts';
import { pageOf } from './test-helpers/attached-page.ts';
import type { TableData } from './client/index.ts';

const ADA = 1; // admin of team 1
const EDSGER = 4; // exports, but is no admin

let open: TableTestApp | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const urlsOf = async (application: TableTestApp, user: number, path: string) => {
  const response = await application.request(path, { user });
  expect(response.status).toBe(200);
  const { members } = (await response.json()) as { members: TableData };
  return { action: members.actions[0]!.url, bulk: members.bulk[0]!.url, export: members.exports[0]!.url };
};

/** The endpoints of the members table under the second page of the fixture app (`/teams/:team/in/:role/members`). */
const staff = (kind: 'actions' | 'bulk' | 'export', name: string, team = 1) => `/teams/${team}/in/staff/members/_tables/members/${kind}/${name}`;

describe.each(drivers)('one table on several pages (%s)', (driver) => {
  it('links the endpoints attached to each page, with that page\'s own parameters', async () => {
    open = await tableApp(driver);
    expect(await urlsOf(open, ADA, '/teams/1/members')).toEqual({
      action: endpoint(MembersTable, 'action', 'deactivate'),
      bulk: endpoint(MembersTable, 'bulk', 'deactivate'),
      export: endpoint(MembersTable, 'export', 'csv'),
    });
    expect(await urlsOf(open, ADA, '/teams/1/in/staff/members')).toEqual({
      action: staff('actions', 'deactivate'),
      bulk: staff('bulk', 'deactivate'),
      export: staff('export', 'csv'),
    });
  });

  it('serves the endpoints of both pages, each behind its own checks', async () => {
    open = await tableApp(driver);
    const deactivate = (user: number, url: string) => open!.request(url, { method: 'POST', user, json: { key: '4' } });
    const download = (user: number, url: string) => open!.request(url, { user });
    expect((await deactivate(ADA, endpoint(MembersTable, 'action', 'deactivate'))).status).toBe(200);
    expect((await deactivate(ADA, staff('actions', 'deactivate'))).status).toBe(200);
    // Edsger may export (the table's own rule), and the first page has no check beyond that ...
    expect((await download(EDSGER, endpoint(MembersTable, 'export', 'csv'))).status).toBe(200);
    // ... the second page's request adds an admin-only check, which its endpoints carry.
    expect((await download(EDSGER, staff('export', 'csv'))).status).toBe(403);
    expect((await download(ADA, staff('export', 'csv'))).status).toBe(200);
  });

  it('keeps the tenant: a team that is not the user\'s gets nothing from either page', async () => {
    open = await tableApp(driver);
    for (const url of [endpoint(MembersTable, 'export', 'csv', 2), staff('export', 'csv', 2)]) {
      expect((await open.request(url, { user: ADA })).status).toBe(404);
    }
  });
});

/** A `DataTables` of the test app. */
function tablesOn(application: TableTestApp): DataTables {
  const scope = application.application.container.createScope();
  return new DataTables(scope.make(Database), () => new Gate({ user: async () => USERS[ADA] } as never, (Class) => scope.make(Class)), (Class) => scope.make(Class), () => scope.make(Encrypter));
}

const routerOf = (register: (Root: Route) => void) => new Router().load(defineRoutes((Root) => register(Root.authorize(everyone))));

describe.each(drivers)('a table that is not attached to the page (%s)', (driver) => {
  const ctx = (route: unknown, url = 'http://localhost/teams/1/members') => ({ route, request: new Request(url), query: { per_page: 25, page: 1 }, user: USERS[ADA], team: 1 }) as never;

  it('is refused before any query, naming the table and the page', async () => {
    open = await tableApp(driver);
    open.queries.length = 0;
    await expect(tablesOn(open).resolve(MembersTable, ctx(pageOf(AuditedTable, '/teams/:team/members')))).rejects.toThrow(
      'Table "members" is not attached to GET /teams/:team/members — hang it on the page that shows it: Route.get(\'…\', Page).attach(membersTable.endpoints()). See docs/tables.md#the-controller-and-the-routes.',
    );
    expect(open.queries).toEqual([]);
  });

  it('is refused on the page it was not attached to, though it is attached to another', async () => {
    open = await tableApp(driver);
    const attached = pageOf(MembersTable, '/a');
    const other = pageOf(AuditedTable, '/b');
    await expect(tablesOn(open).resolve(MembersTable, ctx(other))).rejects.toThrow(/Table "members" is not attached to GET \/b /);
    expect((await tablesOn(open).resolve(MembersTable, ctx(attached))) as unknown as TableData).toMatchObject({ actions: [{ name: 'deactivate' }] });
  });

  it('is refused without a route in the context', async () => {
    open = await tableApp(driver);
    await expect(tablesOn(open).resolve(MembersTable, ctx(undefined))).rejects.toThrow(/Table "members" is not attached to this request's route/);
  });

  it('is refused when it has no actions and exports, too — and renders once attached, with no route of its own', async () => {
    open = await tableApp(driver);
    await expect(tablesOn(open).resolve(WithTeamTable, ctx(pageOf(MembersTable, '/x')))).rejects.toThrow(/Table "with-team" is not attached to GET \/x /);
    const data = (await tablesOn(open).resolve(WithTeamTable, ctx(pageOf(WithTeamTable, '/x')))) as unknown as TableData;
    expect(data.rows.length).toBeGreaterThan(0);
    const router = routerOf((Root) => void Root.get('/x', () => 'page').attach(WithTeamTable.endpoints() as never));
    expect(router.routes.map((route) => route.path)).toEqual(['/x']);
  });
});

describe('the endpoints a table has', () => {
  it('registers a route only for the kinds it has: none for a table without actions, bulk actions and exports', () => {
    const router = routerOf((Root) => void Root.get('/x', () => 'page').attach(WithTeamTable.endpoints() as never));
    expect(router.routes.some((route) => route.path.includes('/_tables/'))).toBe(false);
    const partial = routerOf((Root) => void Root.get('/x', () => 'page').attach(AuditedTable.endpoints() as never));
    expect(partial.routes.map((route) => `${route.methods.join('|')} ${route.path}`).sort()).toEqual(['GET /x', 'GET /x/_tables/audited/export/:tableExport']);
  });
});

describe.each(drivers)('the URLs under the page (%s)', (driver) => {
  it('carries the parameters of the page\'s path, and an action under it lands', async () => {
    open = await tableApp(driver);
    expect(await urlsOf(open, ADA, '/teams/1/views/wide')).toEqual({
      action: '/teams/1/views/wide/_tables/members/actions/deactivate',
      bulk: '/teams/1/views/wide/_tables/members/bulk/deactivate',
      export: '/teams/1/views/wide/_tables/members/export/csv',
    });
    const done = await open.request('/teams/1/views/wide/_tables/members/actions/deactivate', { method: 'POST', user: ADA, json: { key: '4' } });
    expect(done.status).toBe(200);
    expect(open.recorder.deactivated).toHaveLength(1);
  });

  it('hangs the endpoints on a page with a route binding, and they answer', async () => {
    open = await tableApp(driver);
    expect(await urlsOf(open, ADA, '/bound/1/members')).toMatchObject({ export: '/bound/1/members/_tables/members/export/csv' });
    expect((await open.request('/bound/1/members/_tables/members/export/csv', { user: ADA })).status).toBe(200);
    expect((await open.request('/bound/1/members/_tables/members/actions/deactivate', { method: 'POST', user: ADA, json: { key: '4' } })).status).toBe(200);
  });

  it('links /de/… endpoints from a localized page', async () => {
    open = await tableApp(driver);
    const router = routerOf((Root) => void Root.localized().get('/members', () => 'page').attach(MembersTable.endpoints() as never));
    const page = router.routes.find((route) => route.path === '/:locale/members')!;
    const request = { route: page, request: new Request('http://localhost/de/members'), query: { per_page: 25, page: 1 }, user: USERS[ADA], team: 1 } as never;
    const data = (await tablesOn(open).resolve(MembersTable, request)) as unknown as TableData;
    expect(data.actions[0]!.url).toBe('/de/members/_tables/members/actions/deactivate');
    expect(data.exports[0]!.url).toBe('/de/members/_tables/members/export/csv');
  });

  it('answers 404 for an endpoint kind the table does not have', async () => {
    open = await tableApp(driver);
    expect((await open.request(endpoint(ByEmailTable, 'export', 'csv'), { user: ADA })).status).toBe(404);
    expect((await open.request(endpoint(ByEmailTable, 'bulk', 'deactivate'), { method: 'POST', user: ADA, json: { keys: [1] } })).status).toBe(404);
  });
});

describe('two pages of one table under the same URLs', () => {
  const load = (register: (Root: Route) => void) => new Router().checkRoutes(distinctRegistrations()).load(defineRoutes((Root) => register(Root.authorize(everyone))));
  const attach = (Root: Route, path: string, table: DataTable = MembersTable) => void Root.get(path, () => 'page').attach(table.endpoints() as never);

  it('stop the start, naming both paths', () => {
    expect(() =>
      load((Root) => {
        attach(Root, '/teams/:team/m');
        attach(Root, '/teams/:team/m');
      }),
    ).toThrow(/attached to two pages with the same URLs \(\/teams\/:team\/m\/_tables\/members\/actions\/:tableAction, \/teams\/:team\/m\/_tables\/members\/actions\/:tableAction\)/);
  });

  it('stop the start when only the names of their parameters differ', () => {
    expect(() =>
      load((Root) => {
        attach(Root, '/teams/:team/m');
        attach(Root, '/teams/:id/m');
      }),
    ).toThrow(/same URLs \(\/teams\/:team\/m\/_tables.*\/teams\/:id\/m\/_tables/);
  });

  it('are told apart by the pattern of a parameter', () => {
    expect(() =>
      load((Root) => {
        attach(Root, '/teams/:team{[0-9]+}/m');
        attach(Root, '/teams/:slug{[a-z]+}/m');
      }),
    ).not.toThrow();
  });

  it('load when the paths differ', () => {
    expect(() =>
      load((Root) => {
        attach(Root, '/teams/:team/m');
        attach(Root, '/teams/:team/in/:role/m');
      }),
    ).not.toThrow();
  });
});

describe('the table provider', () => {
  it('stops the start of an app whose routes register a table twice under the same URLs', async () => {
    const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent } as unknown as Logger;
    const routes = defineRoutes((Root) => {
      const open = Root.authorize(everyone);
      open.get('/teams/:team/m', () => 'page').attach(MembersTable.endpoints() as never);
      open.get('/teams/:id/m', () => 'page').attach(MembersTable.endpoints() as never);
    });
    await expect(
      createApplication(
        {
          root: '/tmp',
          discover: false,
          providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, DatabaseServiceProvider, TableServiceProvider],
          modules: [defineModule({ name: 'twice', routes })],
        },
        {
          env: { DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=', NODE_ENV: 'test', LOG_LEVEL: 'silent' },
          override: (container) => void container.instance(Logger, silent),
        },
      ),
    ).rejects.toThrow(/attached to two pages with the same URLs/);
  });
});
