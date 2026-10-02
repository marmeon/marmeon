import { UserFactory, UserRepository } from '#modules/auth';
import { browserRoutes, LOCATION_HEADER, ONCE_HEADER, ONCE_SCOPE_HEADER, RELOAD_HEADER, Router, VERSION_HEADER, type PageObject } from '@bespokecore/http';
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { afterEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

/** Once props, `<Form>` without JavaScript, instant visits and the two 409s — in the web app (W5b step 10, E63/E64). */

let app: TestApp;
afterEach(async () => {
  await app?.close();
});

/** Signs in with a real session (its id is what once props are scoped to) — the cookie a browser would keep. */
async function signIn(email: string) {
  const login = await app.post('/login', { form: { email, password: 'password' }, headers: { referer: 'http://localhost/login' } }).assertRedirect();
  return app.withCookie('bespoke_session', login.cookie('bespoke_session')!);
}

describe('once props: the locale list (E64)', () => {
  it('comes with the first page, is skipped while the tab holds it — and comes again for someone else signed in under it', async () => {
    app = await createTestApp(application, { database: 'refresh' });
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    await app.factory(UserFactory).create({ email: 'alan@example.com' });
    const ada = await signIn('ada@example.com');
    const first = (await ada.navigating().get('/people').assertOk()).page()!;
    expect(first.props.locales).toEqual(['en', 'de']);
    expect(first.onceProps).toEqual({ locales: { key: 'locales' } });
    const scope = first.onceScope!;
    expect(scope).toMatch(/^[\w-]{22}$/);
    // The tab says it holds it: the server leaves it out (and does not compute it — see packages/server parity.test.ts).
    const held = (await ada.navigating().withHeaders({ [ONCE_HEADER]: 'locales', [ONCE_SCOPE_HEADER]: scope }).get('/people')).page()!;
    expect(held.props).not.toHaveProperty('locales');
    expect(held.onceProps).toEqual({ locales: { key: 'locales' } });

    // Alan signs in in another tab: this tab's cookie is Alan's now, its memory still Ada's — the server sends it again.
    const alan = await signIn('alan@example.com');
    const forAlan = (await alan.navigating().withHeaders({ [ONCE_HEADER]: 'locales', [ONCE_SCOPE_HEADER]: scope }).get('/people')).page()!;
    expect(forAlan.props.locales).toEqual(['en', 'de']);
    expect(forAlan.onceScope).not.toBe(scope);
  });

  it('a new scope after signing out — the 409 is a full load anyway, and the guest’s session is not the user’s', async () => {
    app = await createTestApp(application, { database: 'refresh' });
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const ada = await signIn('ada@example.com');
    const scope = (await ada.navigating().get('/people')).page()!.onceScope;
    const out = await ada.navigating().post('/logout').assertStatus(409);
    expect(out.headers.get(RELOAD_HEADER)).toBe('history');
    const guest = app.withCookie('bespoke_session', out.cookie('bespoke_session')!);
    const login = (await guest.navigating().withHeaders({ [ONCE_HEADER]: 'locales', [ONCE_SCOPE_HEADER]: scope! }).get('/login')).page()!;
    expect(login.props.locales).toEqual(['en', 'de']);
    expect(login.onceScope).not.toBe(scope);
  });
});

describe('the two 409s (E64)', () => {
  it('a new build answers `version` — signing in answers `history`, never cancelable', async () => {
    app = await createTestApp(application, { database: 'refresh', env: { ASSET_VERSION: 'build-2' } });
    const stale = await app.navigating().withHeaders({ [VERSION_HEADER]: 'build-1' }).get('/login').assertStatus(409);
    expect([stale.headers.get(LOCATION_HEADER), stale.headers.get(RELOAD_HEADER)]).toEqual(['http://localhost/login', 'version']);
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const signedIn = await app.navigating().withHeaders({ [VERSION_HEADER]: 'build-2' }).post('/login', { json: { email: 'ada@example.com', password: 'password' } }).assertStatus(409);
    expect(signedIn.headers.get(RELOAD_HEADER)).toBe('history');
  });
});

describe('<Form> without JavaScript (E64)', () => {
  it('the language switcher is a real form: POST /locale with `_token` (from the page) — CSRF checked', async () => {
    app = await createTestApp(application, { database: 'refresh', csrf: true });
    const login = await app.navigating().get('/login');
    const token = login.page()!.csrf!;
    expect(token).toBeTruthy();
    const browser = app.withCookie('bespoke_session', login.cookie('bespoke_session')!);
    await browser.post('/locale', { form: { locale: 'de' }, headers: { referer: 'http://localhost/login' } }).assertStatus(419);
    await browser.post('/locale', { form: { _token: token, locale: 'de' }, headers: { referer: 'http://localhost/login' } }).assertRedirect('/login').assertSessionHas('locale', 'de');
  });

  it('a PUT route without JavaScript: POST with `_method=PUT` saves the profile — the CSRF check runs for the PUT', async () => {
    app = await createTestApp(application, { database: 'refresh', csrf: true });
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com', name: 'Ada' });
    const login = await app.navigating().get('/login');
    const guest = app.withCookie('bespoke_session', login.cookie('bespoke_session')!);
    const signedIn = await guest.post('/login', { form: { _token: login.page()!.csrf!, email: 'ada@example.com', password: 'password' }, headers: { referer: 'http://localhost/login' } }).assertRedirect();
    const browser = app.withCookie('bespoke_session', signedIn.cookie('bespoke_session')!);
    const page = (await browser.navigating().get(`/users/${ada.id}/edit`)).page() as PageObject;
    await browser.post(`/users/${ada.id}`, { form: { _method: 'PUT', name: 'Ada', bio: 'x' }, headers: { referer: `http://localhost/users/${ada.id}/edit` } }).assertStatus(419);
    await browser
      .post(`/users/${ada.id}`, { form: { _method: 'PUT', _token: page.csrf!, name: 'Ada King', bio: 'Poet of science.' }, headers: { referer: `http://localhost/users/${ada.id}/edit` } })
      .assertRedirect(`/users/${ada.id}`);
    expect((await app.make(UserRepository).find(ada.id))?.name).toBe('Ada King');
  });
});

describe('<Form>: the token form as a browser sends it (E64)', () => {
  it('ticked boxes as `abilities[]` create the token; no box ticked is the app’s own message — not a missing key', async () => {
    app = await createTestApp(application, { database: 'refresh' });
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    // Signing in counts as a fresh password confirmation (the token pages ask for one).
    const ada = await signIn('ada@example.com');
    const created = await ada.layering().post('/settings/tokens', { form: { name: 'CI', 'abilities[]': 'users:read' } }).assertOk().assertLayer('auth/NewAccessToken');
    expect((created.page()!.props as { plainText: string }).plainText).toMatch(/^bc_/);
    const none = await ada.expectingJson().post('/settings/tokens', { form: { name: 'CI' } }).assertStatus(422);
    expect(none.json()).toMatchObject({ errors: { abilities: ['Pick what the token may do.'] } });
  });
});

describe('instant visits: the view a route renders (E64)', () => {
  it('the browser’s routes name the view of a page — not of a layer, an island or an action', async () => {
    app = await createTestApp(application, { database: 'refresh' });
    const routes = browserRoutes(app.make(Router).routes).routes;
    expect(routes['user-profile.show']?.view).toBe('user-profile/Show');
    expect(routes['user-profile.people']?.view).toBe('user-profile/People');
    expect(routes['dashboard.show']?.view).toBe('dashboard/Show');
    expect(routes['user-profile.edit']?.view).toBeUndefined();
    expect(routes['dashboard.sign-ins']?.view).toBeUndefined();
    expect(routes['user-profile.update']?.view).toBeUndefined();
  });
});
