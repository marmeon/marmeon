import { UserRepository, type User } from '#modules/auth';
import { EditorSignInLog, OfficeAccess } from '@fixtures/back-office';
import { Connections, SchemaRequirements } from '@marmeon/database';
import { Router } from '@marmeon/router';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

// The back office integrated with the app's users (`BACK_OFFICE_USERS=app`): nobody signs in to its guard, the customers of the app are the
// people it judges, and the app says through `OfficeAccess` which of them are editors (the dashboard's administrators with a confirmed
// address: Ada). The seeders still make the rows of `office_users` (Eve with Ada's id, Victor with Alan's), which this mode must never read.
let app: TestApp;
let ada: User, alan: User, grace: User;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true, env: { BACK_OFFICE_USERS: 'app' } });
  const customers: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada, alan, grace] = customers as [User, User, User];
});

const entries = () => app.make(EditorSignInLog).entries().map((entry) => [entry.guard, entry.userId]);
const browser = () => app.keepingCookies();
const signIn = (as: TestApp, who: { email: string }) => as.post('/login', { form: { email: who.email, password: 'password' } });
const propsOf = async (as: TestApp, path: string) => (await as.navigating().get(path)).page()!.props as Record<string, any>;

describe('the back office with the app’s users', () => {
  it('sends a guest to the app’s sign-in, and shows an editor of the app the overview', async () => {
    await app.get('/office').assertRedirect('/login');
    const customer = browser();
    await signIn(customer, ada).assertRedirect();
    expect(await propsOf(customer, '/office')).toMatchObject({ name: 'Ada Lovelace', users: 'app', canPublish: true });
  });

  it('refuses a customer without a role, with 403, though the id has a row in `office_users`', async () => {
    // Victor, the viewer of the back office's own table, has Alan's id: that row must not make Alan an editor.
    const rows = await app.make(Connections).get().selectFrom('office_users').select(['id', 'role']).where('id', '=', alan.id).execute();
    expect(rows).toEqual([{ id: alan.id, role: 'viewer' }]);
    await app.actingAs(alan).get('/office').assertForbidden();
    // Grace has no row at all.
    await app.actingAs(grace).get('/office').assertForbidden();
  });

  it('judges the app’s user and reads `office_users` for nothing: the rows may say anything or not be there', async () => {
    const db = app.make(Connections).get();
    // Ada's id is Eve's: made a viewer there, Ada still publishes by the app's say.
    await db.updateTable('office_users').set({ role: 'viewer' }).where('id', '=', ada.id).execute();
    expect(await propsOf(app.actingAs(ada), '/office')).toMatchObject({ name: 'Ada Lovelace', canPublish: true });
    // With every row gone, the same, and Alan is still refused with Victor's row gone too.
    await db.deleteFrom('office_users').execute();
    expect(await propsOf(app.actingAs(ada), '/office')).toMatchObject({ name: 'Ada Lovelace', canPublish: true });
    await app.actingAs(alan).get('/office').assertForbidden();
  });

  it('refuses everybody while the app binds no access', async () => {
    await app.close();
    const unbound = await createTestApp(
      { ...application, modules: application.modules!.map((module) => (module.name === 'back-office' ? { ...module, providers: [] } : module)) },
      { database: 'refresh', seed: true, env: { BACK_OFFICE_USERS: 'app' } },
    );
    const [admin] = (await unbound.make(UserRepository).query().selectAll().orderBy('id').execute()) as User[];
    await unbound.actingAs(admin!).get('/office').assertForbidden();
    await unbound.close();
  });

  it('has none of the package’s own routes, so nothing signs in, confirms or lists sign-ins there', async () => {
    const customer = app.actingAs(ada);
    for (const path of ['/office/login', '/office/sessions', '/office/confirm-password', '/office/secure']) await customer.get(path).assertNotFound();
    for (const path of ['/office/login', '/office/logout', '/office/confirm-password', '/office/sessions/anything/end']) await customer.post(path, { form: { email: 'eve@office.example.com', password: 'password' } }).assertNotFound();
    // The editor of the other mode does not exist here: his address and password sign in nowhere.
    await app.post('/login', { form: { email: 'eve@office.example.com', password: 'password' } }).assertInvalid(['email']).assertGuest();
  });

  it('waits for the three tables in this mode as in the other: the app migrates them all, and the guard is registered', () => {
    expect(app.make(SchemaRequirements).all().map((requirement) => requirement.table).filter((table) => table.startsWith('office_')).sort()).toEqual(['office_password_reset_tokens', 'office_sign_ins', 'office_users']);
  });

  it('has the routes of the other mode, the same names, methods and paths, so the app’s route list never depends on BACK_OFFICE_USERS', async () => {
    const listed = (target: TestApp) =>
      target
        .make(Router)
        .routes.filter((route) => route.routeName?.startsWith('office.'))
        .map((route) => `${route.methods.join(',')} ${route.path} ${route.routeName}`)
        .sort();
    const own = await createTestApp(application);
    const ownRoutes = listed(own);
    await own.close();
    expect(ownRoutes.length).toBeGreaterThan(5);
    expect(listed(app)).toEqual(ownRoutes);
  });

  it.each([null, 'suspended', '', 'Editor', 1, true])('admits nobody when the app’s OfficeAccess answers %j: no role the package knows is no role', async (answer) => {
    await app.close();
    app = await createTestApp(application, {
      database: 'refresh',
      seed: true,
      env: { BACK_OFFICE_USERS: 'app' },
      override: (container) => container.instance(OfficeAccess, { roleOf: () => answer as never }),
    });
    const customers: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
    [ada] = customers as [User, ...User[]];
    await app.actingAs(ada).get('/office').assertForbidden();
    await signIn(browser(), ada).assertRedirect();
    expect(entries()).toEqual([]);
  });

  it('refuses an administrator whose address is not confirmed, and records no sign-in of theirs, as the status board does', async () => {
    await app.make(UserRepository).update(ada.id, { email_verified_at: null });
    await app.actingAs(ada).get('/office').assertForbidden();
    await signIn(browser(), ada).assertRedirect();
    expect(entries()).toEqual([]);
    await app.make(UserRepository).update(ada.id, { email_verified_at: new Date().toISOString() });
    await app.actingAs(ada).get('/office').assertOk();
  });

  describe('the editor sign-ins the app lists', () => {

    it('records the sign-in of an editor of the app as (web, 1)', async () => {
      await signIn(browser(), ada).assertRedirect();
      expect(entries()).toEqual([['web', ada.id]]);
    });

    it('records no sign-in of a customer without a role, though the slot hears every sign-in of the app', async () => {
      await signIn(browser(), alan).assertRedirect();
      await signIn(browser(), grace).assertRedirect();
      expect(entries()).toEqual([]);
      await signIn(browser(), ada).assertRedirect();
      expect(entries()).toEqual([['web', ada.id]]);
    });
  });
});
