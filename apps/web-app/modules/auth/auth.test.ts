import { createHttpKernel } from '@bespokecore/server';
import { describe, expect, it } from 'vitest';
import { router } from '../../bootstrap/app.ts';

const app = createHttpKernel(router);

describe('auth module', () => {
  it('logs in via form post, sets the session cookie and redirects', async () => {
    const response = await app.request('/login', { method: 'POST', body: new URLSearchParams({ user_id: '3' }) });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/users/me');

    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const me = await app.request('/users/me', { headers: { cookie } });
    expect(me.headers.get('location')).toBe('/users/3');
  });

  it('rejects unknown users', async () => {
    const response = await app.request('/login', { method: 'POST', body: new URLSearchParams({ user_id: '99' }) });
    expect(response.headers.get('location')).toBe('/login');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('clears the cookie on logout', async () => {
    const response = await app.request('/logout', { method: 'POST' });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
