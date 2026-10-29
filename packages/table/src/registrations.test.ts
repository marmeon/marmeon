import { Encrypter, EncryptionServiceProvider } from '@marmeon/encryption';
import { Gate } from '@marmeon/auth';
import { Database } from '@marmeon/database';
import { defineRoutes, everyone, Router, type Route } from '@marmeon/router';
import { afterEach, describe, expect, it } from 'vitest';
import { drivers, MembersTable, tableApp, USERS, type TableTestApp } from './__fixtures__/app.ts';
import { createApplication, defineModule, Logger } from '@marmeon/core';
import { DatabaseServiceProvider } from '@marmeon/database';
import { HttpServiceProvider } from '@marmeon/http';
import { ServerServiceProvider } from '@marmeon/server';
import { DataTables, TableServiceProvider, tableRoutes } from './index.ts';
import { distinctRegistrations } from './tables.ts';
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

describe.each(drivers)('one table on several pages (%s)', (driver) => {
  it('links the endpoints of the registration next to each page, with that page\'s own parameters', async () => {
    open = await tableApp(driver);
    expect(await urlsOf(open, ADA, '/teams/1/members')).toEqual({
      action: '/teams/1/_tables/members/actions/deactivate',
      bulk: '/teams/1/_tables/members/bulk/deactivate',
      export: '/teams/1/_tables/members/export/csv',
    });
    expect(await urlsOf(open, ADA, '/teams/1/in/staff/members')).toEqual({
      action: '/teams/1/in/staff/_tables/members/actions/deactivate',
      bulk: '/teams/1/in/staff/_tables/members/bulk/deactivate',
      export: '/teams/1/in/staff/_tables/members/export/csv',
    });
  });

  it('serves the endpoints of both pages, each behind its own checks', async () => {
    open = await tableApp(driver);
    const deactivate = (user: number, prefix: string) => open!.request(`${prefix}/_tables/members/actions/deactivate`, { method: 'POST', user, json: { key: '4' } });
    const download = (user: number, prefix: string) => open!.request(`${prefix}/_tables/members/export/csv`, { user });
    expect((await deactivate(ADA, '/teams/1')).status).toBe(200);
    expect((await deactivate(ADA, '/teams/1/in/staff')).status).toBe(200);
    // Edsger may export (the table's own rule), and the first page has no check beyond that ...
    expect((await download(EDSGER, '/teams/1')).status).toBe(200);
    // ... the second registration adds an admin-only check of its own, which stays on its routes.
    expect((await download(EDSGER, '/teams/1/in/staff')).status).toBe(403);
    expect((await download(ADA, '/teams/1/in/staff')).status).toBe(200);
  });

  it('keeps the tenant: a team that is not the user\'s gets nothing from either registration', async () => {
    open = await tableApp(driver);
    for (const prefix of ['/teams/2', '/teams/2/in/staff']) {
      expect((await open.request(`${prefix}/_tables/members/export/csv`, { user: ADA })).status).toBe(404);
    }
  });
});

/** A `DataTables` of the test app that reads its endpoints from `router` instead. */
function tablesOn(application: TableTestApp, router: Router): DataTables {
  const scope = application.application.container.createScope();
  return new DataTables(scope.make(Database), () => new Gate({ user: async () => USERS[ADA] } as never, (Class) => scope.make(Class)), (Class) => scope.make(Class), router, () => scope.make(Encrypter));
}

const routerOf = (register: (Root: Route) => void) => new Router().load(defineRoutes((Root) => register(Root.authorize(everyone))));

describe.each(drivers)('registrations that cannot be told apart, or none for the page (%s)', (driver) => {
  const ctx = (path: string, url = path.replace(':team', '1')) => ({ route: { path }, request: new Request(`http://localhost${url}`), query: { per_page: 25, page: 1 }, user: USERS[ADA], team: 1 }) as never;

  it('refuses the same prefix twice, naming both paths', async () => {
    open = await tableApp(driver);
    const router = routerOf((Root) => {
      tableRoutes(Root.prefix('/teams/:team') as never, MembersTable as never);
      tableRoutes(Root.prefix('/teams/:team') as never, MembersTable as never);
    });
    await expect(tablesOn(open, router).resolve(MembersTable, ctx('/teams/:team/members'))).rejects.toThrow(
      /registered its endpoints twice \(\/teams\/:team\/_tables\/members\/actions\/:tableAction, \/teams\/:team\/_tables\/members\/actions\/:tableAction\)/,
    );
  });

  it('picks the longest prefix of the page, by whole segments', async () => {
    open = await tableApp(driver);
    const router = routerOf((Root) => {
      tableRoutes(Root.prefix('/teams/:team') as never, MembersTable as never);
      tableRoutes(Root.prefix('/teams/:team/in/:role') as never, MembersTable as never);
      tableRoutes(Root.prefix('/teams/:tea') as never, MembersTable as never);
    });
    const data = async (path: string, url?: string) => (await tablesOn(open!, router).resolve(MembersTable, ctx(path, url))) as unknown as TableData;
    expect((await data('/teams/:team/members')).actions[0]!.url).toBe('/teams/1/_tables/members/actions/deactivate');
    expect((await data('/teams/:team/in/:role/members', '/teams/1/in/staff/members')).actions[0]!.url).toBe('/teams/1/in/staff/_tables/members/actions/deactivate');
  });

  it('refuses a page under none of several registrations, and says where to register', async () => {
    open = await tableApp(driver);
    const router = routerOf((Root) => {
      tableRoutes(Root.prefix('/teams/:team/in/:role') as never, MembersTable as never);
      tableRoutes(Root.prefix('/teams/:team/out') as never, MembersTable as never);
    });
    await expect(tablesOn(open, router).resolve(MembersTable, ctx('/teams/:team/members'))).rejects.toThrow(
      /under none of the pages it has routes for \(\/teams\/:team\/in\/:role, \/teams\/:team\/out\) — register next to its page/,
    );
  });

  it('links a single registration from any page, and refuses a table without routes', async () => {
    open = await tableApp(driver);
    const router = routerOf((Root) => tableRoutes(Root.prefix('/teams/:team') as never, MembersTable as never));
    const data = (await tablesOn(open, router).resolve(MembersTable, ctx('/teams/:team/elsewhere/members', '/teams/1/elsewhere/members'))) as unknown as TableData;
    expect(data.actions[0]!.url).toBe('/teams/1/_tables/members/actions/deactivate');
    await expect(tablesOn(open, new Router()).resolve(MembersTable, ctx('/teams/:team/members'))).rejects.toThrow(/has actions or exports but no routes/);
  });
});

describe('two registrations under the same URLs', () => {
  const load = (register: (Root: Route) => void) => new Router().checkRoutes(distinctRegistrations()).load(defineRoutes((Root) => register(Root.authorize(everyone))));

  it('stop the start, naming both paths', () => {
    expect(() =>
      load((Root) => {
        tableRoutes(Root.prefix('/teams/:team') as never, MembersTable as never);
        tableRoutes(Root.prefix('/teams/:team') as never, MembersTable as never);
      }),
    ).toThrow(/registered its endpoints twice \(\/teams\/:team\/_tables\/members\/actions\/:tableAction, \/teams\/:team\/_tables\/members\/actions\/:tableAction\)/);
  });

  it('stop the start when only the names of their parameters differ', () => {
    expect(() =>
      load((Root) => {
        tableRoutes(Root.prefix('/teams/:team') as never, MembersTable as never);
        tableRoutes(Root.prefix('/teams/:id') as never, MembersTable as never);
      }),
    ).toThrow(/registered its endpoints twice \(\/teams\/:team\/_tables.*\/teams\/:id\/_tables/);
  });

  it('are told apart by the pattern of a parameter', () => {
    expect(() =>
      load((Root) => {
        tableRoutes(Root.prefix('/teams/:team{[0-9]+}') as never, MembersTable as never);
        tableRoutes(Root.prefix('/teams/:slug{[a-z]+}') as never, MembersTable as never);
      }),
    ).not.toThrow();
  });

  it('load when the paths differ', () => {
    expect(() =>
      load((Root) => {
        tableRoutes(Root.prefix('/teams/:team') as never, MembersTable as never);
        tableRoutes(Root.prefix('/teams/:team/in/:role') as never, MembersTable as never);
      }),
    ).not.toThrow();
  });
});

describe('the table provider', () => {
  it('stops the start of an app whose routes register a table twice under the same URLs', async () => {
    const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent } as unknown as Logger;
    const routes = defineRoutes((Root) => {
      const open = Root.authorize(everyone);
      tableRoutes(open.prefix('/teams/:team') as never, MembersTable as never);
      tableRoutes(open.prefix('/teams/:id') as never, MembersTable as never);
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
    ).rejects.toThrow(/registered its endpoints twice/);
  });
});
