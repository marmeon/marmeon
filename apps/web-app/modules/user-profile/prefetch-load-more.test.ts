import { NO_STORE } from '@bespokecore/auth';
import { INTENDED_KEY } from '@bespokecore/http';
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '../auth/factories/UserFactory.ts';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

describe('prefetching (W5 step 6)', () => {
  it('answers a prefetch like the visit — the same page, still no-store for a signed-in user', async () => {
    const [ada, grace] = await app.factory(UserFactory).count(2).create();
    const prefetched = await app.actingAs(ada!).prefetching().get(`/users/${grace!.id}`).assertOk().assertHeader('cache-control', NO_STORE);
    expect(prefetched.page()).toMatchObject({ component: 'user-profile/Show', props: { profile: { name: grace!.name } } });
    expect(prefetched.headers.get('vary')).toContain('purpose');
  });

  it('counter-check: a prefetch is not where a guest wanted to go — only a visit is remembered for after the login', async () => {
    const ada = await app.factory(UserFactory).create();
    // A guest hovers a link to a protected page: the login page, but no intended URL.
    const prefetch = await app.prefetching().get(`/users/${ada.id}`).assertRedirect('/login').assertSessionMissing(INTENDED_KEY);
    await app
      .withCookie('bespoke_session', prefetch.cookie('bespoke_session')!)
      .post('/login', { form: { email: ada.email, password: 'password' } })
      .assertRedirect('/users/me'); // not to the hovered page
    // The visit itself is remembered.
    await app.navigating().get(`/users/${ada.id}`).assertRedirect('/login').assertSessionHas(INTENDED_KEY, `/users/${ada.id}`);
  });

  it('counter-check: neither does a prefetch of a page behind the password confirmation', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).prefetching().get('/settings/tokens').assertRedirect('/confirm-password').assertSessionMissing(INTENDED_KEY);
    await app.actingAs(ada).navigating().get('/settings/tokens').assertRedirect('/confirm-password').assertSessionHas(INTENDED_KEY, '/settings/tokens');
  });
});

describe('the people list: "Load more" (cursor pagination + deepMerge)', () => {
  it('sends the next five with a partial reload — merged by the browser: data appended, matched on id; meta replaced', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.factory(UserFactory).count(7).create();
    const first = (await app.actingAs(ada).navigating().get(`/users/${ada.id}`).assertOk()).page()!;
    const others = first.props.others as { data: { id: number }[]; meta: { nextCursor: string | null } };
    expect(others.data).toHaveLength(5);
    expect(first.deepMergeProps).toEqual(['others']);
    expect(first.matchPropsOn).toEqual(['others.data.id']);

    const more = (
      await app
        .actingAs(ada)
        .reloading<ShowUserProfileController>('user-profile/Show', { only: ['others'] })
        .get(`/users/${ada.id}?cursor=${others.meta.nextCursor}`)
        .assertOk()
    ).page()!;
    expect(Object.keys(more.props).sort()).toEqual(['errors', 'others']);
    const next = more.props.others as typeof others;
    expect(next.data).toHaveLength(2);
    expect(next.meta.nextCursor).toBeNull();
    expect(new Set([...others.data, ...next.data].map((person) => person.id)).size).toBe(7);
    expect(more).toMatchObject({ deepMergeProps: ['others'], matchPropsOn: ['others.data.id'] });
  });
});
