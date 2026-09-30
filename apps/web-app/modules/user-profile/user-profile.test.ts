import { UserRepository, type User } from '#modules/auth';
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';

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
