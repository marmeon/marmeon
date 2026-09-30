import { UserFactory, UserRepository, type User } from '#modules/auth';
import { Connections } from '@bespokecore/database';
import { useForm } from '@bespokecore/react';
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { EditUserProfileController } from './controllers/EditUserProfileController.ts';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';
import type { UpdateUserProfileController } from './controllers/UpdateUserProfileController.ts';
import { ProfileLinkFactory } from './factories/ProfileLinkFactory.ts';
import { ProfileDirectory } from './ProfileDirectory.ts';

let app: TestApp;
let ada: User, alan: User, grace: User;
beforeEach(async () => {
  // A fresh app per test, on a real database: migrated once per worker, seeded and rolled back per test.
  app = await createTestApp(application, { database: 'refresh', seed: true });
  // The seeded demo users. Never assume ids: Postgres does not roll back its sequences.
  [ada, alan, grace] = (await app.make(UserRepository).query().selectAll().orderBy('id').execute()) as [User, User, User];
});

/** Signed in as `user`, navigating client-side (answers with the page object). */
const as = (user: User) => app.withSession({ user_id: user.id }).navigating();
const profile = (user: User) => `/users/${user.id}`;

describe('user-profile module', () => {
  it('returns 401 to non-browser clients without a session', async () => {
    await app.expectingJson().get(profile(ada)).assertUnauthorized().assertJson({ message: 'Unauthenticated.' });
  });

  it('redirects browsers without a session to the login page', async () => {
    await app.get(profile(ada), { headers: { accept: 'text/html' } }).assertRedirect('/login');
  });

  it('renders the profile with controller-owned props', async () => {
    await as(ada)
      .get(profile(ada))
      .assertOk()
      .assertHeader('x-bespoke', 'true')
      .assertPage<ShowUserProfileController>('user-profile/Show', {
        profile: { name: 'Ada Lovelace' },
        email: 'ada@example.com',
        isOwnProfile: true,
        lastLoginAt: null,
      });
  });

  it("hides another user's e-mail", async () => {
    await as(ada).get(profile(alan)).assertPage<ShowUserProfileController>('user-profile/Show', { email: null, isOwnProfile: false });
  });

  it('carries the page object in full page loads too', async () => {
    await app.withSession({ user_id: ada.id }).get(profile(ada)).assertOk().assertPage('user-profile/Show');
  });

  it('filters the other people by name from the query string', async () => {
    await as(ada)
      .get(`${profile(ada)}?q=  TUR `)
      .assertPage<ShowUserProfileController>('user-profile/Show', {
        filter: 'TUR',
        others: { data: [{ id: alan.id, name: 'Alan Turing', lastLoginAt: null }], meta: { total: 1, lastPage: 1 } },
      });
    await as(ada).get(profile(ada)).assertPage<ShowUserProfileController>('user-profile/Show', (props) => {
      expect(props.others.data.map((other) => other.name)).toEqual(['Alan Turing', 'Grace Hopper']);
    });
    // LIKE wildcards in the search are taken literally
    await as(ada).get(`${profile(ada)}?q=%25`).assertPage<ShowUserProfileController>('user-profile/Show', { others: { data: [] } });
  });

  it('pages through the people — five at a time, the filter kept, bad page numbers harmless', async () => {
    await app.factory(UserFactory).count(11).create(); // "User 1" … "User 11", plus Alan and Grace
    await as(ada).get(`${profile(ada)}?q=user&page=2`).assertPage<ShowUserProfileController>('user-profile/Show', (props) => {
      expect(props.others.meta).toEqual({ page: 2, perPage: 5, total: 11, lastPage: 3, from: 6, to: 10 });
      expect(props.others.data).toHaveLength(5);
    });
    await as(ada).get(`${profile(ada)}?page=-3&per_page=100000`).assertPage<ShowUserProfileController>('user-profile/Show', (props) => {
      expect(props.others.meta).toMatchObject({ page: 1, perPage: 50, total: 13 });
    });
  });

  it('serves a stateless API under /api — no session, no cookies', async () => {
    const response = await app.get('/api/users').assertOk().assertCookieMissing('bespoke_session');
    expect(response.json()).toEqual({ data: expect.arrayContaining([{ id: ada.id, name: 'Ada Lovelace' }]) });
  });

  it('sends security headers on every response — global middleware, even for unknown paths', async () => {
    for (const path of ['/login', '/api/users', '/nope']) {
      await app.get(path).assertHeader('x-content-type-options', 'nosniff').assertHeader('x-frame-options', 'DENY');
    }
  });

  describe('updating the profile (UpdateUserProfileRequest)', () => {
    it('saves valid, trimmed input and flashes a status', async () => {
      await app
        .withSession({ user_id: ada.id })
        .put(profile(ada), { json: { name: '  Ada King ', bio: 'Countess.' } })
        .assertRedirect(profile(ada))
        .assertValid()
        .assertSessionHas('status', 'Profile saved.');
      await app.assertDatabaseHas('users', { id: ada.id, name: 'Ada King', bio: 'Countess.' });
    });

    it('answers API clients with 422 and the field errors', async () => {
      const response = await app
        .withSession({ user_id: ada.id })
        .expectingJson()
        .put(profile(ada), { json: { name: 'A', bio: 'x'.repeat(201) } })
        .assertUnprocessable()
        .assertInvalid<UpdateUserProfileController>({ name: /at least 2/, bio: 'The bio may have at most 200 characters.' });
      expect(response.json()).toMatchObject({ message: 'The name needs at least 2 characters. (and 1 more error)' });
    });

    it('sends pages back with the errors and the old input in the session', async () => {
      await app
        .withSession({ user_id: ada.id })
        .put(profile(ada), { form: { name: 'A', bio: 'ok', _token: 'never flashed' }, headers: { referer: `http://localhost${profile(ada)}/edit` } })
        .assertRedirect(`${profile(ada)}/edit`)
        .assertInvalid<UpdateUserProfileController>(['name'])
        .assertSessionHas('_old_input', { name: 'A', bio: 'ok' });
    });

    it('forbids editing someone else (403 before validation)', async () => {
      await app.withSession({ user_id: alan.id }).expectingJson().put(profile(ada), { json: {} }).assertForbidden();
      await app.assertDatabaseHas('users', { id: ada.id, name: 'Ada Lovelace' });
    });
  });

  describe('shared props', () => {
    it('gives every page the signed-in user, flash messages and validation errors', async () => {
      await as(alan).get(profile(ada)).assertPage<ShowUserProfileController>('user-profile/Show', {
        auth: { user: { id: alan.id, name: 'Alan Turing' } },
        flash: { status: null },
        errors: {},
      });
      await app.navigating().get('/login').assertPage('auth/Login', { auth: { user: null } });
    });

    it('evaluates lazy props only when a page renders — never for redirects or JSON', async () => {
      let lookups = 0;
      class CountingUsers extends UserRepository {
        override find(id: number) {
          lookups++;
          return super.find(id);
        }
      }
      await app.close(); // one database app per test
      const counted = await createTestApp(application, { database: 'refresh', override: (c) => c.singleton(UserRepository, CountingUsers) });
      const user = await counted.factory(UserFactory).create();
      await counted.withSession({ user_id: user.id }).get('/users/me').assertRedirect(`/users/${user.id}`);
      expect(lookups).toBe(1); // Authenticate only — the shared `auth` prop was not evaluated

      lookups = 0;
      await counted.withSession({ user_id: user.id }).navigating().get(`/users/${user.id}`).assertOk();
      expect(lookups).toBe(2); // Authenticate, and now the shared `auth` prop (the profile comes from the ProfileDirectory)
    });
  });

  describe('the edit page', () => {
    it('shows your own profile for editing — and nobody else\'s', async () => {
      await as(ada).get(`${profile(ada)}/edit`).assertOk().assertPage<EditUserProfileController>('user-profile/Edit', {
        profile: { name: 'Ada Lovelace' },
        errors: {},
      });
      await as(alan).get(`${profile(ada)}/edit`).assertForbidden();
    });

    it('a failed client-side visit comes back to the form with errors and old input (no 422)', async () => {
      const response = await as(ada)
        .put(profile(ada), { json: { name: 'A', bio: 'ok' }, headers: { referer: `http://localhost${profile(ada)}/edit` } })
        .assertStatus(303)
        .assertRedirect(`${profile(ada)}/edit`);

      await app
        .withCookie('bespoke_session', response.cookie('bespoke_session')!)
        .navigating()
        .get(`${profile(ada)}/edit`)
        .assertPage<EditUserProfileController>('user-profile/Edit', {
          errors: { name: ['The name needs at least 2 characters.'] },
          old: { name: 'A', bio: 'ok' },
        });
    });

    it('a successful save lands on the profile with a status message', async () => {
      const response = await as(ada).put(profile(ada), { json: { name: 'Ada', bio: 'Math.' } }).assertRedirect(profile(ada));
      await app
        .withCookie('bespoke_session', response.cookie('bespoke_session')!)
        .navigating()
        .get(profile(ada))
        .assertPage<ShowUserProfileController>('user-profile/Show', { flash: { status: 'Profile saved.' }, profile: { bio: 'Math.' } });
    });
  });

  it('sends open tabs of an older build a 409 with the URL to reload (ASSET_VERSION)', async () => {
    await app.close(); // one database app per test
    const deployed = await createTestApp(application, { database: 'refresh', env: { ASSET_VERSION: 'build-2' } });
    const user = await deployed.factory(UserFactory).create();
    await deployed
      .withSession({ user_id: user.id })
      .navigating()
      .withHeaders({ 'x-bespoke-version': 'build-1' })
      .get(`/users/${user.id}`)
      .assertStatus(409)
      .assertHeader('x-bespoke-location', `http://localhost/users/${user.id}`);
    await deployed.withSession({ user_id: user.id }).navigating().get(`/users/${user.id}`).assertOk();
  });

  it('redirects /users/me to the current user', async () => {
    await as(alan).get('/users/me').assertRedirect(profile(alan));
  });

  it('answers unknown users with the error page (navigation) or JSON (API)', async () => {
    // Route binding: a missing record never reaches the controller.
    await as(ada).get('/users/999999').assertNotFound().assertPage('errors/Error', { message: 'Not Found' });
    await app.withSession({ user_id: ada.id }).expectingJson().get('/users/abc').assertNotFound().assertExactJson({ message: 'Not Found' });
    await app.withSession({ user_id: ada.id }).expectingJson().get('/users/999999/edit').assertNotFound();
  });

  it('lets tests replace services before the app boots — singletons included', async () => {
    const stub: User = { id: 7, name: 'Grace (stub)', email: 'grace@example.com', bio: 'from a test double', created_at: '', updated_at: '' };
    class StubUserRepository extends UserRepository {
      override async find(id: number) {
        return id === stub.id ? stub : undefined;
      }
      override async list() {
        return [{ id: stub.id, name: stub.name }];
      }
    }
    await app.close(); // one database app per test
    const stubbed = await createTestApp(application, {
      database: 'refresh', // the profile also reads login_activity
      override: (c) => c.singleton(UserRepository, (r) => new StubUserRepository(r.make(Connections))),
    });
    // Authenticate asks the repository: the stub's user is signed in, although no row exists.
    await stubbed.withSession({ user_id: 7 }).get('/users/me').assertRedirect('/users/7');
    await stubbed.withSession({ user_id: 7 }).navigating().get('/login').assertPage('auth/Login', { auth: { user: { id: 7, name: 'Grace (stub)' } } });
  });

  it('boots modules and discovered packages through their providers', () => {
    expect(app.application.modules.map((module) => module.name)).toEqual(['auth', 'user-profile']);
    expect(app.application.packages).toEqual(expect.arrayContaining(['@bespokecore/http', '@bespokecore/log', '@bespokecore/session']));
    expect(app.make(UserRepository)).toBe(app.make(UserRepository)); // singleton
  });

  it('loads the people with their last sign-in eagerly — the queries do not grow with the people (no N+1)', async () => {
    await app.factory(UserFactory).count(5).create();
    await app.post('/login', { form: { user_id: String(grace.id) } }).assertRedirect('/users/me');
    const directory = app.make(ProfileDirectory);
    await directory.people({ except: ada.id }); // the first relation query of a connection looks up its column types, once
    const queries: string[] = [];
    app.make(Connections).onQuery((query) => queries.push(query.sql));

    const people = await directory.people({ except: ada.id, perPage: 50 });
    // 7 people, each with their last sign-in: the page count, and ONE query for the rows and their relation.
    expect(queries).toHaveLength(2);
    expect(queries.filter((sql) => /login_activity/.test(sql))).toHaveLength(1);
    expect(people.data).toHaveLength(7);
    expect(people.data.find((person) => person.id === grace.id)?.activity).toEqual({ last_login_at: expect.stringMatching(/Z$/) });
    expect(people.data.find((person) => person.id === alan.id)?.activity).toBeNull();
  });

  it('shows when a user last signed in — via the UserLoggedIn event from the auth module', async () => {
    await app.post('/login', { form: { user_id: String(alan.id) } }).assertRedirect('/users/me');
    await app.assertDatabaseHas('login_activity', { user_id: alan.id });

    await as(ada).get(profile(alan)).assertPage<ShowUserProfileController>('user-profile/Show', (props) => {
      expect(props.lastLoginAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
    await as(ada).get(profile(grace)).assertPage<ShowUserProfileController>('user-profile/Show', { lastLoginAt: null });
  });
});

describe('profile links (a route bound within its user)', () => {
  it('shows the links on the profile — loaded with it, in one query', async () => {
    await as(alan)
      .get(profile(ada))
      .assertPage<ShowUserProfileController>('user-profile/Show', (props) => {
        expect(props.profile.links.map((link) => link.label)).toEqual(['Notes on the Analytical Engine', 'Ada (language)']);
      });
  });

  it('adds a link to your own profile — http(s) only', async () => {
    await as(ada)
      .post(`${profile(ada)}/links`, { json: { label: ' Blog ', url: 'https://ada.example' } })
      .assertRedirect(profile(ada))
      .assertSessionHas('status', 'Link added.');
    await app.assertDatabaseHas('profile_links', { user_id: ada.id, label: 'Blog', url: 'https://ada.example' });

    await app
      .withSession({ user_id: ada.id })
      .expectingJson()
      .post(`${profile(ada)}/links`, { json: { label: 'x', url: 'javascript:alert(1)' } })
      .assertInvalid(['url']);
    await app.withSession({ user_id: alan.id }).expectingJson().post(`${profile(ada)}/links`, { json: { label: 'x', url: 'https://x.example' } }).assertForbidden();
  });

  it('removes your own link', async () => {
    const link = await app.factory(ProfileLinkFactory).create({ user_id: alan.id });
    await as(alan).delete(`${profile(alan)}/links/${link.id}`).assertRedirect(profile(alan)).assertSessionHas('status', 'Link removed.');
    await app.assertDatabaseMissing('profile_links', { id: link.id });
  });

  it('refuses another user’s link through your own URL: 404, not deleted (IDOR)', async () => {
    const adasLink = await app.factory(ProfileLinkFactory).create({ user_id: ada.id });
    // Alan owns /users/<alan>, but the link belongs to Ada — the scoped binding does not find it there.
    await app.withSession({ user_id: alan.id }).expectingJson().delete(`${profile(alan)}/links/${adasLink.id}`).assertNotFound();
    // Through Ada's URL it is found — and refused, it is not Alan's profile.
    await app.withSession({ user_id: alan.id }).expectingJson().delete(`${profile(ada)}/links/${adasLink.id}`).assertForbidden();
    await app.assertDatabaseHas('profile_links', { id: adasLink.id });
  });
});

// Never called: only the types matter.
export async function typeLevelTests(): Promise<void> {
  const app = await createTestApp(application);
  // @ts-expect-error — `nmae` is not a field of UpdateUserProfileRequest.
  await app.put('/users/1').assertInvalid<UpdateUserProfileController>(['nmae']);
  // @ts-expect-error — neither is `email` (the form has name and bio).
  await app.put('/users/1').assertInvalid<UpdateUserProfileController>({ email: 'x' });
  // Nested paths of known fields and untyped checks are fine:
  await app.put('/users/1').assertInvalid<UpdateUserProfileController>(['name.first']);
  await app.put('/users/1').assertInvalid(['anything']);
}

// Never rendered: only the types of useForm matter.
export function TypedForm() {
  const form = useForm<UpdateUserProfileController>({ name: 'Ada', bio: '' });
  form.set('name', 'Ada King');
  // @ts-expect-error — `nmae` is not a field of the request schema.
  form.set('nmae', 'x');
  // @ts-expect-error — `bio` is a string.
  form.set('bio', 1);
  // @ts-expect-error — `bio` is required by the schema.
  useForm<UpdateUserProfileController>({ name: 'Ada' });
  const nameError: string | undefined = form.errors.name;
  // @ts-expect-error — the schema has no `email`, so there is no such error either.
  void form.errors.email;
  return nameError;
}

// Never called: PageProps are serialized — the controller's Date is a string in the view.
export function serializedProps(props: import('@bespokecore/http').PageProps<ShowUserProfileController>) {
  const now: string = props.now;
  // @ts-expect-error — not a Date any more once it crossed the wire
  props.now.getTime();
  return now;
}

// Never called: the database's page meta and the one browser code knows describe the same shape.
export function pageMetaShapes(meta: import('@bespokecore/database').PageMeta): import('@bespokecore/http/page').PaginationMeta {
  expectTypeOf<import('@bespokecore/database').PageMeta>().toEqualTypeOf<import('@bespokecore/http/page').PaginationMeta>();
  return meta;
}
