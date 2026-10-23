import { UserRepository, type User } from '#modules/auth';
import { Connections } from '@marmeon/database';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { ProfileActivity } from './ProfileActivity.ts';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';
import { ProfileLinkFactory } from './factories/ProfileLinkFactory.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

let app: TestApp;
let ada: User, alan: User;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true });
  const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada, alan] = users as [User, User];
});

const profile = (user: User) => `/users/${user.public_id}`;
/** The profile page reloading some of its props, as `router.reload({ only })` does. */
const reload = (user: User, only: readonly ('activity' | 'stats' | 'email' | 'errors')[]) =>
  app.actingAs(user).reloading<ShowUserProfileController>('user-profile/Show', { only });

describe('profile page: deferred and optional props', () => {
  it('sends the page without its deferred activity and optional stats — and names the deferred group', async () => {
    const response = await app.actingAs(ada).navigating().get(profile(ada)).assertOk();
    const page = response.page()!;
    expect(page.props).not.toHaveProperty('activity');
    expect(page.props).not.toHaveProperty('stats');
    expect(page.deferredProps).toEqual({ default: ['activity'] });
    expect(page.props).toHaveProperty('profile');
  });

  it('loads the activity with a partial reload — only it (and the always-sent errors)', async () => {
    await app.factory(ProfileLinkFactory).create({ user_id: ada.id, label: 'Notes' });
    const page = (await reload(ada, ['activity']).get(profile(ada)).assertOk()).page()!;
    expect(Object.keys(page.props).sort()).toEqual(['activity', 'errors']);
    expect(page.deferredProps).toBeUndefined();
    const activity = page.props.activity as { kind: string; label?: string }[];
    expect(activity.map((entry) => entry.kind)).toContain('joined');
    expect(activity).toContainEqual(expect.objectContaining({ kind: 'link', label: 'Notes' }));
  });

  it('computes the stats only when asked for — and the deferred activity not then', async () => {
    const queries: string[] = [];
    app.make(Connections).onQuery((query) => queries.push(query.sql));
    const page = (await reload(ada, ['stats']).get(profile(ada)).assertOk()).page()!;
    expect(page.props).toEqual({ errors: {}, stats: { links: 2, memberNumber: 1, members: 3 } });
    // `activity` is deferred: a partial reload for other props never runs its query.
    expect(queries.some((sql) => /order by "created_at" desc/i.test(sql))).toBe(false);
  });

  it('is a normal request: signed out → the login page (the middleware runs), not the props', async () => {
    await app
      .navigating()
      .withHeaders({ 'x-marmeon-partial-component': 'user-profile/Show', 'x-marmeon-partial-data': 'stats,email' })
      .get(profile(ada))
      .assertRedirect('/login');
  });

  it('only filters what the controller returned: asking for another user’s e-mail by name gets null', async () => {
    const page = (await reload(alan, ['email', 'stats']).get(profile(ada)).assertOk()).page()!;
    expect(page.props.email).toBeNull(); // the controller decided (ProfilePolicy) — the header cannot ask past it
    const own = (await reload(ada, ['email']).get(profile(ada)).assertOk()).page()!;
    expect(own.props.email).toBe('ada@example.com');
  });

  it('answers a partial reload naming another page in full', async () => {
    const page = (await app.actingAs(ada).reloading('user-profile/Edit', { only: ['stats'] }).get(profile(ada)).assertOk()).page()!;
    expect(page.props).toHaveProperty('profile');
    expect(page.props).not.toHaveProperty('stats');
    expect(page.deferredProps).toEqual({ default: ['activity'] });
  });

  it('a slow deferred prop does not hold up the page: first the page, then the prop', async () => {
    // The activity panel is held by a gate: the page has to come without it, the reload only once the gate opens.
    const opened = Promise.withResolvers<void>();
    const real = app.make(ProfileActivity);
    app.container.scoped(ProfileActivity, () =>
      Object.assign(Object.create(real) as ProfileActivity, {
        recent: async (...args: Parameters<ProfileActivity['recent']>) => {
          await opened.promise;
          return real.recent(...args);
        },
      }),
    );
    try {
      const first = (await app.actingAs(ada).navigating().get(profile(ada)).assertOk()).page()!;
      expect(first.deferredProps).toEqual({ default: ['activity'] });

      let settled = false;
      const reloading = Promise.resolve(app.actingAs(ada).reloading<ShowUserProfileController>('user-profile/Show', { only: ['activity'] }).get(profile(ada))).then((response) => {
        settled = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      opened.resolve();
      const deferred = (await reloading).page()!;
      expect(deferred.props.activity).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'joined' })]));
    } finally {
      opened.resolve();
      app.container.scoped(ProfileActivity);
    }
  });
});
