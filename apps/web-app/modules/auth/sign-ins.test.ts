import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

interface ListedSignIn {
  readonly id: string;
  readonly current: boolean;
  readonly remembered: boolean;
  readonly device: { readonly browser: string | null; readonly system: string | null };
}

describe('sign-ins on the security page', () => {
  const signIn = (email: string, userAgent: string, extra: Record<string, string> = {}) =>
    app.post('/login', { form: { email, password: 'password', ...extra }, headers: { 'user-agent': userAgent } });
  const as = (cookies: { session: string; remember?: string }) => {
    const browser = app.withCookie('marmeon_session', cookies.session);
    return cookies.remember ? browser.withCookie('remember_web', cookies.remember) : browser;
  };
  const listOf = async (session: string, userAgent: string) => {
    const page = await as({ session }).navigating().get('/settings/security', { headers: { 'user-agent': userAgent } });
    return page.page()!.props.signIns as readonly ListedSignIn[];
  };

  // The toast a redirect leaves in the session, as the page it leads to delivers it.
  const toastAfter = async (response: { cookie(name: string): string | undefined }, session: string) => {
    const page = await as({ session: response.cookie('marmeon_session') ?? session }).navigating().get('/settings/security');
    return page.flash().find((message) => message.key === 'toast')?.data;
  };

  it('lists the current browser first, with the parts of its device and no address or raw agent', async () => {
    const ada = await app.factory(UserFactory).create();
    const laptop = (await signIn(ada.email, FIREFOX)).cookie('marmeon_session')!;
    const phone = (await signIn(ada.email, SAFARI, { remember: 'on' })).cookie('marmeon_session')!;

    const fromLaptop = await listOf(laptop, FIREFOX);
    expect(fromLaptop.map((entry) => [entry.current, entry.remembered, entry.device.browser])).toEqual([
      [true, false, 'Firefox'],
      [false, true, 'Safari'],
    ]);
    const fromPhone = await listOf(phone, SAFARI);
    expect(fromPhone.map((entry) => entry.current)).toEqual([true, false]);
    expect(Object.keys(fromPhone[0]!).sort()).toEqual(['createdAt', 'current', 'device', 'id', 'lastSeenAt', 'remembered']);
    expect(JSON.stringify(fromPhone)).not.toContain('Mozilla');
  });

  it("signs the other browser out on its next request when its sign-in is ended", async () => {
    const ada = await app.factory(UserFactory).create();
    const laptop = (await signIn(ada.email, FIREFOX)).cookie('marmeon_session')!;
    const phoneLogin = await signIn(ada.email, SAFARI, { remember: 'on' });
    const phone = { session: phoneLogin.cookie('marmeon_session')!, remember: phoneLogin.cookie('remember_web')! };
    const other = (await listOf(laptop, FIREFOX)).find((entry) => !entry.current)!;

    await as({ session: laptop }).post(`/settings/sign-ins/${other.id}/end`).assertRedirect('/settings/security');

    await as(phone).expectingJson().get('/users/me').assertUnauthorized();
    // Its remember-me cookie signs nobody in again.
    await app.withCookie('remember_web', phone.remember).expectingJson().get('/users/me').assertUnauthorized();
    await as({ session: laptop }).get('/users/me').assertAuthenticated(ada);
    expect(await listOf(laptop, FIREFOX)).toHaveLength(1);
  });

  it('does not sign a remembered browser back in after its session ran out', async () => {
    const ada = await app.factory(UserFactory).create();
    const laptop = (await signIn(ada.email, FIREFOX)).cookie('marmeon_session')!;
    const phoneLogin = await signIn(ada.email, SAFARI, { remember: 'on' });
    const phone = { session: phoneLogin.cookie('marmeon_session')!, remember: phoneLogin.cookie('remember_web')! };
    const other = (await listOf(laptop, FIREFOX)).find((entry) => !entry.current)!;
    await as({ session: laptop }).post(`/settings/sign-ins/${other.id}/end`).assertRedirect('/settings/security');

    app.travel({ minutes: 121 });
    await as(phone).expectingJson().get('/users/me').assertUnauthorized();
  });

  it('needs a password typed lately', async () => {
    const ada = await app.factory(UserFactory).create();
    const laptop = (await signIn(ada.email, FIREFOX)).cookie('marmeon_session')!;
    const phone = (await signIn(ada.email, SAFARI)).cookie('marmeon_session')!;
    const other = (await listOf(laptop, FIREFOX)).find((entry) => !entry.current)!;

    // A session that never typed its password (or not lately): `actingAs` has no confirmation.
    const away = await app.actingAs(ada).post(`/settings/sign-ins/${other.id}/end`, { headers: { accept: 'text/html' } });
    away.assertRedirect('/confirm-password');
    await as({ session: phone }).get('/users/me').assertAuthenticated(ada);

    const confirmed = await app.withCookie('marmeon_session', away.cookie('marmeon_session')!).post('/confirm-password', { form: { password: 'password' } });
    await app.withCookie('marmeon_session', confirmed.cookie('marmeon_session')!).post(`/settings/sign-ins/${other.id}/end`).assertRedirect('/settings/security');
    await as({ session: phone }).expectingJson().get('/users/me').assertUnauthorized();
  });

  it("answers an id of another account like an unknown one, and leaves that account's sign-in alone", async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    const laptop = (await signIn(ada.email, FIREFOX)).cookie('marmeon_session')!;
    const bobs = (await signIn(bob.email, SAFARI)).cookie('marmeon_session')!;
    const bobsId = (await listOf(bobs, SAFARI))[0]!.id;

    const foreign = await as({ session: laptop }).post(`/settings/sign-ins/${bobsId}/end`);
    foreign.assertRedirect('/settings/security');
    const foreignToast = await toastAfter(foreign, laptop);
    const unknown = await as({ session: laptop }).post('/settings/sign-ins/does-not-exist/end');
    unknown.assertRedirect('/settings/security');
    expect(foreignToast).toBeDefined();
    expect(await toastAfter(unknown, laptop)).toEqual(foreignToast);
    await as({ session: bobs }).get('/users/me').assertAuthenticated(bob);
  });

  it('is refused without the CSRF token, and from another site', async () => {
    await app.close(); // one database app per test
    const protectedApp = await createTestApp(application, { csrf: true, database: 'refresh' });
    const ada = await protectedApp.factory(UserFactory).create();
    const login = (userAgent: string) =>
      protectedApp.post('/login', { form: { email: ada.email, password: 'password' }, headers: { 'user-agent': userAgent, 'sec-fetch-site': 'same-origin' } });
    const laptopLogin = await login(FIREFOX);
    const phone = (await login(SAFARI)).cookie('marmeon_session')!;
    const laptop = protectedApp.withCookie('marmeon_session', laptopLogin.cookie('marmeon_session')!);
    const token = decodeURIComponent(laptopLogin.cookie('XSRF-TOKEN')!);
    const page = await laptop.navigating().get('/settings/security', { headers: { 'user-agent': FIREFOX } });
    const other = (page.page()!.props.signIns as readonly ListedSignIn[]).find((entry) => !entry.current)!;
    const url = `/settings/sign-ins/${other.id}/end`;

    await laptop.post(url).assertStatus(419);
    await laptop.post(url, { form: { _token: token }, headers: { 'sec-fetch-site': 'cross-site' } }).assertStatus(403);
    await protectedApp.withCookie('marmeon_session', phone).get('/users/me').assertAuthenticated(ada);

    await laptop.post(url, { form: { _token: token } }).assertRedirect('/settings/security');
    await protectedApp.withCookie('marmeon_session', phone).expectingJson().get('/users/me').assertUnauthorized();
  });

  it("refuses to end the browser's own sign-in", async () => {
    const ada = await app.factory(UserFactory).create();
    const laptop = (await signIn(ada.email, FIREFOX)).cookie('marmeon_session')!;
    const own = (await listOf(laptop, FIREFOX))[0]!;

    const refused = await as({ session: laptop }).post(`/settings/sign-ins/${own.id}/end`);
    refused.assertRedirect('/settings/security');
    expect(await toastAfter(refused, laptop)).toMatchObject({ message: expect.stringContaining('Sign out') });
    await as({ session: laptop }).get('/users/me').assertAuthenticated(ada);
    expect(await listOf(laptop, FIREFOX)).toHaveLength(1);
  });
});
