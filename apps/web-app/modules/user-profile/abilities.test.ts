import { UserRepository, type User } from '#modules/auth';
import type { AuthUser } from '@marmeon/auth';
import { LoginActivityRepository } from './LoginActivityRepository.ts';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { ShowRecentSignInsController } from '../dashboard/controllers/ShowRecentSignInsController.ts';
import type { EditUserProfileController } from './controllers/EditUserProfileController.ts';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';
import { ProfileLinkPolicy } from './policies/ProfileLinkPolicy.ts';
import { ProfilePolicy } from './policies/ProfilePolicy.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

/** Every policy call of a request, by ability — what the projection asked. */
let asked: string[] = [];

class CountingProfilePolicy extends ProfilePolicy {
  override update(user: AuthUser, profile: { readonly id: number }) {
    asked.push('profile.update');
    return super.update(user, profile);
  }
  override viewEmail(user: AuthUser, profile: { readonly id: number }) {
    asked.push('profile.viewEmail');
    return super.viewEmail(user, profile);
  }
}

class CountingLinkPolicy extends ProfileLinkPolicy {
  override delete(user: AuthUser, link: { user_id: number }) {
    asked.push('link.delete');
    return super.delete(user, link);
  }
}

let app: TestApp;
let ada: User, alan: User;
beforeEach(async () => {
  asked = [];
  app = await createTestApp(application, {
    database: 'refresh',
    seed: true,
    override: (container) => {
      container.bind(ProfilePolicy, CountingProfilePolicy);
      container.bind(ProfileLinkPolicy, CountingLinkPolicy);
    },
  });
  const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada, alan] = users as [User, User];
});

const profile = (user: User) => `/users/${user.public_id}`;
type Link = { id: string; label: string; can: { delete: boolean } };
const linksOf = (props: object) => (props as { profile: { links: Link[] } }).profile.links;

describe('abilities in the frontend — an explicit, typed projection', () => {
  it('the profile projects `abilities` and every link’s `can` — booleans, from the policies', async () => {
    const own = (await app.actingAs(ada).navigating().get(profile(ada)).assertOk()).page()!;
    expect(own.props.abilities).toEqual({ update: true });
    expect(linksOf(own.props).map((link) => link.can)).toEqual([{ delete: true }, { delete: true }]);

    const other = await app.actingAs(alan).navigating().get(profile(ada)).assertOk();
    const page = other.page()!;
    expect(page.props.abilities).toEqual({ update: false });
    expect(linksOf(page.props).map((link) => link.can)).toEqual([{ delete: false }, { delete: false }]);
    // Only booleans leave the server — the policies' reason (`deny('user-profile.validation.own_profile')`) never does.
    expect(other.body).not.toContain('own_profile');
    expect(other.body).not.toContain('only change your own');
  });

  it('asks exactly what is projected: one update, one viewEmail (the e-mail prop), one delete per link — nothing else', async () => {
    await app.actingAs(alan).navigating().get(profile(ada)).assertOk();
    expect(asked.sort()).toEqual(['link.delete', 'link.delete', 'profile.update', 'profile.viewEmail']);
  });

  it('a partial reload for other props runs no projection (lazy props)', async () => {
    await app.actingAs(alan).reloading<ShowUserProfileController>('user-profile/Show', { only: ['activity'] }).get(profile(ada)).assertOk();
    // `viewEmail` stays: the e-mail prop is decided eagerly in the controller (it is no projection) — every request pays it.
    expect(asked).toEqual(['profile.viewEmail']);
    asked = [];
    const page = (await app.actingAs(alan).reloading<ShowUserProfileController>('user-profile/Show', { only: ['abilities'] }).get(profile(ada)).assertOk()).page()!;
    expect(page.props).toEqual({ abilities: { update: false }, errors: {} });
    expect(asked.sort()).toEqual(['profile.update', 'profile.viewEmail']);
  });

  it('a forged client still gets 403 — the projection is the UI’s hint, the server checks every action', async () => {
    const [theirs] = linksOf((await app.actingAs(alan).navigating().get(profile(ada)).assertOk()).page()!.props);
    expect(theirs!.can.delete).toBe(false);
    // The devtools flip `can.delete` to true, or a script sends the request without the UI: refused all the same.
    await app.actingAs(alan).acting().delete(`${profile(ada)}/links/${theirs!.id}`).assertForbidden();
    await app.actingAs(alan).expectingJson().put(profile(ada), { json: { name: 'Mallory', bio: '' } }).assertForbidden();
    await app.actingAs(alan).navigating().get(`${profile(ada)}/edit`).assertForbidden();
    await app.assertDatabaseHas('profile_links', { id: theirs!.id });
  });

  it('refreshes with the data it is about: a link added and the profile reloaded brings the new link’s `can`', async () => {
    await app.actingAs(ada).acting().post(`${profile(ada)}/links`, { json: { label: 'Blog', url: 'https://blog.example' } }).assertActionRedirect(profile(ada));
    asked = [];
    // What the action's `reload: router.reloading({ only: ['profile'] })` asks — the abilities live inside the prop.
    const page = (await app.actingAs(ada).reloading<ShowUserProfileController>('user-profile/Show', { only: ['profile'] }).get(profile(ada)).assertOk()).page()!;
    expect(linksOf(page.props).find((link) => link.label === 'Blog')?.can).toEqual({ delete: true });
    expect(asked.filter((name) => name === 'link.delete')).toHaveLength(3);
    // The page-level `abilities` is a prop of its own: not sent unless named (it does not depend on the links).
    expect(page.props).not.toHaveProperty('abilities');
  });

  it('a layer projects its own: the edit layer’s links carry `can.delete`', async () => {
    await app
      .actingAs(ada)
      .navigating()
      .get(`${profile(ada)}/edit`)
      .assertPage<EditUserProfileController>('user-profile/Edit', (props) => expect(props.profile.links.map((link) => link.can)).toEqual([{ delete: true }, { delete: true }]));
  });

  it('an island projects its own: “Edit profile” only next to your own sign-in', async () => {
    const activity = app.make(LoginActivityRepository);
    await activity.record(ada.id, new Date(Date.now() - 60_000));
    await activity.record(alan.id, new Date(Date.now() - 120_000));
    for (const [user, other] of [
      [ada, alan],
      [alan, ada],
    ] as const) {
      await app
        .actingAs(user)
        .island('dashboard.sign-ins', {}, { range: 'all' })
        .assertIsland<ShowRecentSignInsController>('dashboard/RecentSignIns', (props) => {
          const can = Object.fromEntries(props.entries.map((entry) => [entry.publicId, entry.can.update]));
          expect(can).toEqual({ [user.public_id]: true, [other.public_id]: false });
        });
    }
  });
});
