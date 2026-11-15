import { UserRepository, type User } from '#modules/auth';
import { EditorSignInLog, OfficeGuard, type OfficeUser } from '@fixtures/back-office';
import { authenticate } from '@marmeon/auth';
import { defineModule } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { Controller, defineRoutes, everyone } from '@marmeon/http';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

// What each guard of the back office decides (roles, the guest and sign-in middleware, the intended page, sign-in ids), against the real app in the
// mode `own`. The flows are in `back-office.test.ts`.
let app: TestApp;
let ada: User;
let eve: OfficeUser;
let victor: OfficeUser;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true });
  const customers: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada] = customers as [User, ...User[]];
  [eve, victor] = (await offices(app)) as [OfficeUser, OfficeUser];
});

const offices = (target: TestApp) => target.make(Connections).get().selectFrom('office_users').select(['id', 'name', 'email', 'role']).orderBy('id').execute() as Promise<OfficeUser[]>;
const browser = () => app.keepingCookies();
const editorSignsIn = (as: TestApp, who: { email: string }, password = 'password') => as.post('/office/login', { form: { email: who.email, password } });
const customerSignsIn = (as: TestApp, who: { email: string }) => as.post('/login', { form: { email: who.email, password: 'password' } });
const entries = () => app.make(EditorSignInLog).entries().map((entry) => [entry.guard, entry.userId]);

describe('a role the back office does not know', () => {
  it.each(['suspended', '', 'Editor', ' editor'])('opens nothing for the editor whose role is %j: signed in, every page 403, and no sign-in recorded', async (role) => {
    await app.make(Connections).get().updateTable('office_users').set({ role }).where('id', '=', eve.id).execute();
    const editor = browser();
    await editorSignsIn(editor, eve).assertRedirect('/office');
    for (const path of ['/office', '/office/sessions', '/office/confirm-password']) await editor.get(path).assertForbidden();
    expect(entries()).toEqual([]);
  });

  it('lets an editor whose role became unknown sign out: the sign-in ends and the next request goes to the sign-in page', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve).assertRedirect('/office');
    await app.make(Connections).get().updateTable('office_users').set({ role: 'suspended' }).where('id', '=', eve.id).execute();
    await editor.get('/office').assertForbidden();
    await editor.post('/office/logout').assertRedirect('/office/login').assertGuest({ guard: OfficeGuard });
    await editor.get('/office').assertRedirect('/office/login');
  });

  it('takes the stub’s default for the least role: an editor added without a role looks and does not publish', async () => {
    const db = app.make(Connections).get();
    await db.insertInto('office_users').values({ name: 'New', email: 'new@office.example.com', password: 'x' }).execute();
    const row = await db.selectFrom('office_users').select('role').where('email', '=', 'new@office.example.com').executeTakeFirstOrThrow();
    expect(row.role).toBe('viewer');
  });
});

describe('the sign-in form', () => {
  it('answers an empty password with an error on the password field, and an empty address on the address field', async () => {
    await editorSignsIn(app, eve, '').assertInvalid({ password: /required/i });
    await editorSignsIn(app, { email: '' }).assertInvalid({ email: /required/i });
    await app.get('/office').assertRedirect('/office/login');
  });
});

describe('the guest and sign-in middleware of the back office', () => {
  it('sends a signed-in editor away from the sign-in page and from a sign-in post', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve).assertRedirect('/office');
    await editor.get('/office/login').assertRedirect('/office');
    await editor.post('/office/login', { form: { email: victor.email, password: 'password' } }).assertRedirect('/office');
    // Still Eve: the second sign-in changed nothing.
    await editor.navigating().get('/office').assertOk().assertPage('office::Overview', { name: 'Eve Editor' });
  });

  it('refuses a guest’s sign-out and a customer’s, to the back office’s sign-in', async () => {
    await app.post('/office/logout').assertRedirect('/office/login');
    const customer = browser();
    await customerSignsIn(customer, ada).assertRedirect();
    await customer.post('/office/logout').assertRedirect('/office/login');
    // The customer is still signed in: the refused sign-out ended nothing.
    await customer.get('/dashboard').assertOk();
  });
});

describe('the sudo mode', () => {
  it('throttles the editor’s password checks, and refuses the right password while the count holds', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    app.travel({ minutes: 20 });
    const held = { password: /^Too many attempts\. Try again in \d+ seconds?\.$/ };
    // Five wrong passwords a minute are answered as wrong, the sixth is held up, and so is the right one while the count holds.
    for (let attempt = 1; attempt <= 5; attempt++) await editor.post('/office/confirm-password', { form: { password: 'wrong' } }).assertInvalid({ password: 'The password is not correct.' });
    await editor.post('/office/confirm-password', { form: { password: 'wrong' } }).assertInvalid(held);
    await editor.post('/office/confirm-password', { form: { password: 'password' } }).assertInvalid(held);
    await editor.get('/office/secure').assertRedirect('/office/confirm-password');
  });
});

describe('the sign-in list', () => {
  it('ends no sign-in of another editor, and answers a made-up id as it answers Victor’s', async () => {
    const db = app.make(Connections).get();
    const editor = browser();
    const other = browser();
    await editorSignsIn(editor, eve);
    await editorSignsIn(other, victor);
    const [theirs] = await db.selectFrom('office_sign_ins').select('id').where('user_id', '=', victor.id).execute();
    const answers: (string | null)[] = [];
    for (const id of [theirs!.id, 'a'.repeat(22)]) {
      const response = await editor.post(`/office/sessions/${id}/end`);
      answers.push(`${response.status} ${response.headers.get('location')}`);
    }
    expect(answers).toEqual(['303 /office/sessions', '303 /office/sessions']);
    expect(await db.selectFrom('office_sign_ins').select('id').where('id', '=', theirs!.id).execute()).toHaveLength(1);
    await other.get('/office').assertOk();
  });
});

describe('the page a guest wanted', () => {
  it('takes the editor to the back office page they wanted, and sends nobody to a page of the app', async () => {
    const editor = browser();
    await editor.get('/office/sessions').assertRedirect('/office/login');
    await editorSignsIn(editor, eve).assertRedirect('/office/sessions');
  });

  it('leaves a customer’s wish alone: the editor’s sign-in goes to the overview, and the customer’s own sign-in still takes theirs', async () => {
    const both = browser();
    await both.get('/settings/security').assertRedirect('/login');
    await editorSignsIn(both, eve).assertRedirect('/office');
    await customerSignsIn(both, ada).assertRedirect('/settings/security');
  });

  it('does the same at the sudo page: the confirmation returns to the back office page, and never to the customer’s wish', async () => {
    const editor = browser();
    await editorSignsIn(editor, eve);
    app.travel({ minutes: 20 });
    await editor.get('/office/secure').assertRedirect('/office/confirm-password');
    await editor.post('/office/confirm-password', { form: { password: 'password' } }).assertRedirect('/office/secure');
    app.travel({ minutes: 20 });
    await editor.get('/office/secure').assertRedirect('/office/confirm-password');
    // A guest of the app asks for a page of the app in this browser meanwhile.
    await editor.get('/settings/security').assertRedirect('/login');
    await editor.post('/office/confirm-password', { form: { password: 'password' } }).assertRedirect('/office/secure');
  });
});

describe('the page a guest wanted, written with an encoded address', () => {
  it('follows an encoded address of the back office after the sign-in and after the confirmation', async () => {
    const editor = browser();
    await editor.get('/%6Fffice/sessions').assertRedirect('/office/login');
    await editorSignsIn(editor, eve).assertRedirect('/%6Fffice/sessions');
    app.travel({ minutes: 20 });
    await editor.get('/%6Fffice/secure').assertRedirect('/office/confirm-password');
    await editor.post('/office/confirm-password', { form: { password: 'password' } }).assertRedirect('/%6Fffice/secure');
  });

  it.each(['/%6Fffices', '/office%2Fsessions', '/%E0%A4%A', '/officex/sessions'])('goes to the overview when the wanted page is %s: it is no page below the back office', async (wanted) => {
    // No route answers these, so no visit stores them: the session is given the page, as a guard's middleware would have stored it.
    const editor = app.withSession({ _intended_url: wanted } as never);
    await editorSignsIn(editor, eve).assertRedirect('/office');
    // The same session with a page that is below the back office is followed: the test would be red otherwise.
    await editorSignsIn(app.withSession({ _intended_url: '/%6Fffice/sessions' } as never), eve).assertRedirect('/%6Fffice/sessions');
  });
});

describe('the back office moved to another path', () => {
  it('lives below BACK_OFFICE_PATH and nowhere else', async () => {
    await app.close();
    app = await createTestApp(application, { database: 'refresh', seed: true, env: { BACK_OFFICE_PATH: '/backend' } });
    [eve] = (await offices(app)) as [OfficeUser, ...OfficeUser[]];
    await app.get('/backend').assertRedirect('/backend/login');
    await app.get('/office').assertNotFound();
    const editor = browser();
    await editor.post('/backend/login', { form: { email: eve.email, password: 'password' } }).assertRedirect('/backend').assertAuthenticated(eve, { guard: OfficeGuard });
    await editor.navigating().get('/backend').assertOk().assertPage('office::Overview', { name: 'Eve Editor' });
  });
});

describe('the app’s shared props on pages of the back office’s path', () => {
  class Page extends Controller {
    handle() {
      return this.view('office::Secure', {});
    }
  }

  it('are left out below the path, named or not, and kept on any other path, whatever its name or its likeness to the path', async () => {
    const probe = defineModule({
      name: 'office-props-probe',
      routes: defineRoutes((Route) => {
        const customers = Route.middleware(authenticate()).authorize(everyone);
        customers.get('/office/probe/unnamed', Page);
        customers.get('/hours', Page).name('office.hours');
        customers.get('/officex', Page);
        customers.get('/officers/list', Page);
      }),
    });
    await app.close();
    app = await createTestApp({ ...application, modules: [...application.modules!, probe] }, { database: 'refresh', seed: true });
    const refreshed: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
    [ada] = refreshed as [User, ...User[]];
    const customer = app.actingAs(ada).navigating();
    const propsOf = async (path: string) => (await customer.get(path)).page()!.props as Record<string, unknown>;
    const below = await propsOf('/office/probe/unnamed');
    for (const key of ['auth', 'bell', 'locales']) expect(below, key).not.toHaveProperty(key);
    for (const path of ['/hours', '/officex', '/officers/list']) {
      const props = await propsOf(path);
      expect(props.auth, path).toEqual({ user: { name: 'Ada Lovelace', verified: true } });
      expect(props, path).toHaveProperty('bell');
    }
  });
});

describe('the app’s shared props on an encoded address of the back office', () => {
  it.each<[string, 'office::Overview' | 'office::Sessions']>([
    ['/%6Fffice', 'office::Overview'],
    ['/%6Fffice/sessions', 'office::Sessions'],
  ])('show nothing of the customer at %s, with both people signed in', async (path, component) => {
    const both = browser();
    await customerSignsIn(both, ada).assertRedirect();
    await editorSignsIn(both, eve).assertRedirect('/office');
    const page = (await both.navigating().get(path)).assertOk().assertPage(component);
    for (const key of ['auth', 'bell', 'locales']) expect(page.page()!.props, key).not.toHaveProperty(key);
    expect(page.body).not.toContain('Ada Lovelace');
    const html = await both.get(path, { headers: { accept: 'text/html' } });
    expect(html.body).not.toContain('Ada Lovelace');
  });

  it('does the same under a renamed path', async () => {
    await app.close();
    app = await createTestApp(application, { database: 'refresh', seed: true, env: { BACK_OFFICE_PATH: '/back-office' } });
    [eve] = (await offices(app)) as [OfficeUser, ...OfficeUser[]];
    const both = browser();
    await customerSignsIn(both, ada).assertRedirect();
    await both.post('/back-office/login', { form: { email: eve.email, password: 'password' } }).assertRedirect('/back-office');
    const page = (await both.navigating().get('/%62ack%2Doffice/sessions')).assertOk().assertPage('office::Sessions');
    expect(page.page()!.props).not.toHaveProperty('auth');
    expect(page.body).not.toContain('Ada Lovelace');
  });
});
