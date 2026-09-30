import { UserRepository, type User } from '#modules/auth';
import { useForm } from '@bespokecore/react';
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { EditUserProfileController } from './controllers/EditUserProfileController.ts';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';
import type { UpdateUserProfileController } from './controllers/UpdateUserProfileController.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application); // a fresh app per test
});

/** Signed in as `id`, navigating client-side (answers with the page object). */
const as = (id: string) => app.withSession({ user_id: id }).navigating();

describe('user-profile module', () => {
  it('returns 401 to non-browser clients without a session', async () => {
    await app.expectingJson().get('/users/1').assertUnauthorized().assertJson({ message: 'Unauthenticated.' });
  });

  it('redirects browsers without a session to the login page', async () => {
    await app.get('/users/1', { headers: { accept: 'text/html' } }).assertRedirect('/login');
  });

  it('renders the profile with controller-owned props', async () => {
    await as('1')
      .get('/users/1')
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
    await as('1').get('/users/2').assertPage<ShowUserProfileController>('user-profile/Show', { email: null, isOwnProfile: false });
  });

  it('carries the page object in full page loads too', async () => {
    await app.withSession({ user_id: '1' }).get('/users/1').assertOk().assertPage('user-profile/Show');
  });

  it('filters the other people by name from the query string', async () => {
    await as('1')
      .get('/users/1?q=  TUR ')
      .assertPage<ShowUserProfileController>('user-profile/Show', { filter: 'TUR', others: [{ id: '2', name: 'Alan Turing' }] });
    await as('1').get('/users/1').assertPage<ShowUserProfileController>('user-profile/Show', (props) => {
      expect(props.others.map((other) => other.id)).toEqual(['2', '3']);
    });
  });

  it('serves a stateless API under /api — no session, no cookies', async () => {
    const response = await app.get('/api/users').assertOk().assertCookieMissing('bespoke_session');
    expect(response.json()).toEqual({ data: expect.arrayContaining([{ id: '1', name: 'Ada Lovelace' }]) });
  });

  it('sends security headers on every response — global middleware, even for unknown paths', async () => {
    for (const path of ['/login', '/api/users', '/nope']) {
      await app.get(path).assertHeader('x-content-type-options', 'nosniff').assertHeader('x-frame-options', 'DENY');
    }
  });

  describe('updating the profile (UpdateUserProfileRequest)', () => {
    it('saves valid, trimmed input and flashes a status', async () => {
      await app
        .withSession({ user_id: '1' })
        .put('/users/1', { json: { name: '  Ada King ', bio: 'Countess.' } })
        .assertRedirect('/users/1')
        .assertValid()
        .assertSessionHas('status', 'Profile saved.');
      expect(app.make(UserRepository).find('1')).toMatchObject({ name: 'Ada King', bio: 'Countess.' });
    });

    it('answers API clients with 422 and the field errors', async () => {
      const response = await app
        .withSession({ user_id: '1' })
        .expectingJson()
        .put('/users/1', { json: { name: 'A', bio: 'x'.repeat(201) } })
        .assertUnprocessable()
        .assertInvalid<UpdateUserProfileController>({ name: /at least 2/, bio: 'The bio may have at most 200 characters.' });
      expect(response.json()).toMatchObject({ message: 'The name needs at least 2 characters. (and 1 more error)' });
    });

    it('sends pages back with the errors and the old input in the session', async () => {
      await app
        .withSession({ user_id: '1' })
        .put('/users/1', { form: { name: 'A', bio: 'ok', _token: 'never flashed' }, headers: { referer: 'http://localhost/users/1/edit' } })
        .assertRedirect('/users/1/edit')
        .assertInvalid<UpdateUserProfileController>(['name'])
        .assertSessionHas('_old_input', { name: 'A', bio: 'ok' });
    });

    it('forbids editing someone else (403 before validation)', async () => {
      await app.withSession({ user_id: '2' }).expectingJson().put('/users/1', { json: {} }).assertForbidden();
      expect(app.make(UserRepository).find('1')!.name).toBe('Ada Lovelace');
    });
  });

  describe('the edit page', () => {
    it('shows your own profile for editing — and nobody else\'s', async () => {
      await as('1').get('/users/1/edit').assertOk().assertPage<EditUserProfileController>('user-profile/Edit', {
        profile: { name: 'Ada Lovelace' },
        errors: {},
      });
      await as('2').get('/users/1/edit').assertForbidden();
    });

    it('a failed client-side visit comes back to the form with errors and old input (no 422)', async () => {
      const response = await as('1')
        .put('/users/1', { json: { name: 'A', bio: 'ok' }, headers: { referer: 'http://localhost/users/1/edit' } })
        .assertStatus(303)
        .assertRedirect('/users/1/edit');

      await app
        .withCookie('bespoke_session', response.cookie('bespoke_session')!)
        .navigating()
        .get('/users/1/edit')
        .assertPage<EditUserProfileController>('user-profile/Edit', {
          errors: { name: ['The name needs at least 2 characters.'] },
          old: { name: 'A', bio: 'ok' },
        });
    });

    it('a successful save lands on the profile with a status message', async () => {
      const response = await as('1').put('/users/1', { json: { name: 'Ada', bio: 'Math.' } }).assertRedirect('/users/1');
      await app
        .withCookie('bespoke_session', response.cookie('bespoke_session')!)
        .navigating()
        .get('/users/1')
        .assertPage<ShowUserProfileController>('user-profile/Show', { status: 'Profile saved.', profile: { bio: 'Math.' } });
    });
  });

  it('redirects /users/me to the current user', async () => {
    await as('2').get('/users/me').assertRedirect('/users/2');
  });

  it('answers unknown users with the error page (navigation) or JSON (API)', async () => {
    await as('1').get('/users/99').assertNotFound().assertPage('errors/Error', { message: 'User not found.' });
    await app.withSession({ user_id: '1' }).expectingJson().get('/users/99').assertNotFound().assertExactJson({
      message: 'User not found.',
    });
  });

  it('lets tests replace services before the app boots — singletons included', async () => {
    const grace: User = { id: '1', name: 'Grace (stub)', email: 'grace@example.com', bio: 'from a test double' };
    class StubUserRepository extends UserRepository {
      override find(id: string) {
        return id === '1' ? grace : undefined;
      }
      override all() {
        return [grace];
      }
    }
    const stubbed = await createTestApp(application, { override: (c) => c.instance(UserRepository, new StubUserRepository()) });

    await stubbed.withSession({ user_id: '1' }).navigating().get('/users/1').assertPage('user-profile/Show', { profile: { name: 'Grace (stub)' } });
  });

  it('boots modules and discovered packages through their providers', () => {
    expect(app.application.modules.map((module) => module.name)).toEqual(['auth', 'user-profile']);
    expect(app.application.packages).toEqual(expect.arrayContaining(['@bespokecore/http', '@bespokecore/log', '@bespokecore/session']));
    expect(app.make(UserRepository)).toBe(app.make(UserRepository)); // singleton
  });

  it('shows when a user last signed in — via the UserLoggedIn event from the auth module', async () => {
    await app.post('/login', { form: { user_id: '2' } }).assertRedirect('/users/me');

    await as('1').get('/users/2').assertPage<ShowUserProfileController>('user-profile/Show', (props) => {
      expect(props.lastLoginAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
    await as('1').get('/users/3').assertPage<ShowUserProfileController>('user-profile/Show', { lastLoginAt: null });
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
