import { UserRepository, type User } from '#modules/auth';
import { FLASH_WAITING_HEADER } from '@bespokecore/http/page';
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';

/**
 * Flash messages on the server (E60): a protocol field, taken only by an answer the user is shown — a page, a partial reload,
 * a layer, an action — never by a prefetch or an island; delivered once. (In a tab, with the real navigator: back-button.test.ts.)
 */

let app: TestApp;
let ada: User;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true });
  const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  ada = users[0]!;
});

const profile = (user: User) => `/users/${user.id}`;

/** Saves the profile without following the redirect: the message waits in the session — for the browser that has the cookie. */
async function saved() {
  const response = await app.actingAs(ada).put(profile(ada), { json: { name: 'Ada King', bio: '' } }).assertRedirect(profile(ada)).assertNoFlash();
  response.assertFlashed('toast', { kind: 'success', message: 'Profile saved.' });
  return app.withCookie('bespoke_session', response.cookie('bespoke_session')!);
}

describe('flash messages: taken only by an answer that is shown (E60)', () => {
  it('counter-check: a prefetch takes none — it says one waits, and the page it leads to delivers it', async () => {
    const browser = await saved();
    const prefetched = await browser.prefetching().get('/people').assertOk().assertNoFlash();
    expect(prefetched.headers.get(FLASH_WAITING_HEADER)).toBe('true');
    expect(prefetched.page()!.props).not.toHaveProperty('flash');
    await browser.navigating().get('/people').assertOk().assertFlash('toast', { message: 'Profile saved.' });
    // Taken: nothing waits any more, no prefetch says so.
    expect((await browser.prefetching().get('/people')).headers.get(FLASH_WAITING_HEADER)).toBeNull();
  });

  it('counter-check: a partial reload delivers what waits — whatever props it asks for (a form sent with `only` lost it, W5)', async () => {
    const browser = await saved();
    const partial = await browser.reloading<ShowUserProfileController>('user-profile/Show', { only: ['activity'] }).get(profile(ada)).assertOk();
    expect(Object.keys(partial.page()!.props).sort()).toEqual(['activity', 'errors']);
    partial.assertFlash('toast', { message: 'Profile saved.' });
  });

  it('counter-check: delivered once — the next page, partial reload or deferred load brings it no more (Inertia #3015)', async () => {
    const browser = await saved();
    await browser.navigating().get(profile(ada)).assertFlash('toast');
    await browser.reloading<ShowUserProfileController>('user-profile/Show', { only: ['activity'] }).get(profile(ada)).assertNoFlash();
    await browser.navigating().get(profile(ada)).assertNoFlash();
  });

  it('a layer’s answer delivers it — and a deep link’s document carries it on the page, not in the layer', async () => {
    const layered = await saved();
    await layered.layering().get(`${profile(ada)}/edit`).assertOk().assertFlash('toast', { message: 'Profile saved.' });
    const deep = await saved();
    const document = await deep.get(`${profile(ada)}/edit`, { headers: { accept: 'text/html' } }).assertOk().assertFlash('toast');
    expect(document.layers().map((layer) => layer.flash)).toEqual([undefined]);
  });

  it('counter-check: a response with a message is never kept by a cache — a document from the HTTP cache would fire it again', async () => {
    const out = await app.actingAs(ada).post('/logout').assertRedirect('/login');
    const login = await app.withCookie('bespoke_session', out.cookie('bespoke_session')!).get('/login', { headers: { accept: 'text/html' } }).assertOk();
    login.assertFlash('toast', { message: 'You have been signed out.' }).assertHeader('cache-control', 'no-store');
  });

  it('an island takes none — read-only (E52): the message stays for the page', async () => {
    const browser = await saved();
    await browser.island('dashboard.sign-ins').assertOk().assertNoFlash();
    await browser.navigating().get('/dashboard').assertFlash('toast');
  });
});
