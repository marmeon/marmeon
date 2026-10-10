import { NO_STORE } from '@marmeon/auth';
import { INTENDED_KEY } from '@marmeon/http';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '../auth/factories/UserFactory.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

describe('prefetching', () => {
  it('answers a prefetch like the visit — the same page, still no-store for a signed-in user', async () => {
    const [ada, grace] = await app.factory(UserFactory).count(2).create();
    const prefetched = await app.actingAs(ada!).prefetching().get(`/users/${grace!.id}`).assertOk().assertHeader('cache-control', NO_STORE);
    expect(prefetched.page()).toMatchObject({ component: 'user-profile/Show', props: { profile: { name: grace!.name } } });
    expect(prefetched.headers.get('vary')).toContain('purpose');
  });

  it('a prefetch is not where a guest wanted to go — only a visit is remembered for after the login', async () => {
    const ada = await app.factory(UserFactory).create();
    // A guest hovers a link to a protected page: the login page, but no intended URL.
    const prefetch = await app.prefetching().get(`/users/${ada.id}`).assertRedirect('/login').assertSessionMissing(INTENDED_KEY);
    // Nothing remembered — so no session is kept at all (new, empty sessions are not written).
    expect(prefetch.cookie('marmeon_session')).toBeUndefined();
    await app.post('/login', { form: { email: ada.email, password: 'password' } }).assertRedirect('/users/me'); // not to the hovered page
    // The visit itself is remembered.
    await app.navigating().get(`/users/${ada.id}`).assertRedirect('/login').assertSessionHas(INTENDED_KEY, `/users/${ada.id}`);
  });

  it('neither does a prefetch of a page behind the password confirmation', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).prefetching().get('/settings/tokens').assertRedirect('/confirm-password').assertSessionMissing(INTENDED_KEY);
    await app.actingAs(ada).navigating().get('/settings/tokens').assertRedirect('/confirm-password').assertSessionHas(INTENDED_KEY, '/settings/tokens');
  });
});
