import { tempDir } from '../../../scripts/test/temp-dir.js';
import { defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider } from '@marmeon/http';
import { Session, SessionConfig, SessionServiceProvider, sessionCookieName } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

class VisitsController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    const visits = Number(this.#session.get('visits') ?? 0) + 1;
    this.#session.put('visits', visits);
    return { visits, user: this.#session.get('user') ?? null };
  }
}

class SignInController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    this.#session.regenerate();
    this.#session.put('user', 'ada');
    return { ok: true };
  }
}

class SignOutController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    this.#session.invalidate();
    return { ok: true };
  }
}

const routes = openRoutes((Route) => {
  Route.get('/visits', VisitsController);
  Route.post('/sign-in', SignInController);
  Route.post('/sign-out', SignOutController);
  // Sends the Set-Cookie headers named by ?c=… as they are written, and answers with the Cookie header it received.
  Route.get('/set', (ctx) => {
    const headers = new Headers();
    for (const header of new URL(ctx.request.url).searchParams.getAll('c')) headers.append('set-cookie', header);
    return new Response(ctx.request.headers.get('cookie') ?? '', { headers });
  });
  Route.get('/admin/set', (ctx) => {
    const headers = new Headers();
    for (const header of new URL(ctx.request.url).searchParams.getAll('c')) headers.append('set-cookie', header);
    return new Response(ctx.request.headers.get('cookie') ?? '', { headers });
  });
  Route.get('/echo', (ctx) => new Response(ctx.request.headers.get('cookie') ?? ''));
  Route.get('/admin/echo', (ctx) => new Response(ctx.request.headers.get('cookie') ?? ''));
});

async function boot(): Promise<TestApp> {
  return createTestApp(
    {
      root: tempDir('marmeon-testing-'),
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider],
      modules: [defineModule({ name: 'visits', routes })],
    },
    { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory' } },
  );
}

const set = (...headers: string[]) => `/set?${headers.map((header) => `c=${encodeURIComponent(header)}`).join('&')}`;
const adminSet = (...headers: string[]) => `/admin/set?${headers.map((header) => `c=${encodeURIComponent(header)}`).join('&')}`;
const sent = async (app: TestApp, path: string) => (await app.get(path).assertOk()).body;

describe('keepingCookies()', () => {
  it('carries a guest session over four requests without a cookie by hand', async () => {
    const app = await boot();
    const browser = app.keepingCookies();
    await browser.get('/visits').assertOk().assertJson({ visits: 1, user: null });
    await browser.get('/visits').assertJson({ visits: 2, user: null });
    await browser.get('/visits').assertJson({ visits: 3, user: null });
    await browser.get('/visits').assertJson({ visits: 4, user: null });
    // A view that keeps nothing starts a new session every time.
    await app.get('/visits').assertJson({ visits: 1, user: null });
    await app.get('/visits').assertJson({ visits: 1, user: null });
  });

  it('follows a sign-in that regenerates the session id and a sign-out back to a guest', async () => {
    const app = await boot();
    const name = sessionCookieName(app.make(SessionConfig));
    const browser = app.keepingCookies();
    const first = await browser.get('/visits').assertOk();
    await browser.get('/visits').assertJson({ visits: 2, user: null });
    const login = await browser.post('/sign-in').assertOk();
    expect(login.cookie(name)).toBeDefined();
    expect(login.cookie(name)).not.toBe(first.cookie(name));
    await browser.get('/visits').assertJson({ visits: 3, user: 'ada' });
    await browser.post('/sign-out').assertOk();
    await browser.get('/visits').assertJson({ visits: 1, user: null });
  });

  it('shares its cookies with the views made from it', async () => {
    const app = await boot();
    const browser = app.keepingCookies();
    await browser.get('/visits').assertJson({ visits: 1, user: null });
    await browser.withHeaders({ 'x-a': '1' }).get('/visits').assertJson({ visits: 2, user: null });
    await browser.navigating().get('/visits').assertOk();
    await browser.expectingJson().get('/visits').assertJson({ visits: 4, user: null });
    // Asking again for a view that keeps cookies is the same browser, not a new one.
    await browser.keepingCookies().get('/visits').assertJson({ visits: 5, user: null });
  });

  it('keeps one browser per call on the app', async () => {
    const app = await boot();
    const one = app.keepingCookies();
    const two = app.keepingCookies();
    await one.get('/visits').assertJson({ visits: 1, user: null });
    await one.get('/visits').assertJson({ visits: 2, user: null });
    await two.get('/visits').assertJson({ visits: 1, user: null });
  });

  it('starts the session of withSession() once, then goes on with what the requests wrote', async () => {
    const app = await boot();
    const browser = app.withSession({ user: 'grace' }).keepingCookies();
    await browser.get('/visits').assertJson({ visits: 1, user: 'grace' });
    await browser.get('/visits').assertJson({ visits: 2, user: 'grace' });
    // Without the jar the session is written afresh before each request.
    const plain = app.withSession({ user: 'grace' });
    await plain.get('/visits').assertJson({ visits: 1, user: 'grace' });
    await plain.get('/visits').assertJson({ visits: 1, user: 'grace' });
  });

  it('gives every jar made from one withSession() view a session of its own', async () => {
    const app = await boot();
    const view = app.withSession({ user: 'grace' });
    const one = view.keepingCookies();
    const two = view.keepingCookies();
    await one.get('/visits').assertJson({ visits: 1, user: 'grace' });
    await one.get('/visits').assertJson({ visits: 2, user: 'grace' });
    await two.get('/visits').assertJson({ visits: 1, user: 'grace' });
    await one.get('/visits').assertJson({ visits: 3, user: 'grace' });
  });

  it('writes the session again when the view is made a second time', async () => {
    const app = await boot();
    const browser = app.keepingCookies();
    await browser.withSession({ user: 'grace' }).get('/visits').assertJson({ visits: 1, user: 'grace' });
    await browser.withSession({ user: 'ada' }).get('/visits').assertJson({ visits: 1, user: 'ada' });
  });

  it('lets the jar win over a cookie from withCookie() once the app has set one of that name', async () => {
    const app = await boot();
    const browser = app.withCookie('theme', 'light').keepingCookies();
    expect(await sent(browser, '/echo')).toContain('theme=');
    const before = await sent(browser, set('theme=dark; Path=/'));
    expect(before).toContain('theme=');
    const after = await sent(browser, '/echo');
    expect(after).toBe('theme=dark');
  });

  describe('as a browser keeps cookies', () => {
    it('sends a cookie only to the paths it belongs to', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      await sent(browser, set('area=admin; Path=/admin', 'all=1; Path=/'));
      expect(await sent(browser, '/echo')).toBe('all=1');
      expect(await sent(browser, '/admin/echo')).toBe('area=admin; all=1');
      await sent(browser, set('x=1; Path=/echo'));
      expect(await sent(browser, '/echo')).toBe('x=1; all=1');
    });

    it('takes the directory of the request as the path of a cookie that names none', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      await sent(browser, adminSet('here=1'));
      expect(await sent(browser, '/admin/echo')).toBe('here=1');
      expect(await sent(browser, '/echo')).toBe('');
    });

    it('does not take a path that is no path', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      await sent(browser, adminSet('odd=1; Path=admin'));
      expect(await sent(browser, '/admin/echo')).toBe('odd=1');
      expect(await sent(browser, '/echo')).toBe('');
    });

    it('deletes a cookie with Max-Age=0, and only the one of that path', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      await sent(browser, set('a=1; Path=/', 'b=2; Path=/admin'));
      expect(await sent(browser, '/admin/echo')).toBe('b=2; a=1');
      await sent(browser, set('b=; Path=/; Max-Age=0'));
      expect(await sent(browser, '/admin/echo')).toBe('b=2; a=1');
      await sent(browser, set('a=; Path=/; Max-Age=0', 'b=; Path=/admin; Max-Age=0'));
      expect(await sent(browser, '/admin/echo')).toBe('');
    });

    it('deletes a cookie with an Expires in the past', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      await sent(browser, set('a=1; Path=/'));
      await sent(browser, set('a=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'));
      expect(await sent(browser, '/echo')).toBe('');
    });

    it('lets a cookie age by the app clock: gone after Max-Age and after Expires', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      const expires = new Date(app.clock.now() + 3_600_000).toUTCString();
      await sent(browser, set('short=1; Path=/; Max-Age=60', 'dated=1; Path=/; Expires=' + expires, 'forever=1; Path=/'));
      expect(await sent(browser, '/echo')).toBe('short=1; dated=1; forever=1');
      app.travel({ seconds: 59 });
      expect(await sent(browser, '/echo')).toBe('short=1; dated=1; forever=1');
      app.travel({ seconds: 2 });
      expect(await sent(browser, '/echo')).toBe('dated=1; forever=1');
      app.travel({ hours: 2 });
      expect(await sent(browser, '/echo')).toBe('forever=1');
    });

    it('ignores a Max-Age that is no number and keeps an earlier one', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      await sent(browser, set('a=1; Path=/; Max-Age=60; Max-Age=abc'));
      expect(await sent(browser, '/echo')).toBe('a=1');
      app.travel({ seconds: 61 });
      expect(await sent(browser, '/echo')).toBe('');
    });

    it('ignores an Expires that is no cookie date, as a browser does', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      // `Date.parse('1')` is a year in the past: the cookie would be deleted, though a browser ignores the attribute.
      await sent(browser, set('a=1; Path=/; Expires=1', 'b=1; Path=/; Expires=Jan 1 2000', 'c=1; Path=/; Expires=nonsense'));
      expect(await sent(browser, '/echo')).toBe('a=1; b=1; c=1');
    });

    it('prefers Max-Age to Expires', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      await sent(browser, set('a=1; Path=/; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT'));
      expect(await sent(browser, '/echo')).toBe('a=1');
    });

    it('sends a Secure cookie only over https or to a loopback host, and takes none from another http answer', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      await sent(browser, 'http://example.test' + set('http-secure=1; Path=/; Secure', 'plain=1; Path=/'));
      await sent(browser, 'https://example.test' + set('safe=1; Path=/; Secure'));
      expect(await sent(browser, 'https://example.test/echo')).toBe('plain=1; safe=1');
      expect(await sent(browser, 'http://example.test/echo')).toBe('plain=1');
    });

    it('treats localhost, *.localhost, 127.0.0.1 and [::1] as secure origins over http', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      for (const origin of ['http://localhost', 'http://app.localhost', 'http://127.0.0.1', 'http://[::1]']) {
        await sent(browser, origin + set('__Host-s=1; Path=/; Secure', '__Secure-t=1; Path=/; Secure'));
        expect(await sent(browser, origin + '/echo')).toBe('__Host-s=1; __Secure-t=1');
      }
      expect(await sent(browser, 'http://example.test/echo')).toBe('');
    });

    it('refuses a __Host- cookie that is not Secure, has a Domain or has another path', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      const url = (path: string) => `https://localhost${path}`;
      await sent(browser, url(set('__Host-a=1; Path=/', '__Host-b=1; Path=/admin; Secure', '__Host-c=1; Path=/; Secure; Domain=localhost', '__Secure-d=1; Path=/', '__Host-e=1; Secure', '__Host-ok=1; Path=/; Secure')));
      expect(await sent(browser, url('/echo'))).toBe('__Host-ok=1');
      expect(await sent(browser, url('/admin/echo'))).toBe('__Host-ok=1');
    });

    it('keeps cookies apart by host, and a Domain reaches its subdomains only', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      await sent(browser, 'http://one.example.test' + set('only=1; Path=/', 'wide=1; Path=/; Domain=example.test'));
      expect(await sent(browser, 'http://one.example.test/echo')).toBe('only=1; wide=1');
      expect(await sent(browser, 'http://two.example.test/echo')).toBe('wide=1');
      expect(await sent(browser, 'http://example.test/echo')).toBe('wide=1');
      expect(await sent(browser, 'http://other.test/echo')).toBe('');
      expect(await sent(browser, 'http://localhost/echo')).toBe('');
      // The same name on another host is another cookie.
      await sent(browser, 'http://other.test' + set('only=2; Path=/'));
      expect(await sent(browser, 'http://one.example.test/echo')).toBe('only=1; wide=1');
      expect(await sent(browser, 'http://other.test/echo')).toBe('only=2');
    });

    it('refuses a Domain the host is not part of, and a Domain without a dot', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      await sent(browser, 'http://one.example.test' + set('a=1; Path=/; Domain=other.test', 'b=1; Path=/; Domain=test', 'c=1; Path=/; Domain=one.example.test'));
      expect(await sent(browser, 'http://one.example.test/echo')).toBe('c=1');
      expect(await sent(browser, 'http://other.test/echo')).toBe('');
    });

    it('takes no Domain from an IP address host, though its text ends the same way', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      await sent(browser, 'http://127.0.0.1' + set('a=1; Path=/; Domain=0.0.1', 'b=1; Path=/; Domain=127.0.0.1'));
      expect(await sent(browser, 'http://127.0.0.1/echo')).toBe('b=1');
    });

    it('keeps the place of a cookie in the order when it is replaced', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      await sent(browser, set('a=1; Path=/', 'b=1; Path=/'));
      await sent(browser, set('a=2; Path=/'));
      expect(await sent(browser, '/echo')).toBe('a=2; b=1');
    });

    it('does not send a host-only cookie to a subdomain', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      await sent(browser, 'http://example.test' + set('a=1; Path=/'));
      expect(await sent(browser, 'http://sub.example.test/echo')).toBe('');
    });

    it('sends the cookie back as the server wrote it, and ignores a header without a name', async () => {
      const app = await boot();
      const browser = app.keepingCookies();
      await sent(browser, set('a=b%20c%3D; Path=/', '=orphan', 'novalue'));
      expect(await sent(browser, '/echo')).toBe('a=b%20c%3D');
    });
  });

  it('leaves a view without keepingCookies() as it was', async () => {
    const app = await boot();
    await sent(app, set('a=1; Path=/'));
    expect(await sent(app, '/echo')).toBe('');
    expect(await sent(app.withCookie('theme', 'dark'), '/echo')).toContain('theme=');
  });

  it('takes the cookies of a stream() too', async () => {
    const app = await boot();
    const browser = app.keepingCookies();
    await browser.stream(set('a=1; Path=/'));
    expect(await sent(browser, '/echo')).toBe('a=1');
  });
});
