import { createHttpKernel } from '@bespokecore/server';
import { describe, expect, it } from 'vitest';
import { router } from '../../bootstrap/app.ts';

const app = createHttpKernel(router);
const as = (userId: string) => ({ headers: { 'x-user-id': userId, 'x-bespoke': 'true' } });

describe('user-profile module', () => {
  it('requires authentication', async () => {
    expect((await app.request('/users/1')).status).toBe(401);
  });

  it('renders the Show page with controller-owned props', async () => {
    const response = await app.request('/users/1', as('1'));
    expect(await response.json()).toEqual({
      component: 'user-profile/Show',
      props: { profile: { id: '1', name: 'Ada Lovelace', bio: 'First programmer.' }, email: 'ada@example.com', isOwnProfile: true },
      url: '/users/1',
    });
  });

  it("hides another user's e-mail", async () => {
    const page = (await (await app.request('/users/2', as('1'))).json()) as { props: { email: string | null } };
    expect(page.props.email).toBeNull();
  });

  it('redirects /users/me to the current user', async () => {
    const response = await app.request('/users/me', as('2'));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(router.url('user-profile.show', { id: 2 }));
  });

  it('returns 404 for unknown users', async () => {
    expect((await app.request('/users/99', as('1'))).status).toBe(404);
  });
});
