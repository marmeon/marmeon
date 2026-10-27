import { UserFactory, UserRepository, type User } from '#modules/auth';
import { Connections } from '@marmeon/database';
import { PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { useForm } from '@marmeon/react';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { EditUserProfileController } from './controllers/EditUserProfileController.ts';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';
import type { UpdateUserProfileController } from './controllers/UpdateUserProfileController.ts';
import { ProfileLinkFactory } from './factories/ProfileLinkFactory.ts';
import { ProfileDirectory } from './ProfileDirectory.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

let app: TestApp;
let ada: User, alan: User, grace: User;
beforeEach(async () => {
  // A fresh app per test, on a real database: migrated once per worker, seeded and rolled back per test.
  app = await createTestApp(application, { database: 'refresh', seed: true });
  // The seeded demo users. Never assume ids: Postgres does not roll back its sequences.
  const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada, alan, grace] = users as [User, User, User];
});

/** Signed in as `user`, navigating client-side (answers with the page object). */
const as = (user: User) => app.actingAs(user).navigating();
const profile = (user: User) => `/users/${user.public_id}`;

/** The paths of every `id` / `user_id` holding an integer in `value` (the shared `auth` props are not looked at). */
function integerKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => integerKeys(item, `${path}[${index}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) =>
    path === '' && key === 'auth' ? [] : (key === 'id' || key === 'user_id') && typeof item === 'number' ? [`${path}.${key}`] : integerKeys(item, `${path}.${key}`),
  );
}

describe('user-profile module', () => {
  it('returns 401 to non-browser clients without a session', async () => {
    await app.expectingJson().get(profile(ada)).assertUnauthorized().assertJson({ message: 'Unauthenticated.' });
  });

  it('redirects browsers without a session to the login page', async () => {
    await app.get(profile(ada), { headers: { accept: 'text/html' } }).assertRedirect('/login');
  });

  it('never hands out a password hash — not on pages, not in the API (the profile reads users.*)', async () => {
    const pages = [
      await as(ada).get(profile(ada)).assertOk(),
      await as(ada).get(profile(alan)).assertOk(),
      await as(ada).get(`${profile(ada)}/edit`).assertOk(),
      await app.actingAs(ada).get(profile(ada), { headers: { accept: 'text/html' } }).assertOk(), // the HTML document
      await app.actingAs(ada, { guard: 'api', abilities: ['users:read'] }).get('/api/users').assertOk(),
    ];
    for (const response of pages) {
      expect(response.body).not.toContain('$argon2id$');
      expect(response.body).not.toContain('"password"');
    }
  });

  it('keeps the integer id off the pages: the profile, the edit layer and the people list are addressed by the public id', async () => {
    const pages = [
      await as(ada).get(profile(ada)).assertOk(),
      await as(ada).get(`${profile(ada)}/edit`).assertOk(),
      await as(ada).get('/people').assertOk(),
    ];
    for (const response of pages) expect(integerKeys(response.page()!.props)).toEqual([]);
  });

  it('renders the profile with controller-owned props', async () => {
    await as(ada)
      .get(profile(ada))
      .assertOk()
      .assertHeader('x-marmeon', PROTOCOL_VERSION)
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

  it("sends another user's page only the fields it shows — never the rest of the row", async () => {
    // A change of address waiting for its link: kept in `email_changes`, which no module exposes.
    await app.make(Connections).get<any>().insertInto('email_changes').values({ user_id: alan.id, email: 'new-alan@example.com', token_hash: 'a'.repeat(64), session_key: null, expires_at: new Date(Date.now() + 3_600_000), created_at: new Date() }).execute();
    const props = (await as(ada).get(profile(alan)).assertOk()).page()!.props as { profile: Record<string, unknown> };
    expect(Object.keys(props.profile).sort()).toEqual(['avatar', 'bio', 'created_at', 'links', 'name', 'public_id']);
    for (const field of ['pending_email', 'locale', 'email_verified_at', 'first_verified_at']) {
      expect(props.profile).not.toHaveProperty(field);
    }
    expect(JSON.stringify(props)).not.toContain('new-alan@example.com');
  });

  it('carries the page object in full page loads too', async () => {
    await app.actingAs(ada).get(profile(ada)).assertOk().assertPage('user-profile/Show');
  });

  it('serves a stateless API under /api — a token, no session, no cookies', async () => {
    const response = await app.actingAs(ada, { guard: 'api', abilities: ['users:read'] }).get('/api/users?per_page=50').assertOk().assertCookieMissing('marmeon_session');
    expect(response.json()).toEqual({
      data: [
        { id: ada.id, name: 'Ada Lovelace' },
        { id: alan.id, name: 'Alan Turing' },
        { id: grace.id, name: 'Grace Hopper' },
      ],
      meta: { page: 1, perPage: 50, total: 3, lastPage: 1, from: 1, to: 3 },
    });
    // The page as its query schema parses it (pageQuery): a size it does not offer is the default, a page past the last is empty.
    const other = await app.actingAs(ada, { guard: 'api', abilities: ['users:read'] }).get('/api/users?per_page=2&page=2').assertOk();
    expect(other.json()).toEqual({ data: [], meta: { page: 2, perPage: 25, total: 3, lastPage: 1, from: null, to: null } });
  });

  it('sends security headers on every response — global middleware, even for unknown paths', async () => {
    for (const path of ['/login', '/api/users', '/nope']) {
      await app.get(path).assertHeader('x-content-type-options', 'nosniff').assertHeader('x-frame-options', 'DENY');
    }
  });

  describe('updating the profile (UpdateUserProfileRequest)', () => {
    it('saves valid, trimmed input and flashes a status', async () => {
      await app
        .actingAs(ada)
        .put(profile(ada), { json: { name: '  Ada King ', bio: 'Countess.' } })
        .assertRedirect(profile(ada))
        .assertValid()
        .assertFlashed('toast', { message: 'Profile saved.' });
      await app.assertDatabaseHas('users', { id: ada.id, name: 'Ada King', bio: 'Countess.' });
    });

    it("clears the bio on purpose — '' is a value, not a missing field; a request without a bio keeps it", async () => {
      await app.actingAs(ada).put(profile(ada), { json: { name: 'Ada King', bio: 'Countess.' } }).assertRedirect(profile(ada));
      // JSON: the bio cleared, as a page builder or an API client sends it.
      await app.actingAs(ada).put(profile(ada), { json: { name: 'Ada King', bio: '' } }).assertRedirect(profile(ada)).assertValid();
      await app.assertDatabaseHas('users', { id: ada.id, bio: '' });
      // A form: the textarea emptied.
      await app.actingAs(ada).put(profile(ada), { json: { name: 'Ada King', bio: 'Countess.' } }).assertRedirect(profile(ada));
      await app.actingAs(ada).put(profile(ada), { form: { name: 'Ada King', bio: '' } }).assertRedirect(profile(ada)).assertValid();
      await app.assertDatabaseHas('users', { id: ada.id, bio: '' });
      // Left out: the name changes, the bio stays.
      await app.actingAs(ada).put(profile(ada), { json: { name: 'Ada King', bio: 'Countess.' } }).assertRedirect(profile(ada));
      await app.actingAs(ada).put(profile(ada), { json: { name: 'Ada Byron' } }).assertRedirect(profile(ada)).assertValid();
      await app.assertDatabaseHas('users', { id: ada.id, name: 'Ada Byron', bio: 'Countess.' });
    });

    it('answers API clients with 422 and the field errors', async () => {
      const response = await app
        .actingAs(ada)
        .expectingJson()
        .put(profile(ada), { json: { name: 'A', bio: 'x'.repeat(201) } })
        .assertUnprocessable()
        .assertInvalid<UpdateUserProfileController>({ name: /at least 2/, bio: 'The bio may have at most 200 characters.' });
      expect(response.json()).toMatchObject({ message: 'The name needs at least 2 characters. (and 1 more error)' });
    });

    it('sends pages back with the errors and the old input in the session', async () => {
      await app
        .actingAs(ada)
        .put(profile(ada), { form: { name: 'A', bio: 'ok', _token: 'never flashed' }, headers: { referer: `http://localhost${profile(ada)}/edit` } })
        .assertRedirect(`${profile(ada)}/edit`)
        .assertInvalid<UpdateUserProfileController>(['name'])
        .assertSessionHas('_old_input', { name: 'A', bio: 'ok' });
    });

    it('fields in the query string of a PUT change nothing — only the body is validated', async () => {
      await app.actingAs(ada).expectingJson().put(`${profile(ada)}?name=Mallory`, { json: { bio: 'Countess.' } }).assertUnprocessable().assertInvalid<UpdateUserProfileController>(['name']);
      await app.actingAs(ada).put(`${profile(ada)}?name=Mallory&bio=pwned`, { json: { name: 'Ada King', bio: 'Countess.' } }).assertRedirect(profile(ada));
      await app.assertDatabaseHas('users', { id: ada.id, name: 'Ada King', bio: 'Countess.' });
    });

    it('forbids editing someone else (403 before validation)', async () => {
      await app.actingAs(alan).expectingJson().put(profile(ada), { json: {} }).assertForbidden();
      await app.assertDatabaseHas('users', { id: ada.id, name: 'Ada Lovelace' });
    });
  });

  describe('shared props', () => {
    it('gives every page the signed-in user and validation errors — flash messages are no prop', async () => {
      const page = await as(alan).get(profile(ada)).assertPage<ShowUserProfileController>('user-profile/Show', {
        auth: { user: { name: 'Alan Turing' } },
        errors: {},
      });
      expect((page.page()!.props as { auth: { user: object } }).auth.user).not.toHaveProperty('id');
      expect(page.page()!.props).not.toHaveProperty('flash');
      page.assertNoFlash();
      await app.navigating().get('/login').assertPage('auth/Login', { auth: { user: null } });
    });

    it('evaluates lazy props only when a page renders — never for redirects or JSON', async () => {
      let lookups = 0;
      class CountingUsers extends UserRepository {
        override findById(id: number) {
          lookups++;
          return super.findById(id);
        }
      }
      await app.close(); // one database app per test
      const counted = await createTestApp(application, { database: 'refresh', override: (c) => c.singleton(UserRepository, CountingUsers) });
      const user = await counted.factory(UserFactory).create();
      await counted.actingAs(user).get('/users/me').assertRedirect(`/users/${user.public_id}`);
      expect(lookups).toBe(2); // actingAs() fingerprints the user, then authenticate() — the shared `auth` prop was not evaluated

      lookups = 0;
      await counted.actingAs(user).navigating().get(`/users/${user.public_id}`).assertOk();
      // actingAs(), then authenticate() — and the shared `auth` prop asks the same per-request Auth: no second lookup.
      expect(lookups).toBe(2);
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
        .withCookie('marmeon_session', response.cookie('marmeon_session')!)
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
        .withCookie('marmeon_session', response.cookie('marmeon_session')!)
        .navigating()
        .get(profile(ada))
        .assertPage<ShowUserProfileController>('user-profile/Show', { profile: { bio: 'Math.' } })
        .assertFlash('toast', { kind: 'success', message: 'Profile saved.' });
    });
  });

  it('sends open tabs of an older build a 409 with the URL to reload (SERVER_ASSET_VERSION)', async () => {
    await app.close(); // one database app per test
    const deployed = await createTestApp(application, { database: 'refresh', env: { SERVER_ASSET_VERSION: 'build-2' } });
    const user = await deployed.factory(UserFactory).create();
    await deployed
      .actingAs(user)
      .navigating()
      .withHeaders({ 'x-marmeon-version': 'build-1' })
      .get(`/users/${user.public_id}`)
      .assertStatus(409)
      .assertHeader('x-marmeon-location', `/users/${user.public_id}`);
    await deployed.actingAs(user).navigating().get(`/users/${user.public_id}`).assertOk();
  });

  it('redirects /users/me to the current user', async () => {
    await as(alan).get('/users/me').assertRedirect(profile(alan));
  });

  it('answers unknown users with the error page (navigation) or JSON (API)', async () => {
    // Route binding: a missing record never reaches the controller.
    await as(ada).get('/users/999999').assertNotFound().assertPage('errors/Error', { message: 'Not Found' });
    await app.actingAs(ada).expectingJson().get('/users/abc').assertNotFound().assertExactJson({ message: 'Not Found' });
    await app.actingAs(ada).expectingJson().get('/users/999999/edit').assertNotFound();
  });

  it('binds /users/:user by the public UUID — the integer id finds nobody, a UUID in capitals does', async () => {
    await as(ada).get(`/users/${ada.id}`).assertNotFound();
    await app.actingAs(ada).expectingJson().get(`/users/${ada.id}/edit`).assertNotFound();
    await as(ada).get(`/users/${ada.public_id}`).assertOk();
    await as(ada).get(`/users/${ada.public_id.toUpperCase()}`).assertOk();
    await as(ada).get(`/users/${crypto.randomUUID()}`).assertNotFound();
    await app.actingAs(ada).expectingJson().get(`/users/${ada.public_id}/edit`).assertOk();
  });

  it('lets tests replace services before the app boots — singletons included', async () => {
    const stub: User = { id: 7, public_id: '0190a000-0000-7000-8000-000000000007', name: 'Grace (stub)', email: 'grace@example.com', bio: 'from a test double', created_at: '', updated_at: '', email_verified_at: '2026-10-01T00:00:00.000Z', first_verified_at: '2026-10-01T00:00:00.000Z', locale: null, avatar_path: null };
    class StubUserRepository extends UserRepository {
      override async findById(id: number) {
        return id === stub.id ? { user: stub, passwordHash: null, sessionKey: null } : undefined;
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
    // The sign-in list's row needs a users row for its foreign key; its name and e-mail differ from the stub's.
    await stubbed.factory(UserFactory).create({ id: stub.id, name: 'Grace (row)', email: 'grace-row@example.com' });
    // Authentication asks the repository (it is the UserProvider): the stub's user is signed in, not the row.
    await stubbed.actingAs(stub).get('/users/me').assertRedirect(`/users/${stub.public_id}`);
    await stubbed.actingAs(stub).navigating().get('/users/999999').assertNotFound().assertPage('errors/Error', { auth: { user: { name: 'Grace (stub)' } } });
  });

  it('boots modules and discovered packages through their providers', () => {
    expect(app.application.modules.map((module) => module.name)).toEqual(['about', 'auth', 'user-profile', 'dashboard', 'members', 'notifications', 'locale', 'lab', 'system', 'bookmarks', 'webhooks']);
    expect(app.application.packages).toEqual(expect.arrayContaining(['@marmeon/http', '@marmeon/log', '@marmeon/session', '@marmeon/redis', '@marmeon/table']));
    expect(app.make(UserRepository)).toBe(app.make(UserRepository)); // singleton
  });

  it('loads the people with their last sign-in eagerly — the queries do not grow with the people (no N+1)', async () => {
    await app.factory(UserFactory).count(5).create();
    await app.post('/login', { form: { email: grace.email, password: 'password' } }).assertRedirect('/users/me');
    const directory = app.make(ProfileDirectory);
    const queries: string[] = [];
    app.make(Connections).onQuery((query) => queries.push(query.sql));

    const people = await directory.people({ q: '', sort: 'name', per_page: 50 });
    // 8 people, each with their last sign-in: ONE query for the rows and their relation, and one that counts (without it).
    expect(queries).toHaveLength(2);
    expect(queries.filter((sql) => /login_activity/.test(sql))).toHaveLength(1);
    expect(people.data).toHaveLength(8);
    expect(people.data.find((person) => person.id === grace.id)?.activity).toEqual({ last_login_at: expect.stringMatching(/Z$/) });
    expect(people.data.find((person) => person.id === alan.id)?.activity).toBeNull();
  });

  it('shows when a user last signed in — via the SignedIn event of @marmeon/auth', async () => {
    await app.post('/login', { form: { email: alan.email, password: 'password' } }).assertRedirect('/users/me');
    await app.assertDatabaseHas('login_activity', { user_id: alan.id });

    await as(ada).get(profile(alan)).assertPage<ShowUserProfileController>('user-profile/Show', (props) => {
      expect(props.lastLoginAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
    await as(ada).get(profile(grace)).assertPage<ShowUserProfileController>('user-profile/Show', { lastLoginAt: null });
  });
});

describe('policies (ProfilePolicy, ProfileLinkPolicy)', () => {
  it('tell the page what it may offer — an explicit `abilities` projection, and the e-mail only to its owner', async () => {
    await as(ada).get(profile(ada)).assertPage<ShowUserProfileController>('user-profile/Show', { abilities: { update: true }, email: 'ada@example.com' });
    await as(ada).get(profile(alan)).assertPage<ShowUserProfileController>('user-profile/Show', { abilities: { update: false }, email: null });
  });

  it('refuse with the policy’s reason — at the request (can) and in code (Gate)', async () => {
    await app.actingAs(alan).expectingJson().put(profile(ada), { json: { name: 'Mallory', bio: '' } }).assertForbidden().assertExactJson({
      message: 'You can only change your own profile.',
    });
    await app.actingAs(alan).expectingJson().get(`${profile(ada)}/edit`).assertForbidden().assertExactJson({ message: 'You can only change your own profile.' });
    await app.assertDatabaseHas('users', { id: ada.id, name: 'Ada Lovelace' });
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

  it('keys links by UUIDv7 — a link id that is no UUID is a 404', async () => {
    await as(alan)
      .get(profile(ada))
      .assertPage<ShowUserProfileController>('user-profile/Show', (props) => {
        for (const link of props.profile.links) expect(link.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      });
    await as(ada).get(`${profile(ada)}/links/1/remove`).assertNotFound();
    await as(ada).get(`${profile(ada)}/links/not-a-uuid/remove`).assertNotFound();
  });

  it('adds a link to your own profile — http(s) only', async () => {
    await as(ada)
      .post(`${profile(ada)}/links`, { json: { label: ' Blog ', url: 'https://ada.example' } })
      .assertRedirect(profile(ada))
      .assertFlashed('toast', { message: 'Link added.' });
    await app.assertDatabaseHas('profile_links', { user_id: ada.id, label: 'Blog', url: 'https://ada.example' });

    await app
      .actingAs(ada)
      .expectingJson()
      .post(`${profile(ada)}/links`, { json: { label: 'x', url: 'javascript:alert(1)' } })
      .assertInvalid(['url']);
    await app.actingAs(alan).expectingJson().post(`${profile(ada)}/links`, { json: { label: 'x', url: 'https://x.example' } }).assertForbidden();
  });

  it('removes your own link', async () => {
    const link = await app.factory(ProfileLinkFactory).create({ user_id: alan.id });
    await as(alan).delete(`${profile(alan)}/links/${link.id}`).assertRedirect(profile(alan)).assertFlashed('toast', { message: 'Link removed.' });
    await app.assertDatabaseMissing('profile_links', { id: link.id });
  });

  it('refuses another user’s link through your own URL: 404, not deleted (IDOR)', async () => {
    const adasLink = await app.factory(ProfileLinkFactory).create({ user_id: ada.id });
    // Alan owns /users/<alan>, but the link belongs to Ada — the scoped binding does not find it there.
    await app.actingAs(alan).expectingJson().delete(`${profile(alan)}/links/${adasLink.id}`).assertNotFound();
    // Through Ada's URL it is found — and refused, it is not Alan's profile.
    await app.actingAs(alan).expectingJson().delete(`${profile(ada)}/links/${adasLink.id}`).assertForbidden();
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
  // @ts-expect-error — `name` is required by the schema.
  useForm<UpdateUserProfileController>({ bio: '' });
  // `bio` is optional (left out it keeps the saved bio, '' clears it).
  useForm<UpdateUserProfileController>({ name: 'Ada' });
  const nameError: string | undefined = form.errors.name;
  // @ts-expect-error — the schema has no `email`, so there is no such error either.
  void form.errors.email;
  return nameError;
}

// Never called: PageProps are serialized — the controller's Date is a string in the view.
export function serializedProps(props: import('@marmeon/http').PageProps<ShowUserProfileController>) {
  const now: string = props.now;
  // @ts-expect-error — not a Date any more once it crossed the wire
  props.now.getTime();
  return now;
}

// Never called: the database's page meta and the one browser code knows describe the same shape.
export function pageMetaShapes(meta: import('@marmeon/database').PageMeta): import('@marmeon/http/page').PaginationMeta {
  expectTypeOf<import('@marmeon/database').PageMeta>().toEqualTypeOf<import('@marmeon/http/page').PaginationMeta>();
  return meta;
}
