import { Controller, defineRequest } from '@marmeon/http';
import { defineMiddleware, defineRoutes, everyone, Router, type Route, type RouteDefinition } from '@marmeon/router';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminOnlyTable, Deactivate, drivers, endpoint, tableApp, type TableTestApp } from './__fixtures__/app.ts';
import { endpointOf } from './tables.ts';
import { MemberPolicy } from './__fixtures__/policies.ts';
import { action, column, defineTable, exportCsv, type DataTable } from './index.ts';

const table = (options: { authorized: boolean }): DataTable =>
  defineTable({
    name: 'rows',
    query: ((db: { selectFrom(name: string): unknown }) => db.selectFrom('members')) as never,
    key: 'members.id',
    columns: { name: column('members.name').sortable() },
    actions: { deactivate: options.authorized ? action(Deactivate).authorize(MemberPolicy, 'deactivate') : action(Deactivate) },
    export: { csv: options.authorized ? exportCsv().authorize(() => true) : exportCsv() },
  } as never);

class Page extends Controller {
  handle() {
    return this.json({});
  }
}

/** A page whose request decides who may see it. */
class DecidedPage extends Controller {
  static request = defineRequest({ authorize: () => true });
  handle() {
    return this.json({});
  }
}

const load = (decide: (Root: Route) => Route, rows: DataTable, PageClass: typeof Page = Page) =>
  new Router().load(defineRoutes((Root) => void decide(Root.authorize(everyone)).get('/rows', PageClass).attach(rows.endpoints() as never)));

describe('endpoints() on a page that lets everyone call it', () => {
  it('refuses an action and an export without .authorize(), and says how to fix it', () => {
    expect(() => load((Root) => Root, table({ authorized: false }))).toThrow(/rows\.endpoints\(\): the page lets everyone call it, and action 'deactivate', export 'csv' have no \.authorize\(\)/);
  });

  it('loads when each action and export decides for itself', () => {
    expect(() => load((Root) => Root, table({ authorized: true }))).not.toThrow();
  });

  it('loads unauthorized actions on a page whose route decides with a check of its own', () => {
    expect(() => load((Root) => Root.authorize(() => true) as never, table({ authorized: false }))).not.toThrow();
  });

  it('loads unauthorized actions on a page whose request decides with an authorize of its own', () => {
    expect(() => load((Root) => Root, table({ authorized: false }), DecidedPage)).not.toThrow();
  });
});

describe('attachTo() called by hand, not through attach()', () => {
  const byHand = (hang: (open: Route, page: RouteDefinition) => void) =>
    new Router().load(
      defineRoutes((Root) => {
        const open = Root.authorize(everyone);
        hang(open, open.get('/rows', DecidedPage));
      }),
    );
  const message = /rows\.endpoints\(\) hangs on a page with attach\(\)/;

  it('refuses a registrar without the checks of the page\'s request, and records nothing', () => {
    const rows = table({ authorized: true });
    const router = byHand((open, page) => {
      expect(() => rows.endpoints().attachTo(open.prefix('/rows'), page)).toThrow(message);
    });
    const made = router.routes.filter((route) => route.path.includes('/_tables/'));
    expect(made.length).toBeGreaterThan(0);
    for (const route of made) expect(() => endpointOf(route)).toThrow();
  });

  it('refuses a registrar with the page\'s checks but not its middleware, and records nothing', () => {
    const rows = table({ authorized: true });
    const guard = defineMiddleware('guard', (_ctx, next) => next());
    const router = new Router().load(
      defineRoutes((Root) => {
        const open = Root.authorize(everyone);
        const page = open.middleware(guard).get('/rows', Page);
        expect(() => rows.endpoints().attachTo(open.prefix('/rows'), page)).toThrow(message);
        expect(() => rows.endpoints().attachTo(open.middleware(guard).prefix('/rows'), page)).not.toThrow();
      }),
    );
    const made = router.routes.filter((route) => route.path.includes('/_tables/') && route.middleware.length === 0);
    expect(made.length).toBeGreaterThan(0);
    for (const route of made) expect(() => endpointOf(route)).toThrow();
  });

  it('refuses a registrar under another path', () => {
    const rows = table({ authorized: true });
    byHand((open, page) => {
      expect(() => rows.endpoints().attachTo(open.prefix('/other'), page)).toThrow(message);
    });
  });

  it('refuses a registrar of another group', () => {
    const rows = table({ authorized: true });
    byHand((open, page) => {
      const other = Object.create(page, { group: { value: 'api' } }) as RouteDefinition;
      expect(() => rows.endpoints().attachTo(open.prefix('/rows'), other)).toThrow(message);
    });
  });
});

describe.each(drivers)('endpoints() carry the authorize of the page\'s request (%s)', (driver) => {
  const ALAN = 2; // team 1, no admin
  const ADA = 1; // team 1, admin
  let open: TableTestApp | undefined;
  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  it('refuses a user the page refuses on the page, the export, the action and the bulk action — before any handler or row', async () => {
    open = await tableApp(driver);
    expect((await open.request('/teams/1/admin-only', { user: ALAN })).status).toBe(403);
    open.queries.length = 0;
    const refused = [
      await open.request(endpoint(AdminOnlyTable, 'export', 'csv'), { user: ALAN }),
      await open.request(endpoint(AdminOnlyTable, 'action', 'deactivate'), { method: 'POST', user: ALAN, json: { key: 4 } }),
      await open.request(endpoint(AdminOnlyTable, 'bulk', 'deactivate'), { method: 'POST', user: ALAN, json: { keys: [4] } }),
    ];
    expect(refused.map((response) => response.status)).toEqual([403, 403, 403]);
    expect(open.queries).toEqual([]);
    expect(open.recorder.exports).toEqual([]);
    expect(open.recorder.deactivated).toEqual([]);
    expect(open.recorder.batches).toEqual([]);
  });

  it('serves the user the page lets in', async () => {
    open = await tableApp(driver);
    expect((await open.request('/teams/1/admin-only', { user: ADA })).status).toBe(200);
    expect((await open.request(endpoint(AdminOnlyTable, 'export', 'csv'), { user: ADA })).status).toBe(200);
    expect((await open.request(endpoint(AdminOnlyTable, 'action', 'deactivate'), { method: 'POST', user: ADA, json: { key: 4 } })).status).toBe(200);
    expect((await open.request(endpoint(AdminOnlyTable, 'bulk', 'deactivate'), { method: 'POST', user: ADA, json: { keys: [4] } })).status).toBe(200);
  });
});
