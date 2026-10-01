import { createHttpKernel } from '@bespokecore/server';
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';

/**
 * Signing out while another request of the same browser is still running — since W5 step 5 the normal case: every
 * profile page loads its deferred activity right after it is shown, so a quick "Sign out" overtakes that request.
 * The request that started before the sign-out must not bring the session back.
 */

type Kernel = ReturnType<typeof createHttpKernel>;

/** One browser's cookies against the kernel — Set-Cookie applied in the order the responses arrive. */
class Browser {
  readonly #cookies = new Map<string, string>();
  readonly #kernel: Kernel;

  constructor(kernel: Kernel) {
    this.#kernel = kernel;
  }

  async request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
    const cookie = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await this.#kernel.request(path, { method: init.method ?? 'GET', headers: { ...init.headers, ...(cookie ? { cookie } : {}) }, body: init.body });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const name = pair!.slice(0, pair!.indexOf('='));
      const value = pair!.slice(pair!.indexOf('=') + 1);
      if (/max-age=0/i.test(line) || value === '') this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    return response;
  }
}

let app: TestApp;
beforeEach(async () => {
  // The activity takes a while — long enough for the sign-out to overtake it.
  app = await createTestApp(application, { database: 'refresh', env: { PROFILE_ACTIVITY_DELAY: '150' } });
});

describe('signing out while a deferred prop is still loading', () => {
  it('the slower request does not sign the browser back in', async () => {
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const browser = new Browser(createHttpKernel(app.application));
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    expect((await browser.request('/login', { method: 'POST', headers: form, body: 'email=ada%40example.com&password=password' })).status).toBe(303);
    expect((await browser.request(`/users/${ada.id}`, { headers: { 'x-bespoke': 'true' } })).status).toBe(200);

    // The page asks for its deferred activity — and before the answer is there, the user signs out.
    const deferred = browser.request(`/users/${ada.id}`, {
      headers: { 'x-bespoke': 'true', 'x-bespoke-partial-component': 'user-profile/Show', 'x-bespoke-partial-data': 'activity' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await browser.request('/logout', { method: 'POST' })).status).toBe(303);
    await deferred;

    // Signed out — whatever the slower response did with its session.
    const after = await browser.request(`/users/${ada.id}`, { headers: { accept: 'text/html' } });
    expect(after.status, 'the profile after signing out').toBe(302);
    expect(after.headers.get('location')).toMatch(/\/login$/);
  });
});
