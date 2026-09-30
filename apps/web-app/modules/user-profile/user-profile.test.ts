import { UserRepository, type User } from '#modules/auth';
import { createHttpKernel } from '@bespokecore/server';
import { describe, expect, it } from 'vitest';
import { container, router } from '../../bootstrap/app.ts';

const app = createHttpKernel(router, { container });
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
    expect(response.headers.get('location')).toBe(router.url('user-profile.show', { id: 2 }));
  });

  it('returns 404 for unknown users', async () => {
    expect((await app.request('/users/99', as('1'))).status).toBe(404);
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
    const stubbed = createHttpKernel(router, { container: container.createScope().instance(UserRepository, new StubUserRepository()) });

    const page = (await (await stubbed.request('/users/1', as('1'))).json()) as { props: { profile: { name: string } } };
    expect(page.props.profile.name).toBe('Grace (stub)');
  });
});
