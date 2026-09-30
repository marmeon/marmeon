import { UserRepository, type User } from '#modules/auth';
import { Router } from '@bespokecore/router';
import { createHttpKernel } from '@bespokecore/server';
import { describe, expect, it } from 'vitest';
import { app as application } from '../../bootstrap/app.ts';

const app = createHttpKernel(application);
const as = (userId: string) => ({ headers: { 'x-user-id': userId, 'x-bespoke': 'true' } });

describe('user-profile module', () => {
  it('returns 401 to non-browser clients without a session', async () => {
    expect((await app.request('/users/1')).status).toBe(401);
  });

  it('redirects browsers without a session to the login page', async () => {
    const response = await app.request('/users/1', { headers: { accept: 'text/html' } });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login');
  });

  it('answers client-side navigations with the page object', async () => {
    const response = await app.request('/users/1', as('1'));
    expect(response.headers.get('x-bespoke')).toBe('true');
    expect(await response.json()).toEqual({
      component: 'user-profile/Show',
      props: {
        profile: { id: '1', name: 'Ada Lovelace', bio: 'First programmer.' },
        email: 'ada@example.com',
        isOwnProfile: true,
        viewer: { name: 'Ada Lovelace' },
        others: [
          { id: '2', name: 'Alan Turing' },
          { id: '3', name: 'Grace Hopper' },
        ],
      },
      url: '/users/1',
    });
  });

  it("hides another user's e-mail", async () => {
    const page = (await (await app.request('/users/2', as('1'))).json()) as { props: { email: string | null } };
    expect(page.props.email).toBeNull();
  });

  it('answers full page loads with an HTML document carrying the page', async () => {
    const response = await app.request('/users/1', { headers: { 'x-user-id': '1' } });
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('"component":"user-profile/Show"');
  });

  it('redirects /users/me to the current user', async () => {
    const response = await app.request('/users/me', as('2'));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(application.container.make(Router).url('user-profile.show', { id: 2 }));
  });

  it('answers unknown users with the error page (navigation) or JSON (API)', async () => {
    const navigation = await app.request('/users/99', as('1'));
    expect(navigation.status).toBe(404);
    expect(await navigation.json()).toMatchObject({ component: 'errors/Error', props: { message: 'User not found.' } });

    const api = await app.request('/users/99', { headers: { 'x-user-id': '1', accept: 'application/json' } });
    expect(await api.json()).toEqual({ message: 'User not found.' });
  });

  it('resolves controllers through the container, so dependencies can be swapped', async () => {
    const grace: User = { id: '1', name: 'Grace (stub)', email: 'grace@example.com', bio: 'from a test double' };
    class StubUserRepository extends UserRepository {
      override find(id: string) {
        return id === '1' ? grace : undefined;
      }
      override all() {
        return [grace];
      }
    }
    const stubbed = createHttpKernel(application, {
      container: application.container.createScope().instance(UserRepository, new StubUserRepository()),
    });

    const page = (await (await stubbed.request('/users/1', as('1'))).json()) as { props: { profile: { name: string } } };
    expect(page.props.profile.name).toBe('Grace (stub)');
  });

  it('boots modules and discovered packages through their providers', () => {
    expect(application.modules.map((module) => module.name)).toEqual(['auth', 'user-profile']);
    // The framework's own HTTP package registered itself like any installed package would.
    expect(application.packages).toEqual(expect.arrayContaining(['@bespokecore/http', '@bespokecore/log']));
    expect(application.container.make(UserRepository)).toBe(application.container.make(UserRepository)); // singleton
  });
});
