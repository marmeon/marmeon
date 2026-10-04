import { createTestApp, type TestApp } from '@bespokecore/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '../auth/factories/UserFactory.ts';

/**
 * The request path (W8 step 9, E154): a response is copied at most once per request — the framework's own responses (pages,
 * documents, redirects) are changed in place by every middleware that adds a header (cookies, the language, the security headers,
 * the CSP, `no-store`, the request id). Before: four or five copies per page, ≈ 2.5 µs each.
 */

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

const referer = { referer: 'http://localhost/login' };

/** How many responses were copied from another (`new Response(body, response)`) while `run` ran. */
async function copies(run: () => PromiseLike<unknown>): Promise<number> {
  const Original = globalThis.Response;
  let count = 0;
  // A proxy, not a subclass: `instanceof Response` stays true for responses made before.
  globalThis.Response = new Proxy(Original, {
    construct(target, args: ConstructorParameters<typeof Response>, newTarget) {
      if (args[1] instanceof Original) count++;
      return Reflect.construct(target, args, newTarget) as object;
    },
  });
  try {
    await run();
  } finally {
    globalThis.Response = Original;
  }
  return count;
}

describe('response copies per request (W8 step 9)', () => {
  it('none for a page with a session — a visit and a document, with cookies, language, security headers and the CSP', async () => {
    const failed = await app.post('/login', { form: { email: 'nobody@example.com', password: 'wrong' }, headers: referer });
    const guest = app.withCookie('bespoke_session', failed.cookie('bespoke_session')!);
    expect(await copies(() => guest.navigating().get('/login').assertOk())).toBe(0);
    let document: Awaited<ReturnType<TestApp['get']>> | undefined;
    expect(await copies(async () => (document = await guest.get('/login', { headers: { accept: 'text/html' } }).assertOk()))).toBe(0);
    for (const header of ['content-security-policy', 'x-frame-options', 'content-language', 'x-request-id']) expect(document!.headers.get(header)).toBeTruthy();
    expect(document!.headers.getSetCookie().length).toBeGreaterThan(0);
  });

  it('none for a signed-in page (no-store) and for the redirects of signing in and out', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    let login: Awaited<ReturnType<TestApp['post']>> | undefined;
    expect(await copies(async () => (login = await app.post('/login', { form: { email: 'ada@example.com', password: 'password' }, headers: referer }).assertRedirect()))).toBe(0);
    const ada = app.withCookie('bespoke_session', login!.cookie('bespoke_session')!);
    let people: Awaited<ReturnType<TestApp['get']>> | undefined;
    expect(await copies(async () => (people = await ada.navigating().get('/people').assertOk()))).toBe(0);
    expect(people!.headers.get('cache-control')).toContain('no-store');
    expect(await copies(() => ada.post('/logout', { headers: { referer: 'http://localhost/people' } }).assertRedirect())).toBe(0);
  });
});
