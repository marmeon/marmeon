import { UserRepository, type User } from '#modules/auth';
import { EditorSignInLog, EditorSlot, OfficeGuard, type OfficeUser } from '@fixtures/back-office';
import { authenticate, can, Gate, type AuthUser } from '@marmeon/auth';
import { Hasher } from '@marmeon/auth';
import { Connections } from '@marmeon/database';
import { defineModule, Logger } from '@marmeon/core';
import { Controller, defineRoutes, everyone } from '@marmeon/http';
import { cookieNames } from '@marmeon/auth/testing';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

// The back office package with users of its own (the default mode): its editors are rows of `office_users`, apart from the app's customers in
// `users`. The seeders make the editor Eve and the viewer Victor (with the ids of Ada and Alan) next to the customers Ada, Alan and Grace: the id of Ada
// is two different people, and only the guard tells them apart.
let app: TestApp;
let ada: User;
let eve: OfficeUser;
let victor: OfficeUser;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true });
  [ada] = (await customers(app)) as [User];
  [eve, victor] = (await office(app)) as [OfficeUser, OfficeUser];
});
afterEach(() => vi.unstubAllEnvs());

/** The customers of the app (`users`), by id. */
const customers = (target: TestApp): Promise<User[]> => target.make(UserRepository).query().selectAll().orderBy('id').execute();
const office = (target: TestApp) => target.make(Connections).get().selectFrom('office_users').select(['id', 'name', 'email', 'role']).orderBy('id').execute() as Promise<OfficeUser[]>;

/** The back office guard's device cookie (the app runs on HTTP in tests: no `__Host-` prefix). */
const DEVICE = 'marmeon_device.office.device';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

/** A browser of its own: it keeps the cookies of its responses, as a person's does. */
const browser = (userAgent = FIREFOX) => app.keepingCookies().withHeaders({ 'user-agent': userAgent });
const editorSignsIn = (as: TestApp, who: { email: string }, password = 'password') => as.post('/office/login', { form: { email: who.email, password } });
const customerSignsIn = (as: TestApp, who: { email: string }, password = 'password') => as.post('/login', { form: { email: who.email, password } });
const propsOf = async (as: TestApp, path: string) => (await as.navigating().get(path)).page()!.props as Record<string, any>;

describe('the back office with users of its own', () => {
  it('seeds an editor with the id of the customer Ada, and nobody shares an address with the other table', async () => {
    expect(eve.id).toBe(ada.id);
    expect([eve.name, ada.name]).toEqual(['Eve Editor', 'Ada Lovelace']);
    expect(victor).toMatchObject({ role: 'viewer' });
    expect(victor.id).toBe((await customers(app))[1]!.id);
    const addresses = (await customers(app)).map((row) => row.email);
    for (const editor of [eve, victor]) expect(addresses).not.toContain(editor.email);
  });

  describe('the sign-in', () => {
    it('sends a guest to the back office sign-in, not the app’s', async () => {
      await app.get('/office').assertRedirect('/office/login');
      await app.navigating().get('/office/login').assertOk().assertPage('office::Login');
    });

    it('treats a customer of the app as a guest of the back office, though a customer with the same id is signed in', async () => {
      const customer = app.actingAs(ada);
      await customer.get('/office').assertRedirect('/office/login');
      await customer.get('/office/sessions').assertRedirect('/office/login');
      await customer.get('/office/secure').assertRedirect('/office/login');
      // The sign-in page is for guests of the back office: it is open to the customer.
      await customer.navigating().get('/office/login').assertOk().assertPage('office::Login');
    });

    it('signs the editor in with the id of the back office and shows the overview', async () => {
      const editor = browser();
      await editorSignsIn(editor, eve).assertRedirect('/office').assertAuthenticated(eve, { guard: OfficeGuard });
      expect(await propsOf(editor, '/office')).toMatchObject({ name: 'Eve Editor', users: 'own', canPublish: true });
    });

    it('refuses a customer’s credentials at the back office, and an editor’s at the app, with the answer of an unknown address', async () => {
      const editor = browser();
      const failed = { email: 'These credentials do not match our records.' };
      await editorSignsIn(editor, { email: 'nobody@example.com' }).assertInvalid(failed);
      await editorSignsIn(editor, ada).assertInvalid(failed).assertGuest({ guard: OfficeGuard });
      // The editors' address and password do not sign in at the app either.
      await customerSignsIn(editor, eve).assertInvalid(failed).assertGuest();
      await editor.get('/office').assertRedirect('/office/login');
    });

    it('keeps the portal pages as they were: a guest for an editor alone, the customer’s own page beside the editor', async () => {
      const editor = browser();
      await editorSignsIn(editor, eve).assertRedirect('/office');
      // The editor is no customer: the portal sends them to the app's sign-in.
      await editor.get('/dashboard').assertRedirect('/login');
      // One browser can hold both: the customer is Ada, the editor Eve. The portal's pages show the customer, the back office's pages show nothing
      // of the app's user: no name, and no bell, which would subscribe the page to the customer's notification channel.
      await customerSignsIn(editor, ada).assertRedirect();
      expect((await propsOf(editor, '/dashboard')).auth).toEqual({ user: { name: 'Ada Lovelace', verified: true } });
      expect(await propsOf(editor, '/dashboard')).toHaveProperty('bell', { unread: expect.any(Number) });
      const page = (await editor.navigating().get('/office')).page()!;
      expect(page.props).toMatchObject({ name: 'Eve Editor' });
      expect(page.props).not.toHaveProperty('auth');
      expect(page.props).not.toHaveProperty('bell');
      expect(JSON.stringify(page)).not.toContain('Ada Lovelace');
    });

    it('signs an editor out of the back office session, as the browser’s session ends', async () => {
      const editor = browser();
      await editorSignsIn(editor, eve);
      await editor.post('/office/logout').assertRedirect('/office/login').assertGuest({ guard: OfficeGuard });
      await editor.get('/office').assertRedirect('/office/login');
    });
  });

  describe('the sign-ins of an editor', () => {
    it('lists the editor’s own, the current browser first, and ends another with the sudo mode', async () => {
      const laptop = browser(FIREFOX);
      const phone = browser(SAFARI);
      await editorSignsIn(laptop, eve);
      await editorSignsIn(phone, eve);
      const list = async (as: TestApp) => (await propsOf(as, '/office/sessions')).signIns as { id: string; current: boolean; device: { browser: string | null } }[];
      const fromLaptop = await list(laptop);
      expect(fromLaptop.map((row) => [row.current, row.device.browser])).toEqual([
        [true, 'Firefox'],
        [false, 'Safari'],
      ]);
      expect(Object.keys(fromLaptop[0]!).sort()).toEqual(['current', 'device', 'id', 'lastSeenAt']);
      const other = fromLaptop[1]!.id;
      // A sign-in counts as a password confirmation for a quarter of an hour; ending another browser's needs a fresh one.
      app.travel({ minutes: 20 });
      await laptop.post(`/office/sessions/${other}/end`).assertRedirect('/office/confirm-password');
      expect(await list(laptop)).toHaveLength(2);
      await laptop.post('/office/confirm-password', { form: { password: 'wrong' } }).assertInvalid(['password']);
      await laptop.post('/office/confirm-password', { form: { password: 'password' } }).assertRedirect();
      await laptop.post(`/office/sessions/${other}/end`).assertRedirect('/office/sessions');
      expect((await list(laptop)).map((row) => row.current)).toEqual([true]);
      // The other browser is signed out of the back office.
      await phone.get('/office').assertRedirect('/office/login');
      await laptop.navigating().get('/office').assertOk().assertPage('office::Overview');
    });

    it('never ends a sign-in of the app, though its id is sent, and never lists one', async () => {
      const editor = browser();
      await editorSignsIn(editor, eve);
      const customer = browser(SAFARI);
      await customerSignsIn(customer, ada).assertRedirect();
      const db = app.make(Connections).get();
      const [theirs] = await db.selectFrom('sign_ins').select('id').where('user_id', '=', ada.id).execute();
      expect(theirs).toBeDefined();
      expect(((await propsOf(editor, '/office/sessions')).signIns as { id: string }[]).map((row) => row.id)).not.toContain(theirs!.id);
      await editor.post(`/office/sessions/${theirs!.id}/end`).assertRedirect('/office/sessions');
      expect(await db.selectFrom('sign_ins').select('id').where('id', '=', theirs!.id).execute()).toHaveLength(1);
      await customer.get('/dashboard').assertOk();
    });
  });

  describe('the sudo mode', () => {
    it('asks for the back office password though the app’s window is open, and one window never opens the other', async () => {
      const both = browser();
      await customerSignsIn(both, ada);
      await editorSignsIn(both, eve);
      // Both sign-ins are password confirmations; let both windows close, then open the customer's alone.
      app.travel({ minutes: 20 });
      await both.get('/settings/security').assertRedirect('/confirm-password');
      await both.get('/office/secure').assertRedirect('/office/confirm-password');
      await both.post('/confirm-password', { form: { password: 'password' } }).assertRedirect();
      await both.get('/settings/security').assertOk();
      await both.get('/office/secure').assertRedirect('/office/confirm-password');
      // The editor's password opens the back office's window only: the customer's closes again with time and the editor's stays.
      await both.post('/office/confirm-password', { form: { password: 'password' } }).assertRedirect();
      await both.navigating().get('/office/secure').assertOk().assertPage('office::Secure');
      app.travel({ minutes: 14 });
      await both.get('/office/secure').assertOk();
      app.travel({ minutes: 2 });
      await both.get('/office/secure').assertRedirect('/office/confirm-password');
      await both.get('/settings/security').assertRedirect('/confirm-password');
    });

    it('checks the editor’s hash, not the customer’s: with two different passwords only the editor’s opens the window', async () => {
      await app.make(UserRepository).updatePasswordHash(ada.id, await app.make(Hasher).make('the customer’s own word'));
      const both = browser();
      await customerSignsIn(both, ada, 'the customer’s own word').assertRedirect();
      await editorSignsIn(both, eve).assertRedirect('/office');
      app.travel({ minutes: 20 });
      await both.post('/office/confirm-password', { form: { password: 'the customer’s own word' } }).assertInvalid({ password: 'The password is not correct.' });
      await both.get('/office/secure').assertRedirect('/office/confirm-password');
      await both.post('/office/confirm-password', { form: { password: 'password' } }).assertRedirect();
      await both.get('/office/secure').assertOk();
    });
  });

  describe('the limits', () => {
    it('answers the sixth sign-in of a minute with `throttled`, and counts the customer’s sign-ins apart, though the address is the same', async () => {
      const shared = { email: ada.email };
      const editor = browser();
      for (let attempt = 1; attempt <= 5; attempt++) await editorSignsIn(editor, shared, 'wrong').assertInvalid({ email: 'These credentials do not match our records.' });
      await editorSignsIn(editor, shared, 'wrong').assertInvalid({ email: /^Too many sign-in attempts\. Try again in \d+ seconds?\.$/ });
      // The app's counter for the same address and client stays at zero: Ada signs in, and her wrong attempts are answered, not throttled.
      const customer = browser();
      await customerSignsIn(customer, ada, 'wrong').assertInvalid({ email: 'These credentials do not match our records.' });
      await customerSignsIn(customer, ada).assertRedirect().assertAuthenticated(ada);
      // Another address at the back office is another counter.
      await editorSignsIn(browser(), eve).assertRedirect('/office');
    });

    it('refuses the editor’s right password while the count of the minute holds', async () => {
      const editor = browser();
      for (let attempt = 1; attempt <= 5; attempt++) await editorSignsIn(editor, eve, 'wrong').assertInvalid({ email: 'These credentials do not match our records.' });
      await editorSignsIn(editor, eve).assertInvalid({ email: /^Too many sign-in attempts\. Try again in \d+ seconds?\.$/ }).assertGuest({ guard: OfficeGuard });
      app.travel({ minutes: 2 });
      await editorSignsIn(editor, eve).assertRedirect('/office').assertAuthenticated(eve, { guard: OfficeGuard });
    });

    it('limits the route itself: the thirty-first sign-in of a minute from one client is 429, whatever the addresses, and the app’s sign-in is not touched', async () => {
      const statuses: number[] = [];
      for (let n = 1; n <= 31; n++) statuses.push((await browser().post('/office/login', { form: { email: `nobody${n}@example.com`, password: 'wrong' } })).status);
      expect(statuses.slice(0, 30)).not.toContain(429);
      expect(statuses[30]).toBe(429);
      // The app's sign-in has a count of its own: Ada signs in from the same client.
      await customerSignsIn(browser(), ada).assertRedirect().assertAuthenticated(ada);
    });

    it('locks an account at its daily ceiling from many clients, and keeps the editor’s own browser signed in through its device cookie', async () => {
      await app.close();
      app = await createTestApp(application, { database: 'refresh', seed: true, env: { AUTH_ACCOUNT_SIGN_INS_PER_DAY: '10' } });
      [eve] = (await office(app)) as [OfficeUser, ...OfficeUser[]];
      const owner = await editorSignsIn(app, eve).assertRedirect('/office');
      const device = owner.cookie(DEVICE)!;
      expect(device, 'the sign-in hands the owner’s browser a device cookie').toBeTruthy();
      const from = (n: number) => app.withIp(`2001:db8:${(0x2000 + n).toString(16)}::1`);
      for (let n = 1; n <= 10; n++) await editorSignsIn(from(n), eve, 'wrong').assertInvalid({ email: 'These credentials do not match our records.' });
      // Ten failures from ten clients are the account's ceiling: now a sign-in from another client is refused, with the right password too.
      await editorSignsIn(from(20), eve).assertInvalid({ email: 'Too many failed sign-ins for this account. Try again later.' }).assertGuest({ guard: OfficeGuard });
      // The owner's browser carries the cookie of its own sign-in and gets in.
      await editorSignsIn(from(21).withCookie(DEVICE, device), eve).assertRedirect('/office').assertAuthenticated(eve, { guard: OfficeGuard });
    });
  });

  describe('the policy', () => {
    it('gives an editor the capability and a viewer the page without it', async () => {
      const editor = browser();
      await editorSignsIn(editor, eve);
      expect((await propsOf(editor, '/office')).canPublish).toBe(true);
      const viewer = browser();
      await editorSignsIn(viewer, victor);
      expect(await propsOf(viewer, '/office')).toMatchObject({ name: 'Victor Viewer', users: 'own', canPublish: false });
    });

    it('is asked for the editors of the bound guard in the test helpers, as a slot or as the guard', async () => {
      await app.actingAs(eve, { guard: OfficeGuard }).navigating().get('/office').assertOk().assertPage('office::Overview', { canPublish: true });
      await app.actingAs(victor, { guard: EditorSlot }).navigating().get('/office').assertOk().assertPage('office::Overview', { canPublish: false });
      // A customer with the id of an editor is nobody to the back office.
      await app.actingAs(ada).get('/office').assertRedirect('/office/login');
      await app.actingAs(eve, { guard: OfficeGuard }).get('/dashboard').assertRedirect('/login');
    });

    it('is no yes for an app policy on a route of the back office: the prop is false, the action 403, and development warns with A9', async () => {
      const warnings: string[] = [];
      const logger = { debug() {}, info() {}, warn: (message: string) => void warnings.push(message), error() {}, child: () => logger } as unknown as Logger;
      // An app policy that would say yes to every customer: it must not be asked for an editor.
      class AppOnlyPolicy {
        view(_user: AuthUser) {
          return true;
        }
      }
      class AskGate extends Controller {
        static readonly inject = [Gate] as const;
        readonly #gate: Gate;
        constructor(gate: Gate) {
          super();
          this.#gate = gate;
        }
        async handle() {
          return { canView: await this.#gate.allows(AppOnlyPolicy, 'view') };
        }
      }
      const probe = defineModule({
        name: 'office-probe',
        routes: defineRoutes((Route) => {
          const editors = Route.middleware(OfficeGuard.authenticate({ loginRoute: 'office.login' }));
          editors.authorize(everyone).get('/office/probe/prop', AskGate);
          editors.authorize(can(AppOnlyPolicy, 'view') as never).post('/office/probe/action', () => 'done');
          // The same policy on a route of the app is yes: the policy itself is fine.
          Route.middleware(authenticate()).authorize(can(AppOnlyPolicy, 'view')).get('/probe/app-action', () => 'done');
        }),
      });
      await app.close();
      app = await createTestApp({ ...application, modules: [...application.modules!, probe] }, { database: 'refresh', seed: true, override: (container) => container.instance(Logger, logger) });
      [ada] = (await customers(app)) as [User];
      [eve] = (await office(app)) as [OfficeUser, ...OfficeUser[]];
      vi.stubEnv('NODE_ENV', 'development');
      const editor = app.actingAs(eve, { guard: OfficeGuard });
      expect((await editor.get('/office/probe/prop', { headers: { accept: 'application/json' } })).json()).toEqual({ canView: false });
      await editor.post('/office/probe/action').assertForbidden();
      expect(warnings.filter((warning) => /A9/.test(warning)).length).toBeGreaterThan(0);
      expect(warnings.join('\n')).toMatch(/AppOnlyPolicy.*'web'.*'office'/s);
      await app.actingAs(ada).get('/probe/app-action').assertOk();
    });
  });

  describe('the editor sign-ins the app lists', () => {
    const entries = () => app.make(EditorSignInLog).entries().map((entry) => [entry.guard, entry.userId]);

    it('records the editor’s sign-in as (office, the editor’s id), once, and none for a customer’s with the same id', async () => {
      expect(entries()).toEqual([]);
      await customerSignsIn(browser(), ada).assertRedirect();
      expect(entries(), 'the customer Ada has the editor’s id, and the slot hears editors only').toEqual([]);
      await editorSignsIn(browser(), eve).assertRedirect('/office');
      expect(entries()).toEqual([['office', eve.id]]);
    });

    it('records nothing for a failed sign-in or a sign-in of the app that follows the editor’s', async () => {
      await editorSignsIn(browser(), eve, 'wrong').assertInvalid(['email']);
      await editorSignsIn(browser(), ada).assertInvalid(['email']);
      expect(entries()).toEqual([]);
      const both = browser();
      await editorSignsIn(both, victor);
      await customerSignsIn(both, ada);
      expect(entries()).toEqual([['office', victor.id]]);
    });
  });

  describe('the document', () => {
    it('has the back office’s own policy, not the app’s', async () => {
      const response = await app.get('/office/login', { headers: { accept: 'text/html' } }).assertOk();
      const policy = response.headers.get('content-security-policy')!;
      expect(policy).toMatch(/^script-src 'nonce-[^']+' 'strict-dynamic'; object-src 'none'; base-uri 'self'; style-src 'self' 'nonce-[^']+'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'$/);
      expect((await app.get('/login', { headers: { accept: 'text/html' } })).headers.get('content-security-policy')).not.toMatch(/img-src|connect-src/);
    });

    it('sets the guard’s own cookies and not the app’s remember-me cookie', async () => {
      const { session, remember } = cookieNames(app, OfficeGuard);
      const response = await editorSignsIn(browser(), eve).assertRedirect('/office');
      expect(response.cookie(session)).toBeDefined();
      response.assertCookieMissing(remember);
      response.assertCookieMissing(cookieNames(app).remember);
    });
  });
});
