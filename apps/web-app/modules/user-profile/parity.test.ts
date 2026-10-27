import { UserFactory, UserRepository } from '#modules/auth';
import type { PageObject } from '@marmeon/http';
import { LOCATION_HEADER, ONCE_HEADER, ONCE_SCOPE_HEADER, RELOAD_HEADER, VERSION_HEADER } from '@marmeon/http/protocol';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

/** Once props, `<Form>` without JavaScript and the two 409s — in the web app. */

let app: TestApp;
afterEach(async () => {
  await app?.close();
});

/** Signs in with a real session (its id is what once props are scoped to) — the cookie a browser would keep. */
async function signIn(email: string) {
  const login = await app.post('/login', { form: { email, password: 'password' }, headers: { referer: 'http://localhost/login' } }).assertRedirect();
  return app.withCookie('marmeon_session', login.cookie('marmeon_session')!);
}

describe('once props: the locale list', () => {
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
    const guest = app.withCookie('marmeon_session', out.cookie('marmeon_session')!);
    const login = (await guest.navigating().withHeaders({ [ONCE_HEADER]: 'locales', [ONCE_SCOPE_HEADER]: scope! }).get('/login')).page()!;
    expect(login.props.locales).toEqual(['en', 'de']);
    expect(login.onceScope).not.toBe(scope);
  });
});

describe('the two 409s', () => {
  it('a new build answers `version` — signing in answers `history`, never cancelable', async () => {
    app = await createTestApp(application, { database: 'refresh', env: { SERVER_ASSET_VERSION: 'build-2' } });
    const stale = await app.navigating().withHeaders({ [VERSION_HEADER]: 'build-1' }).get('/login').assertStatus(409);
    expect([stale.headers.get(LOCATION_HEADER), stale.headers.get(RELOAD_HEADER)]).toEqual(['/login', 'version']);
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const signedIn = await app.navigating().withHeaders({ [VERSION_HEADER]: 'build-2' }).post('/login', { json: { email: 'ada@example.com', password: 'password' } }).assertStatus(409);
    expect(signedIn.headers.get(RELOAD_HEADER)).toBe('history');
  });
});

describe('<Form> without JavaScript', () => {
  it('the language switcher is a real form: a guest\'s POST /locale passes by the browser\'s word — never from elsewhere', async () => {
    app = await createTestApp(application, { database: 'refresh', csrf: true });
    const login = await app.navigating().get('/login');
    // A guest has no session — no token in the page, no cookie.
    expect(login.page()!.csrf).toBeUndefined();
    expect(login.headers.getSetCookie()).toEqual([]);
    const referer = { referer: 'http://localhost/login' };
    await app.post('/locale', { form: { locale: 'de' }, headers: referer }).assertStatus(419); // no browser word, no token
    await app.post('/locale', { form: { locale: 'de' }, headers: { ...referer, 'sec-fetch-site': 'cross-site' } }).assertStatus(403);
    await app.post('/locale', { form: { locale: 'de' }, headers: { ...referer, origin: 'https://evil.example' } }).assertStatus(403);
    await app.post('/locale', { form: { locale: 'de' }, headers: { ...referer, 'sec-fetch-site': 'same-origin' } }).assertRedirect('/login').assertSessionHas('locale', 'de');
    // Plain HTTP (no Fetch Metadata): the form's Origin is the app's.
    await app.post('/locale', { form: { locale: 'de' }, headers: { ...referer, origin: 'http://localhost' } }).assertRedirect('/login').assertSessionHas('locale', 'de');
  });

  it('a PUT route without JavaScript: POST with `_method=PUT` saves the profile — the CSRF check runs for the PUT', async () => {
    app = await createTestApp(application, { database: 'refresh', csrf: true });
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com', name: 'Ada' });
    const signedIn = await app.post('/login', { form: { email: 'ada@example.com', password: 'password' }, headers: { referer: 'http://localhost/login', 'sec-fetch-site': 'same-origin' } }).assertRedirect();
    const browser = app.withCookie('marmeon_session', signedIn.cookie('marmeon_session')!);
    const page = (await browser.navigating().get(`/users/${ada.public_id}/edit`)).page() as PageObject;
    expect(page.csrf).toBeTruthy(); // a session: its pages carry the token for forms without JavaScript
    await browser.post(`/users/${ada.public_id}`, { form: { _method: 'PUT', name: 'Ada', bio: 'x' }, headers: { referer: `http://localhost/users/${ada.public_id}/edit` } }).assertStatus(419);
    await browser
      .post(`/users/${ada.public_id}`, { form: { _method: 'PUT', _token: page.csrf!, name: 'Ada King', bio: 'Poet of science.' }, headers: { referer: `http://localhost/users/${ada.public_id}/edit` } })
      .assertRedirect(`/users/${ada.public_id}`);
    expect((await app.make(UserRepository).find(ada.id))?.name).toBe('Ada King');
  });
});

describe('<Form>: the token form as a browser sends it', () => {
  it('ticked boxes as `abilities[]` create the token; no box ticked is the app’s own message — not a missing key', async () => {
    app = await createTestApp(application, { database: 'refresh' });
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    // Signing in counts as a fresh password confirmation (the token pages ask for one).
    const ada = await signIn('ada@example.com');
    const created = await ada.layering().post('/settings/tokens', { form: { current_password: 'password', name: 'CI', 'abilities[]': 'users:read' } }).assertOk().assertLayer('auth/NewAccessToken');
    expect((created.page()!.props as { plainText: string }).plainText).toMatch(/^marmeon_/);
    const none = await app.withCookie('marmeon_session', created.cookie('marmeon_session')!).expectingJson().post('/settings/tokens', { form: { current_password: 'password', name: 'CI' } }).assertStatus(422);
    expect(none.json()).toMatchObject({ errors: { abilities: ['Pick what the token may do.'] } });
  });
});
